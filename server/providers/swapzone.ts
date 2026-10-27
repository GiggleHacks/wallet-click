import { config, type Coin, type PayoutCcy } from '../config.js';
import type { FfOrder, FfStatus } from '../fixedfloat.js';
import { api } from './http.js';
import { ASSETS, assetOf, shapeOrder, type Asset } from './shape.js';
import { SwapApiError, type CreateRequest, type CreatedSwap, type FallbackProvider, type RawLimits } from './types.js';

/**
 * Swapzone (https://swapzone.io, API v1): an aggregator of about 15 instant exchanges. A floating-rate quote per
 * exchange comes from get-rate (`chooseRate=all`); the order is made against one quote's `quotaId`, with our own
 * refund address, so this one may also be used when our wallet pays. The key goes in the `x-api-key` header.
 */

interface Currency {
  ticker: string;
  network: string;
}
interface Quote {
  adapter: string;
  amountFrom: number | null;
  amountTo: number | null;
  quotaId: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  open_fincases?: unknown;
}
interface Tx {
  id: string;
  from: string;
  fromNetwork: string;
  to: string;
  toNetwork: string;
  status: string;
  addressReceive: string;
  addressDeposit: string;
  amountDeposit?: unknown;
  amountEstimated?: unknown;
  amountRealReceive?: unknown;
  payinHash?: string | null;
  payoutHash?: string | null;
  hashReceive?: string | null;
  depositReceivedAt?: string | null;
  createdAt?: string;
  payTill?: string;
  refundAddress?: string;
}

const url = (path: string, params?: Record<string, string>) => `${config.swapzone.baseUrl}${path}${params ? `?${new URLSearchParams(params)}` : ''}`;
const headers = () => ({ 'x-api-key': config.swapzone.apiKey });
const n = (v: unknown): number | null => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

// ---------------------------------------------------------------- what Swapzone calls our assets

let currencies: { at: number; list: Currency[] } | null = null;
const CURRENCIES_FRESH = 6 * 3_600_000;

/** Swapzone's own spelling (ticker, network) of one of our assets, from its currency list. */
async function nameOf(asset: Asset): Promise<Currency> {
  if (!currencies || Date.now() - currencies.at > CURRENCIES_FRESH) {
    currencies = { at: Date.now(), list: await api<Currency[]>('Swapzone', url('/exchange/currencies'), { headers: headers() }) };
  }
  const a = ASSETS[asset];
  const hit = currencies.list.find((c) => String(c.ticker).toLowerCase() === a.ticker && a.networks.includes(String(c.network).toLowerCase()));
  if (!hit) throw new SwapApiError(-3, `Swapzone doesn't list ${asset}.`);
  return { ticker: hit.ticker, network: hit.network };
}

/** Tests: forget the cached currency list. */
export const resetSwapzone = () => (currencies = null);

// ---------------------------------------------------------------- quotes

const clean = (q: Quote, avoid: string[]) => {
  const ex = String(q.adapter ?? '').toLowerCase();
  if (!ex || !q.quotaId || (q.amountTo ?? 0) <= 0) return false;
  if (config.swapzone.exchanges.length && !config.swapzone.exchanges.includes(ex)) return false;
  if (avoid.includes(ex)) return false;
  const claims = String(q.open_fincases ?? '').toLowerCase();
  return !claims || claims === '0' || claims === 'false' || claims === 'null' || claims === 'none';
};

/** Floating-rate quotes from every exchange for `amount`, best payout first. `avoid` is dropped if nothing else is left. */
async function quotes(from: Coin, to: PayoutCcy, amount: number, opts: { avoid?: string[]; refund: boolean }): Promise<Quote[]> {
  const [f, t] = [await nameOf(from), await nameOf(to)];
  const raw = await api<Quote | Quote[]>(
    'Swapzone',
    url('/exchange/get-rate', {
      from: f.ticker,
      to: t.ticker,
      fromNetwork: f.network,
      toNetwork: t.network,
      amount: String(amount),
      rateType: 'floating',
      chooseRate: 'all',
      ...(opts.refund ? {} : { noRefundAddress: 'true' }),
    }),
    { headers: headers() },
  );
  const all = (Array.isArray(raw) ? raw : [raw]).filter((q) => q && typeof q === 'object');
  const best = (list: Quote[]) => list.filter((q) => clean(q, [])).sort((a, b) => (b.amountTo ?? 0) - (a.amountTo ?? 0));
  const avoiding = best(all.filter((q) => clean(q, opts.avoid ?? [])));
  return avoiding.length ? avoiding : best(all);
}

// ---------------------------------------------------------------- order → our shape

