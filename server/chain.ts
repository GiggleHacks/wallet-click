import { config, type Coin } from './config.js';

/**
 * Direct blockchain lookups (public Ethereum RPCs, Esplora APIs for Bitcoin). Never used to move money:
 *  - depositSeen: what an address has received, so a payment can ring the moment it's broadcast;
 *  - findSender: who paid, so a payment FixedFloat can't swap can go straight back to them.
 *
 * findSender is deliberately picky. It returns null (meaning: don't refund automatically, ask the
 * user) unless two independent sources agree that one ordinary wallet sent exactly this payment
 * straight to the deposit address. Temporary failures throw instead, so the caller retries later.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetchFn: Fetch = (url, init) => fetch(url, init);
/** The fetch used for every public blockchain endpoint (tests swap it for fakes). */
export const chainFetch: Fetch = (url, init) => fetchFn(url, init);
/** Tests swap the network for fakes. */
export function setChainFetch(f: Fetch | null): void {
  fetchFn = f ?? ((url, init) => fetch(url, init));
}

/** Busy exchange wallets send hundreds of thousands of transactions; a person's wallet doesn't. */
export const EXCHANGE_NONCE = 50_000;

/** A temporary problem (endpoint down, rate-limited, tx not indexed yet): try again later. */
export class ChainUnavailable extends Error {}

const timeout = () => AbortSignal.timeout(12_000);

export async function rpcAt<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: timeout(),
  });
  if (!res.ok) throw new ChainUnavailable(`Ethereum RPC answered ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new ChainUnavailable(json.error.message);
  return json.result as T;
}

/** First RPC that answers. */
export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown;
  for (const url of config.chains.ethRpcUrls) {
    try {
      return await rpcAt<T>(url, method, params);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof ChainUnavailable ? last : new ChainUnavailable(String((last as Error)?.message ?? 'No Ethereum RPC answered'));
}

/** Base units -> decimal string, e.g. (6000000000000000n, 18) -> "0.006". */
export function fromBase(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${frac ? `${whole}.${frac}` : whole}`;
}

/** Decimal string -> base units, exactly (no floating point). "0.00236244" with 18 -> 2362440000000000n. */
export function toBase(v: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(m[1] + frac);
}

export const DECIMALS: Record<Coin, number> = { BTC: 8, ETH: 18, XMR: 12 };

// ---------------------------------------------------------------- who paid

interface EthTx {
  from: string;
  to: string | null;
  value: string;
}

async function ethSender(txid: string, deposit: string, amount: string): Promise<string | null> {
  // Ask two independent RPCs; both must answer and agree. One answer alone could be wrong.
  const urls = config.chains.ethRpcUrls.slice(0, 2);
  if (urls.length < 2) return null;
  const txs = await Promise.all(urls.map((u) => rpcAt<EthTx | null>(u, 'eth_getTransactionByHash', [txid])));
  if (txs.some((t) => !t)) throw new ChainUnavailable('Payment transaction not found yet');
  const [a, b] = txs as EthTx[];
  if (a.from.toLowerCase() !== b.from.toLowerCase() || String(a.to).toLowerCase() !== String(b.to).toLowerCase() || BigInt(a.value) !== BigInt(b.value)) return null;

  // It must be a plain transfer straight to the deposit address. A smart wallet or relayer would show
  // up as a call to some contract, with the real payer hidden inside it.
  if (String(a.to).toLowerCase() !== deposit.toLowerCase()) return null;
  const value = BigInt(a.value);
  const expected = toBase(amount, 18);
  if (value <= 0n || expected === null) return null;
  const tolerance = expected / 1000n > 10n ** 10n ? expected / 1000n : 10n ** 10n; // FixedFloat rounds to ~8 decimals
  if ((value > expected ? value - expected : expected - value) > tolerance) return null;

  const [code, nonce] = await Promise.all([rpc<string>('eth_getCode', [a.from, 'latest']), rpc<string>('eth_getTransactionCount', [a.from, 'latest'])]);
  if (code && code !== '0x') return null; // the sender is a contract
  if (Number(BigInt(nonce)) > EXCHANGE_NONCE) return null; // an exchange hot wallet: refunds may never be credited
  return a.from;
}

interface EsploraTx {
  vin: { prevout?: { scriptpubkey_address?: string } | null; is_coinbase?: boolean }[];
  vout: { scriptpubkey_address?: string; value?: number }[];
}

async function esploraTx(base: string, txid: string): Promise<EsploraTx> {
  const res = await fetchFn(`${base}/tx/${txid}`, { signal: timeout() });
  if (!res.ok) throw new ChainUnavailable(`${new URL(base).host} answered ${res.status}`);
  return (await res.json()) as EsploraTx;
}

async function btcSender(txid: string, deposit: string, amount: string): Promise<string | null> {
  const apis = config.chains.btcApis.slice(0, 2);
  if (apis.length < 2) return null;
  const txs = await Promise.all(apis.map((u) => esploraTx(u, txid)));
  const inputs = (t: EsploraTx) => [...new Set(t.vin.map((v) => v.prevout?.scriptpubkey_address ?? '?'))].sort().join(',');
  if (inputs(txs[0]) !== inputs(txs[1])) return null;
  const tx = txs[0];
  const senders = new Set(tx.vin.map((v) => v.prevout?.scriptpubkey_address ?? null));
  if (senders.size !== 1 || senders.has(null)) return null; // several payers (or unknown): ambiguous
  if (tx.vout.length > 2) return null; // payment + change is a wallet; more looks like an exchange batch
  const expected = toBase(amount, 8);
  const paid = tx.vout.filter((o) => o.scriptpubkey_address === deposit).reduce((sum, o) => sum + BigInt(o.value ?? 0), 0n);
  if (expected === null || paid <= 0n || paid !== expected) return null;
  return [...senders][0];
}

/** The wallet that paid, if that can be known safely; null if not; throws ChainUnavailable to retry. */
export async function findSender(coin: Coin, txid: string, deposit: string, amount: string): Promise<string | null> {
  if (coin === 'XMR') return null; // Monero hides who paid
  return coin === 'ETH' ? ethSender(txid, deposit, amount) : btcSender(txid, deposit, amount);
}

// ---------------------------------------------------------------- spotting a payment early

/**
 * Everything this address has received so far, in base units, confirmed or still pending.
 * (For ETH that's the pending balance; for BTC the funded total, which includes the mempool.)
 */
export async function depositTotal(coin: Coin, address: string): Promise<bigint> {
  if (coin === 'XMR') throw new ChainUnavailable("Monero payments to someone else's address can't be seen");
  if (coin === 'ETH') return BigInt(await rpc<string>('eth_getBalance', [address, 'pending']));
  const res = await fetchFn(`${config.chains.btcApis[0]}/address/${address}`, { signal: timeout() });
  if (!res.ok) throw new ChainUnavailable(`mempool.space answered ${res.status}`);
  const a = (await res.json()) as { chain_stats: { funded_txo_sum: number }; mempool_stats: { funded_txo_sum: number } };
  return BigInt(a.chain_stats.funded_txo_sum + a.mempool_stats.funded_txo_sum);
}

export const formatBase = (coin: Coin, v: bigint) => fromBase(v, DECIMALS[coin]);
