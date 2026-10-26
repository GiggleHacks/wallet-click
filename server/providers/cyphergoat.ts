import { config } from '../config.js';
import type { FfOrder, FfStatus } from '../fixedfloat.js';
import { api } from './http.js';
import { ASSETS, assetOf, shapeOrder } from './shape.js';
import { SwapApiError, type CreateRequest, type CreatedSwap, type FallbackProvider, type RawLimits } from './types.js';

/**
 * CypherGoat (https://cyphergoat.com, API v1.4): an aggregator of about 25 instant exchanges. /estimate lists every
 * exchange's payout, /swap creates the order with the one we pick, /transaction follows it. Its /swap has no refund
 * address, so this one is only used for fresh addresses a payer pays (never when our own wallet pays). Written from
 * the published OpenAPI document: the status words aren't listed there, so any one we don't know needs the owner.
 */

interface Estimate {
  rates?: { Results?: { Exchange: string; Amount: number; KYCScore?: number }[]; Min?: number; EstimateId?: number };
  min?: number;
}
interface Tx {
  Id?: string;
  CGID?: string;
  Address?: string;
  DestinationAddress?: string;
  Provider?: string;
  Status?: string;
  Coin1?: string;
  Coin2?: string;
  Network1?: string;
  Network2?: string;
  SendAmount?: unknown;
  EstimateAmount?: unknown;
  CreatedAt?: string;
}

const headers = () => ({ authorization: `Bearer ${config.cyphergoat.apiKey}` });
const query = (p: Record<string, string>) => `${config.cyphergoat.baseUrl}${p.__path}?${new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([k]) => k !== '__path')))}`;

const asset = (a: keyof typeof ASSETS) => ({ coin: ASSETS[a].ticker, network: ASSETS[a].networks[0] });

async function estimate(req: Pick<CreateRequest, 'from' | 'to' | 'avoid'>, amount: number) {
  const [f, t] = [asset(req.from), asset(req.to)];
  const res = await api<Estimate>('CypherGoat', query({ __path: '/estimate', coin1: f.coin, network1: f.network, coin2: t.coin, network2: t.network, amount: String(amount) }), { headers: headers() });
  const min = Number(res.min ?? res.rates?.Min);
  const usable = (res.rates?.Results ?? []).filter((r) => r && r.Amount > 0 && r.Exchange && (r.KYCScore ?? 0) <= config.cyphergoat.maxKyc && (!config.cyphergoat.exchanges.length || config.cyphergoat.exchanges.includes(r.Exchange.toLowerCase())));
  const sorted = (list: typeof usable) => [...list].sort((a, b) => b.Amount - a.Amount);
  const avoiding = sorted(usable.filter((r) => !(req.avoid ?? []).includes(r.Exchange.toLowerCase())));
  return { min, estimateId: res.rates?.EstimateId, results: avoiding.length ? avoiding : sorted(usable) };
}

const STATUS: [RegExp, FfStatus][] = [
  [/^refund/, 'DONE'],
  [/^(expire|overdue|timeout)/, 'EXPIRED'],
  [/^(fail|error|cancel|halt)/, 'EMERGENCY'],
  [/^(finish|complete|done|success)/, 'DONE'],
  [/^(send|payout|withdraw)/, 'WITHDRAW'],
  [/^(exchang|process|swap)/, 'EXCHANGE'],
  [/^(confirm|receiv|detect|pending)/, 'PENDING'],
  [/^(wait|new|creat|await)/, 'NEW'],
];

function toOrder(t: Tx): FfOrder {
  const word = String(t.Status ?? '').trim().toLowerCase();
  const status = STATUS.find(([re]) => re.test(word))?.[1] ?? 'EMERGENCY';
  const known = STATUS.some(([re]) => re.test(word));
  const done = status === 'DONE' && !word.startsWith('refund');
  return shapeOrder({
    id: String(t.CGID || t.Id || ''),
    status,
    fromCode: assetOf(t.Coin1, t.Network1) ?? `${t.Coin1}/${t.Network1}`,
    toCode: assetOf(t.Coin2, t.Network2) ?? `${t.Coin2}/${t.Network2}`,
    toNetwork: String(t.Network2 ?? ''),
    fromAmount: t.SendAmount,
    toAmount: t.EstimateAmount,
    depositAddress: String(t.Address ?? ''),
    payoutAddress: String(t.DestinationAddress ?? ''),
    // No transaction hashes or received amounts come back, so "paid in" shows once the status says so.
    depositAmount: status === 'NEW' ? null : t.SendAmount,
    payoutAmount: done ? t.EstimateAmount : null,
    createdAt: t.CreatedAt ? Date.parse(t.CreatedAt) : null,
    refunded: word.startsWith('refund'),
    flags: status === 'EMERGENCY' ? [known ? 'FAILED' : 'UNKNOWN_STATUS'] : undefined,
  });
}

export const cyphergoat: FallbackProvider = {
  id: 'cyphergoat',
  label: 'CypherGoat',
  idPrefix: 'cg_',
  supportsRefundAddress: false,
  configured: () => Boolean(config.cyphergoat.apiKey),

  async limits(from, to, probe, avoid) {
    const e = await estimate({ from, to, avoid }, probe);
    const best = e.results[0];
    if (!best) throw new SwapApiError(-3, `CypherGoat has no exchange for ${from} → ${to} right now.`);
    if (!(e.min > 0)) throw new SwapApiError(-3, 'CypherGoat did not return a minimum.');
    const out = best.Amount / probe;
    const stable = to === 'USDCBASE' || to === 'USDT';
    // It reports no maximum.
    return { min: e.min, max: 1_000_000_000, usdPerCoin: stable ? out : null, outPerCoin: out, precision: 8, exchange: best.Exchange.toLowerCase() } satisfies RawLimits;
  },

  async create(req: CreateRequest): Promise<CreatedSwap> {
    if (req.refundAddress) throw new SwapApiError(-3, "CypherGoat can't take a refund address, so it isn't used when our own wallet pays.");
    const e = await estimate(req, req.amount);
    const best = e.results[0];
    if (!best || !(req.amount >= e.min)) throw new SwapApiError(-3, `No CypherGoat exchange takes ${req.amount} ${req.from} → ${req.to} right now.`);
    const [f, t] = [asset(req.from), asset(req.to)];
    const res = await api<{ transaction?: Tx }>(
      'CypherGoat',
      query({
        __path: '/swap',
        coin1: f.coin,
        network1: f.network,
        coin2: t.coin,
        network2: t.network,
        amount: String(req.amount),
        partner: best.Exchange,
        address: req.toAddress,
        ...(e.estimateId !== undefined ? { estimateid: String(e.estimateId) } : {}),
      }),
      { headers: headers() },
    );
    const tx = res.transaction;
    const id = tx?.CGID || tx?.Id;
    if (!tx || !id) throw new SwapApiError(502, 'CypherGoat answered without an order.');
    return { nativeId: String(id), token: String(tx.Id ?? ''), exchange: String(tx.Provider ?? best.Exchange).toLowerCase(), order: toOrder(tx) };
  },

  async order(nativeId) {
    const res = await api<{ transaction?: Tx }>('CypherGoat', query({ __path: '/transaction', id: nativeId }), { headers: headers() });
    if (!res.transaction) throw new SwapApiError(502, 'CypherGoat answered without an order.');
    return toOrder(res.transaction);
  },
};
