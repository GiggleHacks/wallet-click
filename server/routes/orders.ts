import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COIN_IDS, COINS, DELAYS, PIECES_MAX, config, type Coin } from '../config.js';
import { HttpError } from '../errors.js';
import { createOrder, orderView, orders, refundOrder } from '../orders.js';
import { transferView, transfers } from '../transfers.js';
import { walletState } from '../wallets/seed.js';
import { VERSION } from '../version.js';
import { requirePassword } from './auth.js';

function needOrder(id: string) {
  const r = orders.get(id);
  if (!r) throw new HttpError(404, 'Transfer not found');
  return r;
}

export function registerOrders(app: FastifyInstance): void {
  app.get('/api/meta', async () => ({
    payout: { address: config.payoutBase.address, label: config.payoutBase.label, ccy: config.payoutBase.ccy, network: config.payoutBase.network },
    coins: Object.fromEntries(COIN_IDS.map((id) => [id, { name: COINS[id].name, network: COINS[id].network }])),
    swapConfigured: Boolean(config.ff.apiKey && config.ff.apiSecret),
    features: { monero: Boolean(config.monero.rpcUrl), wallet: walletState().ready, seedBackupPending: walletState().backupPending, walletError: walletState().error },
    privacy: { delays: DELAYS, piecesMax: PIECES_MAX, testDelayMin: config.privacyTestDelayMin },
    version: VERSION,
  }));

  // The browser names the coin and, optionally, a destination from the address book. Never an address.
  app.post('/api/orders', async (req) => {
    const { coin, destinationId } = z
      .object({ coin: z.enum(COIN_IDS as [Coin, ...Coin[]]), destinationId: z.string().max(40).optional() })
      .parse(req.body);
    return orderView(await createOrder(coin, { destinationId }));
  });

  // Orders and transfers together: the browser polls this every two seconds.
  app.get('/api/orders', async () => ({
    orders: orders.forBrowser().map((o) => orderView(o)),
    transfers: transfers.forBrowser().map((t) => transferView(t)),
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
