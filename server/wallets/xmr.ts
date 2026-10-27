import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { readJson, writeJsonAtomic } from '../store.js';

/**
 * The VPS's monero-wallet-rpc. Wallet Click keeps to its own account in that wallet ("wallet-click", never
 * account 0, whose primary address is published elsewhere) and to subaddresses it created itself:
 *  - one per permanent Monero address;
 *  - per Privacy Enhanced transfer, a "vault" subaddress FixedFloat pays the XMR to, and a "churn" one it
 *    moves to while waiting;
 *  - per piece of a split payment, a subaddress of its own (and a churn one).
 * Every spend is a sweep_all (or, for a split, one transfer that empties the subaddress) scoped to one of those
 * subaddresses, built with do_not_relay so the signed transaction can be saved before it is relayed (and relayed
 * again after a crash, never rebuilt).
 * Amounts are atomic units (1 XMR = 1e12) as bigint.
 */

/** monero-wallet-rpc can't be reached right now: try again later. */
export class XmrUnavailable extends Error {}
/** monero-wallet-rpc answered with an error. */
export class XmrError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export const XMR_DECIMALS = 12;
/** Monero locks received outputs for 10 blocks (~20 minutes). */
export const XMR_LOCK_BLOCKS = 10;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let fetchFn: Fetch = (url, init) => fetch(url, init);
/** Tests swap in a fake wallet. */
export function setXmrFetch(f: Fetch | null): void {
  fetchFn = f ?? ((url, init) => fetch(url, init));
  state = null;
}

export const xmrConfigured = () => Boolean(config.monero.rpcUrl);

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

/** HTTP digest auth (monero-wallet-rpc --rpc-login). */
function digestHeader(challenge: string, method: string, uri: string): string {
  const p: Record<string, string> = {};
  for (const m of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) p[m[1]] = m[2] ?? m[3];
  const user = config.monero.user ?? '';
  const ha1 = md5(`${user}:${p.realm}:${config.monero.password ?? ''}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = (p.qop ?? '').split(',').map((s) => s.trim()).includes('auth') ? 'auth' : null;
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  return [
    `Digest username="${user}"`,
    `realm="${p.realm}"`,
    `nonce="${p.nonce}"`,
    `uri="${uri}"`,
    'algorithm=MD5',
    `response="${response}"`,
    ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
    ...(p.opaque ? [`opaque="${p.opaque}"`] : []),
  ].join(', ');
}

async function post(body: string): Promise<Response> {
  const url = config.monero.rpcUrl;
  if (!url) throw new XmrUnavailable('The Monero wallet is not set up (MONERO_RPC_URL).');
  const init = (auth?: string): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  try {
    const res = await fetchFn(url, init());
    if (res.status !== 401 || !config.monero.user) return res;
    const challenge = res.headers.get('www-authenticate') ?? '';
    return await fetchFn(url, init(digestHeader(challenge, 'POST', new URL(url).pathname)));
  } catch (e) {
    throw new XmrUnavailable(`Couldn't reach the Monero wallet (${(e as Error).message}).`);
  }
}

