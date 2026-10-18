import * as btc from '@scure/btc-signer';
import { ChainUnavailable, chainFetch } from '../chain.js';
import { config } from '../config.js';
import type { HotWallet, Prepared, RouteRef, Scan } from './index.js';
import { keyAt } from './seed.js';

/**
 * Bitcoin hot wallet: native segwit (BIP84, m/84'/0'/0'/0/i) addresses from the seed. Chain data and broadcasting
 * go through the Esplora APIs already configured (mempool.space, blockstream.info). Every forward spends exactly
 * the coins that were quoted, pays exactly the FixedFloat order amount to one output (no change), and signals RBF.
 */

const DUST = 546n;
/** Fee estimate assumes the largest common output type (taproot / P2WSH, 43 vbytes). */
const vsize = (inputs: number) => 11 + 68 * inputs + 43;
/** A split pays our own native segwit (P2WPKH, 31 vbytes) outputs. */
const splitVsize = (inputs: number, outputs: number) => 11 + 68 * inputs + 31 * outputs;

/** Chain 0: permanent addresses. Chain 1 (BIP84's change chain): the pieces of a split, so any BIP84 wallet finds them. */
export const btcPath = (index: number, chain: 0 | 1 = 0) => `m/84'/0'/0'/${chain}/${index}`;
export const btcAddress = (index: number, chain: 0 | 1 = 0) => btc.p2wpkh(keyAt(btcPath(index, chain)).publicKey!).address!;

interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

const timeout = () => AbortSignal.timeout(15_000);

