import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAYOUT, PAYOUT_USDT, fakeFixedFloat, ffOrder, priceAnswer, xmrAddress } from './helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-dest-'));
process.env.DATA_DIR = dataDir;
process.env.APP_PASSWORD = 'correct horse battery staple';
process.env.FF_API_KEY = 'test-key';
process.env.FF_API_SECRET = 'test-secret';
delete process.env.ALLOWED_HOSTS;

const { buildApp } = await import('../server/app.js');
const { setTransport } = await import('../server/fixedfloat.js');
const { checkCreated, orders, pollDue, watchChain } = await import('../server/orders.js');
const { destinations } = await import('../server/destinations.js');

const PASSWORD = 'correct horse battery staple';
/** A checksummed address that isn't Coinbase (EIP-55 test vector). */
const FRIEND = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

let app: FastifyInstance;
let cookie = '';
const H = { host: 'wallet.test', 'x-wallet': '1', 'content-type': 'application/json' };
const post = (url: string, body: unknown) => app.inject({ method: 'POST', url, headers: { ...H, cookie }, payload: JSON.stringify(body) });
const get = (url: string) => app.inject({ url, headers: { host: 'wallet.test', cookie } });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const res = await post('/api/login', { password: PASSWORD });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
beforeEach(() => {
  for (const f of ['orders.json', 'destinations.json']) fs.rmSync(path.join(dataDir, f), { force: true });
  orders.reset();
  destinations.reset();
});
afterAll(async () => {
  setTransport(null);
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const okFake = () => {
  const fake = fakeFixedFloat({
    price: (b) => priceAnswer(b.fromCcy as 'ETH', b.toCcy as 'USDT' | 'USDCBASE'),
    create: (b) => ffOrder({ coin: b.fromCcy as 'ETH', payout: String(b.toAddress), toCode: String(b.toCcy) }),
  });
  setTransport(fake.transport);
  return fake;
};

describe('address book', () => {
  it('has only Coinbase (USDC on Base) built in: USDT is no longer offered', async () => {
    const list = (await get('/api/destinations')).json().destinations;
    expect(list).toEqual([expect.objectContaining({ id: 'coinbase-base', label: 'Coinbase (USDC on Base)', address: PAYOUT, ccy: 'USDCBASE', builtIn: true })]);
    expect((await get('/api/meta')).json().payout).toMatchObject({ address: PAYOUT, label: 'Coinbase (USDC on Base)', ccy: 'USDCBASE' });
  });

  it('answers the old built-in id "coinbase" with the Base destination, and never removes it', async () => {
    const fake = okFake();
    const res = await post('/api/orders', { coin: 'ETH', destinationId: 'coinbase' });
    expect(res.statusCode).toBe(200);
    expect(fake.calls.find((c) => c.method === 'create')!.body).toMatchObject({ toCcy: 'USDCBASE', toAddress: PAYOUT });
    expect((await post('/api/destinations/coinbase/delete', { password: PASSWORD })).json().error).toMatch(/built in/);
    expect((await post('/api/destinations/coinbase-base/delete', { password: PASSWORD })).json().error).toMatch(/built in/);
  });

  it('pays USDC on Base, to the built-in address, when no destination is named', async () => {
    const fake = okFake();
    const res = await post('/api/orders', { coin: 'ETH' });
    expect(res.statusCode).toBe(200);
    expect(fake.calls.find((c) => c.method === 'create')!.body).toMatchObject({ toCcy: 'USDCBASE', toAddress: PAYOUT });
    expect(fake.calls.find((c) => c.method === 'price')!.body).toMatchObject({ toCcy: 'USDCBASE' });
    expect(res.json()).toMatchObject({ payoutAddress: PAYOUT, payoutLabel: 'Coinbase (USDC on Base)', toCcy: 'USDCBASE', destinationId: 'coinbase-base' });
  });

  it('adds a destination only with the password and a checksummed address', async () => {
    expect((await post('/api/destinations', { label: 'Friend', address: FRIEND, password: 'wrong password!' })).statusCode).toBe(401);
    const lower = await post('/api/destinations', { label: 'Friend', address: FRIEND.toLowerCase().replace('0x5aaeb', '0x5aaeC'), password: PASSWORD });
    expect(lower.statusCode).toBe(400);
    expect(lower.json().error).toMatch(/checksum.*USDC on Base deposit page/);
    expect((await post('/api/destinations', { label: 'Tron', address: 'TXYZ', password: PASSWORD })).json().error).toMatch(/isn't an Ethereum-style address for USDC on Base/);
    const ok = await post('/api/destinations', { label: '  Friend  ', address: FRIEND, password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().destinations[1]).toMatchObject({ label: 'Friend', address: FRIEND, ccy: 'USDCBASE' });
    // The same address or name twice is refused.
    expect((await post('/api/destinations', { label: 'Again', address: FRIEND, password: PASSWORD })).json().error).toMatch(/already saved as "Friend"/);
    expect((await post('/api/destinations', { label: 'coinbase (usdc on base)', address: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', password: PASSWORD })).json().error).toMatch(/already a destination/);
  });

  it('refuses to add a USDT address any more', async () => {
    expect((await post('/api/destinations', { label: 'Friend', address: FRIEND, ccy: 'USDT', password: PASSWORD })).statusCode).toBe(400);
    expect(() => destinations.add('Friend', FRIEND, 'USDT')).toThrow(/USDT on Ethereum is no longer offered/);
  });

  it('hides a USDT address saved earlier, and refuses any new payout to it', async () => {
    fs.writeFileSync(path.join(dataDir, 'destinations.json'), JSON.stringify({ version: 1, destinations: [{ id: 'd_old', label: 'Old friend', address: FRIEND, createdAt: 1 }] }));
    destinations.reset();
    expect((await get('/api/destinations')).json().destinations.map((d: { id: string }) => d.id)).toEqual(['coinbase-base']);
    expect(destinations.get('d_old')).toMatchObject({ ccy: 'USDT' }); // still known, for what already pays it
    const fake = okFake();
    const res = await post('/api/orders', { coin: 'ETH', destinationId: 'd_old' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Old friend pays USDT on Ethereum, which isn't offered any more/);
    expect(fake.calls.some((c) => c.method === 'create')).toBe(false);
    expect((await post('/api/addresses', { coin: 'BTC', mode: 'direct', destinationId: 'd_old' })).statusCode).toBe(400);
  });

  it('removes a destination with the password, but never Coinbase', async () => {
    const id = (await post('/api/destinations', { label: 'Friend', address: FRIEND, password: PASSWORD })).json().destinations[1].id;
    expect((await post(`/api/destinations/${id}/delete`, { password: 'nope nope nope' })).statusCode).toBe(401);
    const res = await post(`/api/destinations/${id}/delete`, { password: PASSWORD });
    expect(res.json().destinations).toHaveLength(1);
  });

  it('pays a new address out to the chosen destination, never one the browser names', async () => {
    const id = (await post('/api/destinations', { label: 'Friend', address: FRIEND, password: PASSWORD })).json().destinations[1].id;
    const fake = okFake();
    const res = await post('/api/orders', { coin: 'ETH', destinationId: id, toAddress: PAYOUT });
    expect(res.statusCode).toBe(200);
    expect(fake.calls.find((c) => c.method === 'create')!.body).toMatchObject({ toCcy: 'USDCBASE', toAddress: FRIEND });
    expect(res.json()).toMatchObject({ payoutAddress: FRIEND, payoutLabel: 'Friend', toCcy: 'USDCBASE', destinationId: id });
    // Unknown destinations are refused before anything is created.
    const before = fake.calls.length;
    expect((await post('/api/orders', { coin: 'ETH', destinationId: 'd_nope' })).json().error).toMatch(/isn't in your address book/);
    expect(fake.calls.length).toBe(before);
  });

  it('refuses an order that pays a different destination than the one chosen', async () => {
    const id = (await post('/api/destinations', { label: 'Friend', address: FRIEND, password: PASSWORD })).json().destinations[1].id;
    setTransport(fakeFixedFloat({ price: () => priceAnswer('ETH'), create: () => ffOrder({ payout: PAYOUT }) }).transport);
    const res = await post('/api/orders', { coin: 'ETH', destinationId: id });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/not your Friend address/);
  });

  it('shows a finished payout as USDC with its Basescan link', async () => {
    const made = new Map<string, ReturnType<typeof ffOrder>>();
    setTransport(
      fakeFixedFloat({
        price: (b) => priceAnswer(b.fromCcy as 'ETH', b.toCcy as 'USDT' | 'USDCBASE'),
        create: (b) => {
          const o = ffOrder({ coin: b.fromCcy as 'ETH', payout: String(b.toAddress), toCode: String(b.toCcy) });
          made.set(o.id, o);
          return o;
        },
        order: (b) => made.get(String(b.id)),
        emergency: () => true,
      }).transport,
    );
    const base = (await post('/api/orders', { coin: 'ETH' })).json();
    const o = made.get(base.id)!;
    made.set(o.id, { ...o, status: 'DONE', to: { ...o.to, amount: '42.5', tx: { ...o.to.tx, id: '0xbase', amount: '42.5' } } });
    orders.get(base.id)!.nextPollAt = 0;
    await pollDue();
    expect((await get(`/api/orders/${base.id}`)).json()).toMatchObject({ stage: 'done', usdt: '42.5', toCcy: 'USDCBASE', payoutTxUrl: 'https://basescan.org/tx/0xbase' });
  });

  it('refuses an order that pays USDT, the wrong network, or another address', () => {
    const want = { toCcy: 'USDCBASE' as const, toAddress: PAYOUT, label: 'Coinbase (USDC on Base)' };
    const good = (over: Parameters<typeof ffOrder>[0] = {}) => ffOrder({ coin: 'BTC', toCode: 'USDCBASE', payout: PAYOUT, ...over }) as never;
    expect(() => checkCreated(good(), 'BTC', want)).not.toThrow();
    expect(() => checkCreated(good(), 'BTC')).not.toThrow(); // the default is the built-in Base destination
    expect(() => checkCreated(good({ payout: PAYOUT.toLowerCase() }), 'BTC', want)).not.toThrow(); // case doesn't matter for EVM addresses
    expect(() => checkCreated(good({ toCode: 'USDT' }), 'BTC', want)).toThrow(/instead of USDC on Base/);
    expect(() => checkCreated(good({ toNetwork: 'ETH' }), 'BTC', want)).toThrow(/instead of USDC on Base/);
    expect(() => checkCreated(good({ payout: PAYOUT_USDT }), 'BTC', want)).toThrow(/not your Coinbase \(USDC on Base\) address/);
    // The old payout, USDT on Ethereum to the old address, is never accepted for something new.
    expect(() => checkCreated(ffOrder({ coin: 'ETH', toCode: 'USDT', payout: PAYOUT_USDT }) as never, 'ETH')).toThrow(/instead of USDC on Base/);
  });
});

describe('Monero', () => {
  it('gives a fresh FixedFloat Monero address that pays USDC on Base to Coinbase', async () => {
    const fake = okFake();
    const res = await post('/api/orders', { coin: 'XMR' });
    expect(res.statusCode).toBe(200);
    expect(fake.calls.find((c) => c.method === 'create')!.body).toMatchObject({ fromCcy: 'XMR', toCcy: 'USDCBASE', toAddress: PAYOUT });
    expect(res.json()).toMatchObject({ coin: 'XMR', coinName: 'Monero', stage: 'waiting', payoutLabel: 'Coinbase (USDC on Base)' });
    expect(res.json().address).toMatch(/^4/);
  });

  it("doesn't look for Monero payments on-chain (they can't be seen)", async () => {
    okFake();
    await post('/api/orders', { coin: 'XMR' });
    let fetched = 0;
    const { setChainFetch } = await import('../server/chain.js');
    setChainFetch(async () => {
      fetched++;
      return new Response('{}');
    });
    await watchChain();
    expect(fetched).toBe(0);
    setChainFetch(null);
  });

  it('asks the owner for an address when a Monero payment is below the minimum', async () => {
    let created: ReturnType<typeof ffOrder> | null = null;
    const fake = fakeFixedFloat({
      price: () => priceAnswer('XMR'),
      create: () => (created = ffOrder({ coin: 'XMR' })),
      order: () => ({ ...created!, status: 'EMERGENCY', from: { ...created!.from, tx: { ...created!.from.tx, id: 'abc', amount: '0.001' } }, emergency: { status: ['LESS', 'LIMIT'], choice: 'NONE', repeat: '0' } }),
      emergency: () => true,
    });
    setTransport(fake.transport);
    const id = (await post('/api/orders', { coin: 'XMR' })).json().id;
    orders.get(id)!.nextPollAt = 0;
    await pollDue();
    expect(fake.calls.filter((c) => c.method === 'emergency')).toHaveLength(0);
    const view = (await get(`/api/orders/${id}`)).json();
    expect(view).toMatchObject({ stage: 'attention', autoRefundError: expect.stringMatching(/Monero doesn't show who paid/) });
    // The owner can refund to a Monero address by hand.
    const to = xmrAddress('Refund', '4');
    const ok = await post(`/api/orders/${id}/refund`, { address: to, password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(fake.calls.find((c) => c.method === 'emergency')!.body).toMatchObject({ choice: 'REFUND', address: to });
  });
});

describe('checking what FixedFloat created', () => {
  const vault = xmrAddress('Vault');
  const order = (over: Parameters<typeof ffOrder>[0]) => ffOrder({ coin: 'BTC', toCode: 'XMR', payout: vault, ...over }) as never;

  it('accepts an order that pays Monero to exactly our own subaddress', () => {
    expect(() => checkCreated(order({}), 'BTC', { toCcy: 'XMR', toAddress: vault, label: 'Monero vault' })).not.toThrow();
  });

  it('refuses anything else', () => {
    const want = { toCcy: 'XMR' as const, toAddress: vault, label: 'Monero vault' };
    expect(() => checkCreated(order({ payout: xmrAddress('Other') }), 'BTC', want)).toThrow(/not your Monero vault address/);
    expect(() => checkCreated(order({ toCode: 'USDT', payout: vault }), 'BTC', want)).toThrow(/instead of Monero/);
    expect(() => checkCreated(order({ coin: 'ETH' }), 'BTC', want)).toThrow(/expects ETH instead of BTC/);
    expect(() => checkCreated(order({ type: 'fixed' }), 'BTC', want)).toThrow(/not a float-rate order/);
    expect(() => checkCreated(ffOrder({ toNetwork: 'BSC' }) as never, 'ETH')).toThrow(/instead of USDC on Base/);
  });
});