/** JSON.parse loses precision above 2^53; Monero amounts can be bigger, so long integers are read as strings. */
const parseExact = (text: string) => JSON.parse(text.replace(/([:[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));

/** Amounts go out as exact JSON integers (JSON.stringify refuses bigint, and Number would round). */
const stringifyExact = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `#big:${x}` : x)).replace(/"#big:(-?\d+)"/g, '$1');

async function call<T>(method: string, params: object = {}): Promise<T> {
  const res = await post(stringifyExact({ jsonrpc: '2.0', id: '0', method, params }));
  if (res.status === 401) throw new XmrError(401, 'The Monero wallet refused the login (MONERO_RPC_USER / MONERO_RPC_PASSWORD).');
  if (!res.ok) throw new XmrUnavailable(`The Monero wallet answered HTTP ${res.status}.`);
  const json = parseExact(await res.text()) as { result?: T; error?: { code: number; message: string } };
  if (json.error) throw new XmrError(json.error.code, `Monero wallet: ${json.error.message}`);
  return json.result as T;
}

const big = (v: unknown) => BigInt(String(v ?? 0));

// ---------------------------------------------------------------- our account

interface XmrState {
  version: 1;
  /** Our account in the wallet: created once, never 0. */
  account: number | null;
  /** The Wallet window's own account ("wallet-click-stash"): held coins never mix with transfers. Never 0. */
  stash?: number | null;
}

/** Which of our accounts: the transfers' one, or the Wallet window's. */
export type XmrAccount = 'main' | 'stash';
let state: XmrState | null = null;
const stateFile = () => path.join(config.dataDir, 'monero.json');

async function account(which: XmrAccount = 'main'): Promise<number> {
  state ??= readJson<XmrState>(stateFile()) ?? { version: 1, account: null };
  const known = which === 'main' ? state.account : state.stash;
  if (known) return known;
  const label = which === 'main' ? config.monero.accountLabel : `${config.monero.accountLabel}-stash`;
  const { subaddress_accounts: accounts } = await call<{ subaddress_accounts: { account_index: number; label: string }[] }>('get_accounts');
  let index = accounts.find((a) => a.account_index > 0 && a.label === label)?.account_index;
  index ??= (await call<{ account_index: number }>('create_account', { label })).account_index;
  if (!(Number.isInteger(index) && index > 0)) throw new XmrError(-1, 'Refusing to use Monero account 0.');
  if (which === 'stash' && index === state.account) throw new XmrError(-1, "The Wallet window must not share the transfers' Monero account.");
  if (which === 'main') state.account = index;
  else state.stash = index;
  writeJsonAtomic(stateFile(), state);
  return index;
}

// ---------------------------------------------------------------- reading

/** A fresh subaddress in our account. */
export async function newSubaddress(label: string, which: XmrAccount = 'main'): Promise<{ index: number; address: string }> {
  const r = await call<{ address: string; address_index: number }>('create_address', { account_index: await account(which), label });
  if (!(r.address_index > 0)) throw new XmrError(-1, 'The Monero wallet returned an unexpected subaddress.');
  return { index: r.address_index, address: r.address };
}

export interface XmrIncoming {
  txid: string;
  amount: bigint;
  confirmations: number;
  /** Still in the mempool. */
  pool: boolean;
}

/** Everything that has arrived at one of our subaddresses (confirmed or in the mempool). */
export async function incoming(index: number, which: XmrAccount = 'main'): Promise<XmrIncoming[]> {
  type T = { txid: string; amount: unknown; confirmations?: number; subaddr_index?: { minor: number }; double_spend_seen?: boolean };
  const r = await call<{ in?: T[]; pool?: T[] }>('get_transfers', { in: true, pool: true, account_index: await account(which), subaddr_indices: [index] });
  const rows = [...(r.in ?? []).map((t) => ({ t, pool: false })), ...(r.pool ?? []).map((t) => ({ t, pool: true }))];
  return rows
    .filter(({ t }) => (t.subaddr_index?.minor ?? index) === index && !t.double_spend_seen)
    .map(({ t, pool }) => ({ txid: t.txid, amount: big(t.amount), confirmations: pool ? 0 : (t.confirmations ?? 0), pool }));
}

/** What a subaddress holds now: everything, and the part that can be spent already. */
export async function balance(index: number, which: XmrAccount = 'main'): Promise<{ total: bigint; unlocked: bigint; blocksToUnlock: number }> {
  type B = { address_index: number; balance: unknown; unlocked_balance: unknown; blocks_to_unlock?: number };
  const r = await call<{ per_subaddress?: B[] }>('get_balance', { account_index: await account(which), address_indices: [index] });
  const row = (r.per_subaddress ?? []).find((b) => b.address_index === index);
  return { total: big(row?.balance), unlocked: big(row?.unlocked_balance), blocksToUnlock: row?.blocks_to_unlock ?? 0 };
}

/** Asks the wallet to catch up with the chain (it also does so on its own, more slowly). */
export async function refresh(): Promise<void> {
  await call('refresh', {});
}

// ---------------------------------------------------------------- spending

export interface XmrSweep {
  txids: string[];
  /** What arrives at `to`, and the network fee. */
  amount: bigint;
  fee: bigint;
  /** Signed, not yet relayed. Secret: never leaves the server. */
  metadata: string[];
}

/**
 * Signs (does not relay) a transaction moving everything unlocked at one of our subaddresses to `to`.
 * Callers pass only a verified FixedFloat deposit address or another subaddress of ours.
 */
export async function prepareSweep(index: number, to: string, which: XmrAccount = 'main'): Promise<XmrSweep> {
  type R = { tx_hash_list?: string[]; amount_list?: unknown[]; fee_list?: unknown[]; tx_metadata_list?: string[] };
  const r = await call<R>('sweep_all', {
    address: to,
    account_index: await account(which),
    subaddr_indices: [index],
    do_not_relay: true,
    get_tx_metadata: true,
    priority: 0,
  });
  const metadata = r.tx_metadata_list ?? [];
  const txids = r.tx_hash_list ?? [];
  if (!metadata.length || metadata.length !== txids.length) throw new XmrError(-1, 'The Monero wallet did not return a signed transaction.');
  const sum = (l?: unknown[]) => (l ?? []).reduce<bigint>((s, v) => s + big(v), 0n);
  return { txids, amount: sum(r.amount_list), fee: sum(r.fee_list), metadata };
}

/**
 * Signs (does not relay) one transaction splitting everything at one of our subaddresses into several of our own
 * subaddresses. The amounts must add up to exactly what's there and unlocked; the fee comes out of the pieces, so no
 * change is left at the account's main address. Needs monero-wallet-rpc 0.18.3.1 or newer: an older one can't take
 * the fee out of the outputs, and this refuses rather than sign anything else.
 */
export async function prepareSplit(index: number, outs: { address: string; amount: bigint }[]): Promise<XmrSweep & { amounts: bigint[] }> {
  const want = outs.reduce((s, o) => s + o.amount, 0n);
  const b = await balance(index);
  if (outs.length < 2 || b.unlocked !== b.total || want !== b.unlocked) throw new XmrError(-1, 'Refusing to split: the pieces must add up to exactly what is unlocked there.');
  type R = { tx_hash?: string; tx_metadata?: string; fee?: unknown; amounts_by_dest?: { amounts?: unknown[] } };
  const r = await call<R>('transfer', {
    destinations: outs.map((o) => ({ amount: o.amount, address: o.address })),
    account_index: await account(),
    subaddr_indices: [index],
    subtract_fee_from_outputs: outs.map((_, i) => i),
    do_not_relay: true,
    get_tx_metadata: true,
    priority: 0,
  });
  const amounts = (r.amounts_by_dest?.amounts ?? []).map(big);
  const fee = big(r.fee);
  if (!r.tx_hash || !r.tx_metadata) throw new XmrError(-1, 'The Monero wallet did not return a signed transaction.');
  if (amounts.length !== outs.length || amounts.some((a) => a <= 0n) || amounts.reduce((s, a) => s + a, 0n) + fee !== want) {
    throw new XmrError(-1, 'The Monero wallet did not take the fee out of the pieces (monero-wallet-rpc 0.18.3.1 or newer is needed). Nothing was sent.');
  }
  return { txids: [r.tx_hash], metadata: [r.tx_metadata], amount: want - fee, fee, amounts };
}

/** Relays a transaction signed by prepareSweep or prepareSplit. */
export async function relay(metadata: string): Promise<string> {
  return (await call<{ tx_hash: string }>('relay_tx', { hex: metadata })).tx_hash;
}

/** Whether one of our outgoing transactions reached the network (pending or confirmed), and how deep. */
export async function sent(txid: string, which: XmrAccount = 'main'): Promise<{ confirmations: number; failed: boolean } | null> {
  try {
    const r = await call<{ transfer?: { type: string; confirmations?: number } }>('get_transfer_by_txid', { txid, account_index: await account(which) });
    if (!r.transfer) return null;
    return { confirmations: r.transfer.confirmations ?? 0, failed: r.transfer.type === 'failed' };
  } catch (e) {
    if (e instanceof XmrError && /not found|no such/i.test(e.message)) return null;
    throw e;
  }
}

export const formatXmr = (v: bigint) => {
  const s = (v < 0n ? -v : v).toString().padStart(XMR_DECIMALS + 1, '0');
  const frac = s.slice(-XMR_DECIMALS).replace(/0+$/, '');
  return `${v < 0n ? '-' : ''}${s.slice(0, -XMR_DECIMALS)}${frac ? `.${frac}` : ''}`;
};
