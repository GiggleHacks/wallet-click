import { COINS, PAYOUTS, type Coin, type PayoutCcy } from '../config.js';
import type { FfOrder, FfStatus } from '../fixedfloat.js';

/** Every asset an order can move, with how the aggregators name it (ticker, and the networks they may call it on). */
export type Asset = Coin | PayoutCcy;
export const ASSETS: Record<Asset, { ticker: string; networks: string[] }> = {
  BTC: { ticker: 'btc', networks: ['btc', 'bitcoin'] },
  ETH: { ticker: 'eth', networks: ['eth', 'ethereum'] },
  XMR: { ticker: 'xmr', networks: ['xmr', 'monero'] },
  USDCBASE: { ticker: 'usdc', networks: ['base'] },
  USDT: { ticker: 'usdt', networks: ['eth', 'ethereum', 'erc20'] },
};

/** Our asset for a ticker and network as a provider answered them, or null when it isn't one of ours. */
export function assetOf(ticker: unknown, network: unknown): Asset | null {
  const t = String(ticker ?? '').toLowerCase();
  const n = String(network ?? '').toLowerCase();
  for (const [asset, a] of Object.entries(ASSETS) as [Asset, (typeof ASSETS)[Asset]][]) if (a.ticker === t && a.networks.includes(n)) return asset;
  return null;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
};
const amount = (v: unknown): string | null => (num(v) === null ? null : String(v));

/** What a provider told us about one order, in its own words. */
export interface Seen {
  id: string;
  status: FfStatus;
  /** What it says we send and receive (an asset of ours, or the raw text so that a mismatch gets the order refused). */
  fromCode: string;
  toCode: string;
  toNetwork: string;
  fromAmount: unknown;
  toAmount: unknown;
  depositAddress: string;
  payoutAddress: string;
  depositTx?: string | null;
  depositAmount?: unknown;
  payoutTx?: string | null;
  payoutAmount?: unknown;
  createdAt?: number | null;
  expiresAt?: number | null;
  /** The provider sent the coins back. */
  refunded?: boolean;
  /** Set for a status we don't understand or a failed swap: it needs the owner. */
  flags?: string[];
}

/** An order in FixedFloat's shape. A swap by one of our own pairs is always a float-rate one. */
export function shapeOrder(s: Seen): FfOrder {
  const tx = (id: string | null | undefined, amt: unknown) => ({ id: id || null, amount: amount(amt), fee: null, ccyfee: null, timeReg: null, timeBlock: null, confirmations: null });
  const now = Math.floor(Date.now() / 1000);
  const created = s.createdAt ? Math.floor(s.createdAt / 1000) : now;
  const expires = s.expiresAt ? Math.floor(s.expiresAt / 1000) : created + 1800;
  const fromCoin = (COINS as Record<string, { name: string; network: string }>)[s.fromCode];
  const toKnown = (PAYOUTS as Record<string, { network: string; symbol: string }>)[s.toCode];
  return {
    id: s.id,
    type: 'float',
    status: s.status,
    time: { reg: created, start: null, finish: null, update: now, expiration: expires, left: Math.max(0, expires - now) },
    from: {
      code: s.fromCode,
      coin: s.fromCode,
      network: fromCoin?.network ?? s.fromCode,
      name: fromCoin?.name ?? s.fromCode,
      amount: amount(s.fromAmount),
      address: s.depositAddress,
      tx: tx(s.depositTx, s.depositAmount),
    },
    to: {
      code: s.toCode,
      coin: toKnown?.symbol ?? s.toCode,
      network: toKnown?.network ?? s.toNetwork,
      name: s.toCode,
      amount: amount(s.toAmount),
      address: s.payoutAddress,
      tx: tx(s.payoutTx, s.payoutAmount),
    },
    ...(s.refunded ? { refunded: true } : {}),
    emergency: s.flags?.length ? { status: s.flags, choice: 'NONE', repeat: null } : { status: [], choice: 'NONE', repeat: null },
  };
}