const STATUS: Record<string, FfStatus> = {
  waiting: 'NEW',
  confirming: 'PENDING',
  exchanging: 'EXCHANGE',
  sending: 'WITHDRAW',
  finished: 'DONE',
  refunded: 'DONE',
  overdue: 'EXPIRED',
  failed: 'EMERGENCY',
};

function toOrder(t: Tx): FfOrder {
  const word = String(t.status ?? '').toLowerCase();
  const status = STATUS[word] ?? 'EMERGENCY';
  const finished = word === 'finished';
  const paidIn = Boolean(t.depositReceivedAt) || ['confirming', 'exchanging', 'sending', 'finished', 'refunded'].includes(word);
  const hash = (v: string | null | undefined) => (v ? String(v) : null);
  return shapeOrder({
    id: String(t.id),
    status,
    fromCode: assetOf(t.from, t.fromNetwork) ?? `${t.from}/${t.fromNetwork}`,
    toCode: assetOf(t.to, t.toNetwork) ?? `${t.to}/${t.toNetwork}`,
    toNetwork: String(t.toNetwork ?? ''),
    fromAmount: t.amountDeposit,
    toAmount: finished ? (t.amountRealReceive ?? t.amountEstimated) : t.amountEstimated,
    depositAddress: String(t.addressDeposit ?? ''),
    payoutAddress: String(t.addressReceive ?? ''),
    depositTx: hash(t.payinHash),
    depositAmount: paidIn ? t.amountDeposit : null,
    payoutTx: hash(t.payoutHash) ?? hash(t.hashReceive),
    payoutAmount: finished ? t.amountRealReceive : null,
    createdAt: t.createdAt ? Date.parse(t.createdAt) : null,
    expiresAt: t.payTill ? Date.parse(t.payTill) : null,
    refunded: word === 'refunded',
    // "failed" means contact support; a status we've never seen is treated the same: it needs the owner.
    flags: status === 'EMERGENCY' ? [word === 'failed' ? 'FAILED' : 'UNKNOWN_STATUS'] : undefined,
  });
}

// ---------------------------------------------------------------- the provider

export const swapzone: FallbackProvider = {
  id: 'swapzone',
  label: 'Swapzone',
  idPrefix: 'sz_',
  supportsRefundAddress: true,
  configured: () => Boolean(config.swapzone.apiKey),

  async limits(from, to, probe, avoid) {
    const list = await quotes(from, to, probe, { avoid, refund: true });
    const q = list[0];
    if (!q) throw new SwapApiError(-3, `Swapzone has no exchange for ${from} → ${to} right now.`);
    const min = n(q.minAmount);
    if (min === null || !(min > 0)) throw new SwapApiError(-3, 'Swapzone did not return usable limits.');
    const out = (q.amountTo as number) / probe;
    const stable = to === 'USDCBASE' || to === 'USDT';
    return { min, max: n(q.maxAmount) ?? 1_000_000_000, usdPerCoin: stable ? out : null, outPerCoin: out, precision: 8, exchange: String(q.adapter).toLowerCase() } satisfies RawLimits;
  },

  async create(req: CreateRequest): Promise<CreatedSwap> {
    const list = (await quotes(req.from, req.to, req.amount, { avoid: req.avoid, refund: Boolean(req.refundAddress) })).filter(
      (q) => req.amount >= (q.minAmount ?? 0) && (q.maxAmount === null || q.maxAmount === undefined || req.amount <= q.maxAmount),
    );
    const q = list[0];
    if (!q) throw new SwapApiError(-3, `No Swapzone exchange takes ${req.amount} ${req.from} → ${req.to} right now.`);
    const [f, t] = [await nameOf(req.from), await nameOf(req.to)];
    const res = await api<{ transaction?: Tx }>('Swapzone', url('/exchange/create'), {
      method: 'POST',
      headers: headers(),
      body: {
        from: f.ticker,
        to: t.ticker,
        fromNetwork: f.network,
        toNetwork: t.network,
        amountDeposit: String(req.amount),
        addressReceive: req.toAddress,
        quotaId: q.quotaId,
        ...(req.refundAddress ? { refundAddress: req.refundAddress } : { noRefundAddress: true }),
      },
    });
    if (!res.transaction?.id) throw new SwapApiError(502, 'Swapzone answered without an order.');
    return { nativeId: String(res.transaction.id), token: '', exchange: String(q.adapter).toLowerCase(), order: toOrder(res.transaction) };
  },

  async order(nativeId) {
    const res = await api<{ transaction?: Tx }>('Swapzone', url('/exchange/tx', { id: nativeId }), { headers: headers() });
    if (!res.transaction) throw new SwapApiError(502, 'Swapzone answered without an order.');
    return toOrder(res.transaction);
  },
};
