import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COIN_IDS, COINS, config, type Coin } from '../config.js';
import { HttpError } from '../errors.js';
import { createOrder, orderView, orders, refundOrder } from '../orders.js';
import { VERSION } from '../version.js';
import { requirePassword } from './auth.js';

function needOrder(id: string) {
  const r = orders.get(id);
  if (!r) throw new HttpError(404, 'Transfer not found');
  return r;
}

export function registerOrders(app: FastifyInstance): void {
  app.get('/api/meta', async () => ({
    payout: { address: config.payout.address, label: config.payout.label, ccy: config.payout.ccy, network: config.payout.network },
    coins: Object.fromEntries(COIN_IDS.map((id) => [id, { name: COINS[id].name, network: COINS[id].network }])),
    swapConfigured: Boolean(config.ff.apiKey && config.ff.apiSecret),
    version: VERSION,
  }));

  // Only the coin comes from the browser. The payout address is fixed on the server.
  app.post('/api/orders', async (req) => {
    const { coin } = z.object({ coin: z.enum(COIN_IDS as [Coin, ...Coin[]]) }).parse(req.body);
    return orderView(await createOrder(coin));
  });

  app.get('/api/orders', async () => ({
    orders: orders.forBrowser().map((o) => orderView(o)),
  }));

  app.get<{ Params: { id: string } }>('/api/orders/:id', async (req) => orderView(needOrder(req.params.id)));

  app.post<{ Params: { id: string } }>('/api/orders/:id/refund', async (req) => {
    const body = z.object({ address: z.string().trim().min(1).max(120), password: z.string().max(1024) }).parse(req.body);
    await requirePassword(body.password, req);
    const r = needOrder(req.params.id);
    await refundOrder(r, body.address);
    return orderView(r);
  });
}
