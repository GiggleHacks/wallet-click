import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addresses } from '../addresses.js';
import { COINS, DELAYS, PIECES_MAX, config, type Coin } from '../config.js';
import { UserError } from '../errors.js';
import { limits } from '../orders.js';
import { changeDelay, createPrivacyTransfer, releaseNow, retry, transferView, transfers } from '../transfers.js';
import { hotWallet } from '../wallets/index.js';
import { onDestinationRemove } from './destinations.js';

const delay = z.number().int().refine((h) => (DELAYS as readonly number[]).includes(h), 'Pick one of the waits');
const pieces = z.number().int().min(1).max(PIECES_MAX);
const coin = z.enum(['BTC', 'ETH', 'XMR']);

/** Rough "what arrives" for paying `usd` worth of a coin into a route, using FixedFloat's current rates. */
async function quote(c: Coin, usd: number, privacy: boolean) {
  const first = await limits(c, privacy ? 'XMR' : 'USDT', { cached: true });
  if (!first.usdPerCoin || !first.outPerCoin) throw new UserError("FixedFloat didn't give a rate just now. Try again shortly.");
  const amount = usd / first.usdPerCoin;
  let out = amount * first.outPerCoin;
  if (privacy) {
    const second = await limits('XMR', 'USDT', { cached: true });
    out = out * (second.outPerCoin ?? 0);
  }
  return {
    coin: c,
    amount: amount.toFixed(c === 'BTC' ? 8 : c === 'ETH' ? 6 : 6),
    usdtEstimate: out.toFixed(2),
    minAmount: String(first.min),
    minUsd: Math.round(first.min * first.usdPerCoin * 100) / 100,
  };
}

export function registerTransfers(app: FastifyInstance): void {
  // A destination a permanent address or an unfinished transfer pays out to can't be removed.
  onDestinationRemove((id) => {
    const route = addresses.usedBy(id);
    if (route) return `The permanent address "${route}"`;
    return transfers.all().some((t) => t.destinationId === id && t.state !== 'done' && t.state !== 'refunded') ? 'A transfer still in progress' : null;
  });

  app.get('/api/transfers', async () => ({ transfers: transfers.forBrowser().map((t) => transferView(t)) }));

  app.get<{ Params: { id: string } }>('/api/transfers/:id', async (req) => {
    const t = transfers.get(req.params.id);
    if (!t) throw new UserError('Transfer not found');
    return transferView(t);
  });

  // Privacy Enhanced with a fresh address. The browser names the coin, delay and destination; never an address.
  app.post('/api/transfers', async (req) => {
    const body = z.object({ coin: z.enum(['BTC', 'ETH']), delayHours: delay, pieces: pieces.default(1), destinationId: z.string().max(40).optional() }).parse(req.body);
    return transferView(await createPrivacyTransfer(body.coin, body.delayHours, body.destinationId, Date.now(), body.pieces));
  });

  app.post<{ Params: { id: string } }>('/api/transfers/:id/release', async (req) => transferView(releaseNow(req.params.id)));
  app.post<{ Params: { id: string } }>('/api/transfers/:id/delay', async (req) => {
    const { delayHours } = z.object({ delayHours: delay }).parse(req.body);
    return transferView(changeDelay(req.params.id, delayHours));
  });
  app.post<{ Params: { id: string } }>('/api/transfers/:id/retry', async (req) => transferView(retry(req.params.id)));

  // ---------------------------------------------------------------- permanent addresses

  const routeView = (r: ReturnType<typeof addresses.list>[number]) => ({
    id: r.id,
    label: r.label,
    coin: r.coin,
    coinName: COINS[r.coin].name,
    mode: r.mode,
    delayHours: r.delayHours,
    pieces: r.pieces ?? 1,
    oneTime: Boolean(r.oneTime),
    expiresAt: r.expiresAt ?? null,
    destinationId: r.destinationId,
    destinationLabel: r.destination.label,
    destinationAddress: r.destination.address,
    address: r.address,
    createdAt: r.createdAt,
    archived: r.archived,
  });

  app.get('/api/addresses', async () => ({
    addresses: addresses.saved().map(routeView),
    available: { BTC: Boolean(hotWallet('BTC')), ETH: Boolean(hotWallet('ETH')), XMR: Boolean(hotWallet('XMR')), privacy: Boolean(config.monero.rpcUrl) },
  }));

  app.post('/api/addresses', async (req) => {
    const body = z
      .object({
        coin,
        mode: z.enum(['direct', 'privacy']),
        delayHours: delay.nullable().optional(),
        pieces: pieces.optional(),
        destinationId: z.string().max(40).optional(),
        label: z.string().max(80).optional(),
      })
      .parse(req.body);
    return routeView(await addresses.create(body));
  });

  // A coin button with a wait or pieces: a one-time address of our own wallet, so the payment can be held and split.
  app.post('/api/addresses/once', async (req) => {
    const body = z.object({ coin, delayHours: delay.default(0), pieces: pieces.default(1), destinationId: z.string().max(40).optional() }).parse(req.body);
    if (!body.delayHours && body.pieces === 1) throw new UserError('Nothing to wait for or split: use a plain address.');
    return routeView(await addresses.create({ ...body, mode: 'direct', oneTime: true }));
  });

  app.post<{ Params: { id: string } }>('/api/addresses/:id', async (req) => {
    const body = z.object({ label: z.string().max(80).optional(), delayHours: delay.optional(), pieces: pieces.optional(), archived: z.boolean().optional() }).parse(req.body);
    const r = addresses.get(req.params.id);
    if (r?.oneTime) throw new UserError('A one-time address can’t be changed.');
    return routeView(addresses.update(req.params.id, body));
  });

  app.get<{ Querystring: { coin?: string; usd?: string; mode?: string } }>('/api/quote', async (req) => {
    const q = z.object({ coin, usd: z.coerce.number().positive().max(1_000_000), mode: z.enum(['direct', 'privacy']).default('direct') }).parse(req.query);
    return quote(q.coin, q.usd, q.mode === 'privacy');
  });
}