/** First Esplora API that answers. */
async function esplora<T>(pathname: string, init?: RequestInit, as: 'json' | 'text' = 'json'): Promise<T> {
  let last: unknown;
  for (const base of config.chains.btcApis) {
    try {
      const res = await chainFetch(`${base}${pathname}`, { ...init, signal: timeout() });
      if ((res.status === 404 || res.status === 400) && !init) return null as T; // unknown tx/address
      if (!res.ok) throw new ChainUnavailable(`${new URL(base).host} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return (as === 'json' ? await res.json() : await res.text()) as T;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof ChainUnavailable ? last : new ChainUnavailable(String((last as Error)?.message ?? 'No Bitcoin API answered'));
}

const outpoint = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;

async function utxos(address: string, exclude?: Set<string>): Promise<Utxo[]> {
  const list = (await esplora<Utxo[]>(`/address/${address}/utxo`)) ?? [];
  return list.filter((u) => !exclude?.has(outpoint(u)));
}

async function tipHeight(): Promise<number> {
  return Number(await esplora<string>('/blocks/tip/height', undefined, 'text'));
}

/** sat/vB for confirmation within about half an hour. */
async function feeRate(): Promise<number> {
  try {
    const f = await esplora<{ halfHourFee?: number; fastestFee?: number }>('/v1/fees/recommended');
    if (f?.halfHourFee) return Math.max(2, Math.ceil(f.halfHourFee));
  } catch {
    /* mempool.space only: fall back to Esplora's estimates */
  }
  const est = await esplora<Record<string, number>>('/fee-estimates');
  return Math.max(2, Math.ceil(est?.['3'] ?? est?.['6'] ?? 10));
}

/** A transaction spending exactly these coins of ours from `r` (outputs still to add). */
function spending(r: RouteRef, inputs: Utxo[]) {
  const key = keyAt(btcPath(r.index, r.chain ?? 0));
  const own = btc.p2wpkh(key.publicKey!);
  if (own.address !== r.address) throw new Error('The permanent address does not match the wallet key.');
  const tx = new btc.Transaction();
  for (const u of inputs) {
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: own.script, amount: BigInt(u.value) }, sequence: 0xfffffffd });
  }
  return { key, tx };
}

export const btcWallet: HotWallet = {
  coin: 'BTC',
  decimals: 8,

  async scan(r: RouteRef, exclude) {
    const list = await utxos(r.address, exclude);
    const sum = (l: Utxo[]) => l.reduce((s, u) => s + BigInt(u.value), 0n);
    const confirmed = list.filter((u) => u.status.confirmed);
    const tip = list.some((u) => u.status.confirmed) ? await tipHeight().catch(() => 0) : 0;
    const confs = list.map((u) => (u.status.confirmed && u.status.block_height && tip ? tip - u.status.block_height + 1 : u.status.confirmed ? 1 : 0));
    return {
      seen: sum(list),
      spendable: sum(confirmed),
      txids: [...new Set(list.map((u) => u.txid))],
      confirmations: confs.length ? Math.min(...confs) : 0,
      required: 1,
      busy: false,
    } satisfies Scan;
  },

  async quote(r, exclude) {
    const list = (await utxos(r.address, exclude)).filter((u) => u.status.confirmed);
    if (!list.length) return null;
    const total = list.reduce((s, u) => s + BigInt(u.value), 0n);
    const fee = BigInt(Math.ceil(vsize(list.length) * (await feeRate())));
    const amount = total - fee;
    if (amount < DUST) return null;
    return { amount, fee, inputs: list.map(outpoint) };
  },

  async prepare(r, to, amount, opts) {
    const want = opts?.inputs;
    if (!want?.length) throw new Error('No inputs were chosen for this Bitcoin send.');
    const unspent = new Map((await utxos(r.address)).map((u) => [outpoint(u), u]));
    const inputs = want.map((o) => unspent.get(o));
    if (inputs.some((u) => !u)) throw new Error('Some of the quoted coins are no longer unspent; quoting again.');
    const total = inputs.reduce((s, u) => s + BigInt(u!.value), 0n);
    const fee = total - amount;
    // The fee is whatever the quoted coins hold beyond the order amount: never negative, never absurd.
    if (fee <= 0n || fee > total / 5n || fee > 500_000n) throw new Error(`Refusing a Bitcoin fee of ${fee} sats for ${amount} sats.`);

    const { key, tx } = spending(r, inputs as Utxo[]);
    tx.addOutputAddress(to, amount, btc.NETWORK);
    tx.sign(key.privateKey!);
    tx.finalize();
    return { txids: [tx.id], raw: [tx.hex], amount, fee, inputs: want } satisfies Prepared;
  },

  async quoteSplit(r, n, exclude) {
    const list = (await utxos(r.address, exclude)).filter((u) => u.status.confirmed);
    if (!list.length) return null;
    const total = list.reduce((s, u) => s + BigInt(u.value), 0n);
    const fee = BigInt(Math.ceil(splitVsize(list.length, n) * (await feeRate())));
    if (total - fee < DUST * BigInt(n)) return null;
    return { amount: total - fee, fee, inputs: list.map(outpoint) };
  },

  async prepareSplit(r, outs, opts) {
    const want = opts.inputs;
    if (!want.length || !outs.length) throw new Error('Nothing to split.');
    const unspent = new Map((await utxos(r.address)).map((u) => [outpoint(u), u]));
    const inputs = want.map((o) => unspent.get(o));
    if (inputs.some((u) => !u)) throw new Error('Some of the quoted coins are no longer unspent; quoting again.');
    const total = inputs.reduce((s, u) => s + BigInt(u!.value), 0n);
    const sum = outs.reduce((s, o) => s + o.amount, 0n);
    const fee = total - sum;
    if (fee <= 0n || fee > total / 5n || fee > 500_000n) throw new Error(`Refusing a Bitcoin fee of ${fee} sats for a split of ${sum} sats.`);
    const { key, tx } = spending(r, inputs as Utxo[]);
    for (const o of outs) {
      if (o.amount < DUST) throw new Error('A piece would be dust.');
      // Every output is an address of ours, derived right here from the seed.
      const mine = btc.p2wpkh(keyAt(btcPath(o.ref.index, o.ref.chain ?? 0)).publicKey!);
      if (mine.address !== o.ref.address) throw new Error('A piece address does not match the wallet key.');
      tx.addOutput({ script: mine.script, amount: o.amount });
    }
    tx.sign(key.privateKey!);
    tx.finalize();
    return { txids: [tx.id], raw: [tx.hex], amount: sum, fee, inputs: want } satisfies Prepared;
  },

  async broadcast(raw) {
    await esplora<string>('/tx', { method: 'POST', body: raw, headers: { 'content-type': 'text/plain' } }, 'text');
  },

  async status(txid) {
    const s = await esplora<{ confirmed: boolean; block_height?: number } | null>(`/tx/${txid}/status`);
    if (!s) return null;
    if (!s.confirmed || !s.block_height) return { confirmations: 0 };
    return { confirmations: (await tipHeight()) - s.block_height + 1 };
  },
};
