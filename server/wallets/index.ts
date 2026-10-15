import type { Coin } from '../config.js';
import * as xmr from './xmr.js';

/**
 * A hot wallet that forwards whatever lands at a permanent address. Every coin implements the same steps, so the
 * transfer engine treats Bitcoin, Ethereum and Monero alike. Amounts are base units (sats, wei, piconero).
 */

export interface RouteRef {
  coin: Coin;
  /** Derivation index (BTC/ETH) or subaddress index (XMR). */
  index: number;
  address: string;
}

export interface Scan {
  /** Everything at the address that hasn't been forwarded yet, confirmed or not. */
  seen: bigint;
  /** The part that can be forwarded now (confirmed / unlocked). */
  spendable: bigint;
  /** Payments that make up `seen`. */
  txids: string[];
  /** Confirmations of the least-confirmed payment still waiting, and how many are needed. */
  confirmations: number;
  required: number;
  /** One of our own sends from this address isn't settled yet: wait before forwarding more. */
  busy: boolean;
}

export interface Prepared {
  txids: string[];
  /** Signed transactions (raw hex, or Monero tx metadata). Secret: never sent to the browser. */
  raw: string[];
  amount: bigint;
  fee: bigint;
  /** Outpoints spent (Bitcoin), so a later scan doesn't count them again. */
  inputs?: string[];
}

export interface HotWallet {
  coin: Coin;
  decimals: number;
  /** `exclude`: outpoints already spent by our own unconfirmed sends (Bitcoin). */
  scan(r: RouteRef, exclude?: Set<string>): Promise<Scan>;
  /**
   * What forwarding everything spendable would deliver after the network fee, or null if nothing can go yet.
   * `inputs` (Bitcoin): the exact coins it counted, so the send spends those and no others.
   */
  quote(r: RouteRef, exclude?: Set<string>): Promise<{ amount: bigint; fee: bigint; inputs?: string[] } | null>;
  /** Signs, without broadcasting, a payment of exactly `amount` to `to` (Monero: everything unlocked). */
  prepare(r: RouteRef, to: string, amount: bigint, opts?: { inputs?: string[]; exclude?: Set<string> }): Promise<Prepared>;
  broadcast(raw: string): Promise<void>;
  /** Whether one of our transactions is on the network yet (mempool or chain); null if not seen. */
  status(txid: string): Promise<{ confirmations: number } | null>;
}

/** Monero, through the VPS's monero-wallet-rpc (subaddresses of our own account). */
export const xmrWallet: HotWallet = {
  coin: 'XMR',
  decimals: xmr.XMR_DECIMALS,
  async scan(r) {
    const [rows, bal] = await Promise.all([xmr.incoming(r.index), xmr.balance(r.index)]);
    // The balance already leaves out what we've sent; the transfer list says which payments it's made of.
    const waiting = rows.filter((t) => t.pool || t.confirmations < xmr.XMR_LOCK_BLOCKS);
    return {
      seen: bal.total,
      spendable: bal.unlocked,
      txids: rows.filter((t) => t.pool || t.confirmations < 60).map((t) => t.txid), // recent payments, for display
      confirmations: waiting.length ? Math.min(...waiting.map((t) => t.confirmations)) : xmr.XMR_LOCK_BLOCKS,
      required: xmr.XMR_LOCK_BLOCKS,
      busy: false,
    };
  },
  async quote(r) {
    const bal = await xmr.balance(r.index);
    if (bal.unlocked <= 0n) return null;
    // A sweep to our own address, never relayed: only its fee matters (it doesn't depend on the destination).
    const dry = await xmr.prepareSweep(r.index, r.address);
    return { amount: dry.amount, fee: dry.fee };
  },
  async prepare(r, to) {
    const s = await xmr.prepareSweep(r.index, to);
    return { txids: s.txids, raw: s.metadata, amount: s.amount, fee: s.fee };
  },
  async broadcast(raw) {
    await xmr.relay(raw);
  },
  async status(txid) {
    const s = await xmr.sent(txid);
    return s && !s.failed ? { confirmations: s.confirmations } : null;
  },
};

type Factory = () => HotWallet | null;
const factories: Partial<Record<Coin, Factory>> = { XMR: () => (xmr.xmrConfigured() ? xmrWallet : null) };

/** Lets the BTC/ETH wallets register themselves once the seed is unlocked. */
export function registerWallet(coin: Coin, factory: Factory): void {
  factories[coin] = factory;
}

/** The hot wallet for a coin, or null when it isn't set up on this server. */
export const hotWallet = (coin: Coin): HotWallet | null => factories[coin]?.() ?? null;
