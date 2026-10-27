import { call, ff, type FfOrder } from '../fixedfloat.js';

/**
 * The FixedFloat side of the Wallet window: its currency list (for the long tail), rates and minimums, and the check
 * every order it creates must pass. Same rules as the transfers' orders (server/orders.ts), kept separate so the
 * Wallet can name coins the transfers don't know.
 */

export interface FfCurrency {
  code: string;
  coin: string;
  network: string;
  name: string;
  /** FixedFloat takes deposits of it (it can be swapped from). */
  recv: boolean;
  /** FixedFloat can pay it out. */
  send: boolean;
  /** Payments need a memo / destination tag. */
  tag: string | null;
  priority: number;
}

const H = 3_600_000;
let currencies: { at: number; list: FfCurrency[] } | null = null;
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

/** FixedFloat's currencies, cached for six hours (an older copy if it can't be fetched). */
export async function ffCurrencies(now = Date.now()): Promise<FfCurrency[]> {
  if (currencies && now - currencies.at < 6 * H) return currencies.list;
  try {
    type Raw = { code: string; coin: string; network: string; name: string; recv: unknown; send: unknown; tag?: string | null; priority?: number };
    const raw = await call<Raw[]>('ccies', {});
    const list = raw
      .filter((c) => c && typeof c.code === 'string')
      .map((c) => ({ code: c.code, coin: c.coin, network: c.network, name: c.name, recv: truthy(c.recv), send: truthy(c.send), tag: c.tag || null, priority: Number(c.priority ?? 0) }));
    currencies = { at: now, list };
    return list;
  } catch (e) {
    if (currencies) return currencies.list;
    throw e;
  }
}

export interface PairInfo {
  min: number;
  max: number;
  /** Dollar value of one coin, and how much comes out per coin in (FixedFloat's cut included). */
  usdPerCoin: number | null;
  outPerCoin: number | null;
  precision: number;
  /** Anything other than "outside the limits" that stops this swap right now (paused, out of reserves). */
  blocking: string[];
  /** The amount asked about is below the minimum / above the maximum. */
  belowMin: boolean;
  aboveMax: boolean;
}

/** FixedFloat's rate and limits for swapping `amount` of `from` into `to` (asks every time). */
export async function quotePair(from: string, to: string, amount: number): Promise<PairInfo> {
  const p = await ff.price(from, to, amount);
  const errors = p.errors ?? [];
  const per = (v: unknown) => {
    const n = Number(v) / Number(p.from.amount);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    min: Number(p.from.min),
    max: Number(p.from.max),
    usdPerCoin: per(p.from.usd),
    outPerCoin: per(p.to.amount),
    precision: Math.min(p.from.precision ?? 8, 8),
    blocking: errors.filter((e) => !e.startsWith('LIMIT_')),
    belowMin: errors.includes('LIMIT_MIN'),
    aboveMax: errors.includes('LIMIT_MAX'),
  };
}

const pairCache = new Map<string, { at: number; info: PairInfo }>();

/** The same, for a typical amount, up to `maxAge` old: prices and minimums to show. */
export async function pairInfo(from: string, to: string, probe: number, maxAge = 10 * 60_000, now = Date.now()): Promise<PairInfo> {
  const key = `${from}>${to}`;
  const hit = pairCache.get(key);
  if (hit && now - hit.at < maxAge) return hit.info;
  const info = await quotePair(from, to, probe);
  pairCache.set(key, { at: now, info });
  return info;
}

/** The cached answer only (no request), or null. */
export const cachedPair = (from: string, to: string): PairInfo | null => pairCache.get(`${from}>${to}`)?.info ?? null;

/**
 * Refuses an order that doesn't pay exactly what was asked: the right coin in, the right coin out (USDC on Base, or
 * Monero), to exactly our address, at a float rate, with a token and a deposit address.
 */
export function checkStashOrder(o: FfOrder, fromCode: string, toCcy: 'XMR' | 'USDCBASE', toAddress: string): void {
  const problems: string[] = [];
  if (!o.token) problems.push('it came without an access token');
  if (!o.from?.address) problems.push('it has no deposit address');
  if (o.from?.code !== fromCode) problems.push(`it expects ${o.from?.code} instead of ${fromCode}`);
  if (o.to?.code !== toCcy || (toCcy === 'USDCBASE' && o.to?.network && o.to.network !== 'BASE')) problems.push(`it pays out ${o.to?.code} on ${o.to?.network} instead of ${toCcy}`);
  const paidTo = String(o.to?.address ?? '');
  if (toCcy === 'USDCBASE' ? paidTo.toLowerCase() !== toAddress.toLowerCase() : paidTo !== toAddress) problems.push('its payout address is not ours');
  if (o.type !== 'float') problems.push('it is not a float-rate order');
  if (problems.length) throw new Error(`Refusing FixedFloat order ${o.id ?? ''}: ${problems.join('; ')}.`);
}

/** Tests: forget cached rates and currencies. */
export function resetSwapCache(): void {
  pairCache.clear();
  currencies = null;
}
