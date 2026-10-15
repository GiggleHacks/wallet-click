import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeFixedFloat, ffOrder, priceAnswer } from './helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-logs-'));
process.env.DATA_DIR = dataDir;
process.env.APP_PASSWORD = 'correct horse battery staple';
process.env.FF_API_KEY = 'test-key';
process.env.FF_API_SECRET = 'test-secret';
delete process.env.ALLOWED_HOSTS;

const { buildApp } = await import('../server/app.js');
const { setTransport } = await import('../server/fixedfloat.js');
const { orders } = await import('../server/orders.js');
const { addLine, clearLogs, logger } = await import('../server/logs.js');

let app: FastifyInstance;
let cookie = '';
const H = { host: 'wallet.test', 'x-wallet': '1', 'content-type': 'application/json' };
const post = (url: string, body: unknown) => app.inject({ method: 'POST', url, headers: { ...H, cookie }, payload: JSON.stringify(body) });
const get = (url: string) => app.inject({ url, headers: { host: 'wallet.test', cookie } });
const logs = async (after = 0) => (await get(`/api/logs?after=${after}`)).json() as { lines: { id: number; run: number; count: number; level: string; msg: string }[] };

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const res = await post('/api/login', { password: 'correct horse battery staple' });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
beforeEach(() => {
  fs.rmSync(path.join(dataDir, 'orders.json'), { force: true });
  orders.reset();
  clearLogs();
});
afterAll(async () => {
  setTransport(null);
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('the Logs window', () => {
  it('needs a session', async () => {
    const res = await app.inject({ url: '/api/logs', headers: { host: 'wallet.test' } });
    expect(res.statusCode).toBe(401);
  });

  it('shows what the server did: new orders and requests that change something, not the 2-second polling', async () => {
    setTransport(
      fakeFixedFloat({
        price: (b) => priceAnswer(b.fromCcy as 'ETH'),
        create: (b) => ffOrder({ coin: b.fromCcy as 'ETH', payout: String(b.toAddress) }),
      }).transport,
    );
    await get('/api/orders');
    await get('/api/orders');
    const o = (await post('/api/orders', { coin: 'ETH' })).json();
    const text = (await logs()).lines.map((l) => l.msg).join('\n');
    expect(text).toContain(`[order ${o.id}] new ETH address ${o.address}: pays USDT to Coinbase`);
    expect(text).toMatch(/POST \/api\/orders → 200/);
    expect(text).not.toMatch(/GET \/api\/orders/);
  });

  it('logs failed sign-ins as warnings', async () => {
    await app.inject({ method: 'POST', url: '/api/login', headers: H, payload: JSON.stringify({ password: 'nope nope nope' }) });
    const line = (await logs()).lines.find((l) => l.msg.startsWith('POST /api/login → 401'));
    expect(line?.level).toBe('warn');
  });

  it('blanks secrets wherever they turn up', async () => {
    logger.info({ token: 'ff-token-123', password: 'hunter22', order: { token: 'nested-456' } }, 'checking');
    const text = JSON.stringify(await logs());
    expect(text).toContain('checking');
    expect(text).not.toMatch(/ff-token-123|hunter22|nested-456/);
  });

  it('counts a message that repeats instead of filling the window, and sends only what is new', async () => {
    addLine('warn', 'order poll failed');
    const first = (await logs()).lines;
    addLine('warn', 'order poll failed');
    addLine('warn', 'order poll failed');
    const all = (await logs()).lines;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ count: 3, run: first[0].run });
    const newer = (await logs(first[0].id)).lines;
    expect(newer).toHaveLength(1);
    expect(newer[0].count).toBe(3);
  });
});
