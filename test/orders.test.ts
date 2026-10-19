import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAYOUT, PAYOUT_USDT, fakeFixedFloat, ffOrder, priceAnswer } from './helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-orders-'));
process.env.DATA_DIR = dataDir;
process.env.APP_PASSWORD = 'correct horse battery staple';
process.env.FF_API_KEY = 'test-key';
process.env.FF_API_SECRET = 'test-secret';
delete process.env.ALLOWED_HOSTS;

const { buildApp } = await import('../server/app.js');
const { setTransport } = await import('../server/fixedfloat.js');
const { emergencyAction, orders, pollDue, refundOrder, stageOf, watchChain } = await import('../server/orders.js');
const { fromBase, setChainFetch, toBase } = await import('../server/chain.js');

const SENDER = '0xe5b787cf9a4d383230ec88363a6c721dce27e504';
const BTC_PAYER = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

/**
 * A fake blockchain: two Ethereum RPCs and two Esplora APIs (mempool.space, blockstream). Tests set
 * fields on `chain` to describe the deposit transaction and the address totals.
 */
interface ChainState {
  from: string;
  to: string;
  value: bigint;
  code: string;
  nonce: string;
  /** Second RPC answers with a different sender. */
  disagree: boolean;
  /** RPCs/APIs answer HTTP 503. */
  down: boolean;
  /** Address totals returned by successive balance lookups (last one repeats). */
  totals: bigint[];
  btcInputs: string[];
  btcOutputs: { scriptpubkey_address: string; value: number }[];
}
let chain: ChainState;
const calls: string[] = [];
function resetChain() {
  chain = { from: SENDER, to: '', value: 0n, code: '0x', nonce: '0x76', disagree: false, down: false, totals: [0n], btcInputs: [BTC_PAYER], btcOutputs: [] };
  calls.length = 0;
  setChainFetch(async (url, init) => {
    if (chain.down) return new Response('busy', { status: 503 });
    const total = () => (chain.totals.length > 1 ? chain.totals.shift()! : chain.totals[0]);
    if (url.includes('/address/')) {
      calls.push('btc-address');
      return new Response(JSON.stringify({ chain_stats: { funded_txo_sum: 0 }, mempool_stats: { funded_txo_sum: Number(total()) } }));
    }
    if (url.includes('/tx/')) {
      calls.push(`btc-tx ${new URL(url).host}`);
      return new Response(JSON.stringify({ vin: chain.btcInputs.map((a) => ({ prevout: { scriptpubkey_address: a } })), vout: chain.btcOutputs }));
    }
    const { method } = JSON.parse(String(init?.body));
    calls.push(method);
    const second = url.includes('drpc');
    const result =
      method === 'eth_getTransactionByHash'
        ? { from: chain.disagree && second ? '0x0000000000000000000000000000000000000bad' : chain.from, to: chain.to, value: '0x' + chain.value.toString(16) }
        : method === 'eth_getCode'
          ? chain.code
          : method === 'eth_getBalance'
            ? '0x' + total().toString(16)
            : chain.nonce;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
}

let app: FastifyInstance;
let cookie = '';
const H = { host: 'wallet.test', 'x-wallet': '1', 'content-type': 'application/json' };
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { ...H, cookie, ...headers }, payload: JSON.stringify(body) });
const get = (url: string) => app.inject({ url, headers: { host: 'wallet.test', cookie } });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const res = await post('/api/login', { password: 'correct horse battery staple' });
  expect(res.statusCode).toBe(200);
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
beforeEach(() => {
  fs.rmSync(path.join(dataDir, 'orders.json'), { force: true }); // each test starts with no orders
  orders.reset();
  resetChain();
});
afterAll(async () => {
  setTransport(null);
  setChainFetch(null);
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('creating an address', () => {
  it('always pays out to the Coinbase address, whatever the browser sends', async () => {
    const fake = fakeFixedFloat({
      price: (b) => priceAnswer(b.fromCcy as 'ETH'),
      create: (b) => ffOrder({ coin: b.fromCcy as 'ETH', payout: String(b.toAddress) }),
    });
    setTransport(fake.transport);
    const res = await post('/api/orders', { coin: 'ETH', toAddress: '0x000000000000000000000000000000000000dEaD', payoutAddress: '0xdead' });
    expect(res.statusCode).toBe(200);
    const create = fake.calls.find((c) => c.method === 'create')!;
    expect(create.body).toMatchObject({ type: 'float', fromCcy: 'ETH', toCcy: 'USDCBASE', direction: 'from', toAddress: PAYOUT });
    expect(create.body.amount).toBe(0.015); // 3 x the 0.005 minimum: nominal, any amount above the minimum swaps
    const view = res.json();
    expect(view).toMatchObject({ coin: 'ETH', stage: 'waiting', payoutAddress: PAYOUT, min: '0.005', minUsd: 12.72 });
    expect(view.address).toMatch(/^0x/);
  });

  it('never sends the FixedFloat token to the browser', async () => {
    setTransport(fakeFixedFloat({ price: () => priceAnswer('BTC'), create: () => ffOrder({ coin: 'BTC' }) }).transport);
    const created = await post('/api/orders', { coin: 'BTC' });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toMatch(/SECRET|token/i);
    expect((await get('/api/orders')).body).not.toMatch(/SECRET|token/i);
    expect((await get(`/api/orders/${created.json().id}`)).body).not.toMatch(/SECRET|token/i);
    // ...but the server keeps it to talk to FixedFloat later.
    expect(orders.get(created.json().id)?.token).toMatch(/SECRET/);
  });

  it('gives a different address on every click', async () => {
    setTransport(fakeFixedFloat({ price: (b) => priceAnswer(b.fromCcy as 'ETH'), create: (b) => ffOrder({ coin: b.fromCcy as 'ETH' }) }).transport);
    const a = (await post('/api/orders', { coin: 'ETH' })).json();
    const b = (await post('/api/orders', { coin: 'ETH' })).json();
    expect(a.address).not.toBe(b.address);
    expect(a.reusedAddress || b.reusedAddress).toBe(false);
  });

  it('flags it if FixedFloat ever hands out the same address twice', async () => {
    setTransport(fakeFixedFloat({ price: () => priceAnswer('ETH'), create: () => ffOrder({ address: '0x1111111111111111111111111111111111111111' }) }).transport);
    expect((await post('/api/orders', { coin: 'ETH' })).json().reusedAddress).toBe(false);
    expect((await post('/api/orders', { coin: 'ETH' })).json().reusedAddress).toBe(true);
  });

  it('refuses an order that would pay out anywhere else', async () => {
    setTransport(fakeFixedFloat({ price: () => priceAnswer('ETH'), create: () => ffOrder({ payout: '0x000000000000000000000000000000000000dEaD' }) }).transport);
    const before = orders.all().length;
    const res = await post('/api/orders', { coin: 'ETH' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/payout address is not your Coinbase \(USDC on Base\) address/);
    expect(orders.all().length).toBe(before); // nothing stored, no address shown
  });

  it('refuses an order that pays out the wrong token', async () => {
    setTransport(fakeFixedFloat({ price: () => priceAnswer('ETH'), create: () => ffOrder({ toCode: 'USDTTRC' }) }).transport);
    const res = await post('/api/orders', { coin: 'ETH' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/instead of USDC on Base/);
    // The old payout, USDT on Ethereum, is refused too: it isn't what we asked for.
    setTransport(fakeFixedFloat({ price: () => priceAnswer('ETH'), create: () => ffOrder({ toCode: 'USDT', payout: PAYOUT_USDT }) }).transport);
    expect((await post('/api/orders', { coin: 'ETH' })).json().error).toMatch(/instead of USDC on Base/);
  });

  it('explains when FixedFloat has the coin paused', async () => {
    setTransport(fakeFixedFloat({ price: () => ({ ...priceAnswer('BTC'), errors: ['MAINTENANCE_FROM'] }) }).transport);
    const res = await post('/api/orders', { coin: 'BTC' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Bitcoin deposits paused/);
  });

  it('rejects unknown coins and caps clicks at three a minute', async () => {
    setTransport(fakeFixedFloat({ price: (b) => priceAnswer(b.fromCcy as 'ETH'), create: (b) => ffOrder({ coin: b.fromCcy as 'ETH' }) }).transport);
    expect((await post('/api/orders', { coin: 'DOGE' })).statusCode).toBe(400);
    for (let i = 0; i < 3; i++) expect((await post('/api/orders', { coin: 'ETH' })).statusCode).toBe(200);
    expect((await post('/api/orders', { coin: 'ETH' })).statusCode).toBe(429);
  });

  it('needs a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/orders', headers: H, payload: '{"coin":"ETH"}' });
    expect(res.statusCode).toBe(401);
  });
});

describe('following an order', () => {
  type O = Parameters<typeof stageOf>[0];
  const o = (over: Parameters<typeof ffOrder>[0]) => ffOrder(over) as unknown as O;
  const em = (status: string[], repeat = '0') => ({ status, choice: 'NONE', repeat });

  it('maps FixedFloat statuses to the animation stages', () => {
    expect(stageOf(o({ status: 'NEW' }))).toBe('waiting');
    expect(stageOf(o({ status: 'PENDING', fromTx: { id: '0xabc', amount: '0.02' } }))).toBe('received');
    expect(stageOf(o({ status: 'EXCHANGE' }))).toBe('swapping');
    expect(stageOf(o({ status: 'WITHDRAW' }))).toBe('sending');
    expect(stageOf(o({ status: 'DONE', toTx: { id: '0xpayout', amount: '50.1' } }))).toBe('done');
    expect(stageOf(o({ status: 'EXPIRED' }))).toBe('expired');
    expect(stageOf(o({ status: 'EMERGENCY', emergency: em(['EXPIRED']) }))).toBe('received');
    expect(stageOf(o({ status: 'EMERGENCY', emergency: { status: ['EXPIRED'], choice: 'EXCHANGE', repeat: '0' } }))).toBe('swapping');
    expect(stageOf(o({ status: 'EMERGENCY', emergency: em(['LESS', 'LIMIT']) }))).toBe('attention');
  });

  it('continues late or odd-sized payments, refunds below-minimum ones, leaves big ones to the owner', () => {
    const e = (status: string[], repeat = '0') => o({ status: 'EMERGENCY', emergency: em(status, repeat) });
    expect(emergencyAction(e(['EXPIRED']))).toBe('continue');
    expect(emergencyAction(e(['LESS']))).toBe('continue');
    expect(emergencyAction(e(['MORE']))).toBe('continue');
    expect(emergencyAction(e([], '1'))).toBe('continue');
    expect(emergencyAction(e(['LESS', 'LIMIT']))).toBe('refund');
    expect(emergencyAction(e(['MORE', 'LIMIT']))).toBe('attention'); // above the maximum: a human decides
    expect(emergencyAction(e([]))).toBe('attention');
    expect(emergencyAction(o({ status: 'PENDING' }))).toBeNull();
  });

  async function createThenAnswer(order: (b: Record<string, unknown>) => unknown, coin: 'ETH' | 'BTC' = 'ETH') {
    let created: ReturnType<typeof ffOrder> | null = null;
    const fake = fakeFixedFloat({
      price: () => priceAnswer(coin),
      create: () => (created = ffOrder({ coin })),
      order: (b) => {
        const next = order(b) as ReturnType<typeof ffOrder>;
        return { ...next, id: created!.id, from: { ...next.from, address: created!.from.address } };
      },
      emergency: () => true,
    });
    setTransport(fake.transport);
    const view = (await post('/api/orders', { coin })).json();
    const rec = orders.get(view.id)!;
    rec.nextPollAt = 0;
    return { fake, rec, view };
  }
  const tooSmall = (amount = '0.00236244') => () => ffOrder({ status: 'EMERGENCY', fromTx: { id: '0xtiny', amount }, emergency: em(['LESS', 'LIMIT']) });
  const answers = (fake: { calls: { method: string; body: Record<string, unknown> }[] }) => fake.calls.filter((c) => c.method === 'emergency').map((c) => c.body);
  const view = async (id: string) => (await get(`/api/orders/${id}`)).json();
  const again = async (rec: { nextPollAt: number }) => {
    rec.nextPollAt = 0;
    await pollDue();
  };

  it('tells FixedFloat to continue a late payment exactly once', async () => {
    const { fake, rec } = await createThenAnswer(() => ffOrder({ status: 'EMERGENCY', fromTx: { id: '0xlate', amount: '0.02', confirmations: 4 }, emergency: em(['EXPIRED']) }));
    await pollDue();
    await again(rec); // FixedFloat still says NONE a moment later: don't spam it
    expect(answers(fake)).toEqual([{ id: rec.id, token: rec.token, choice: 'EXCHANGE' }]);
    expect(await view(rec.id)).toMatchObject({ stage: 'swapping', received: '0.02', autoContinued: true });
  });

  it('keeps retrying "continue" while FixedFloat errors, instead of giving up', async () => {
    let fail = 3;
    const fake = fakeFixedFloat({
      price: () => priceAnswer('ETH'),
      create: () => ffOrder({ coin: 'ETH' }),
      order: () => ffOrder({ status: 'EMERGENCY', fromTx: { id: '0xlate', amount: '0.02' }, emergency: em(['EXPIRED']) }),
      emergency: () => {
        if (fail-- > 0) throw { code: 500, msg: 'Temporary error' };
        return true;
      },
    });
    setTransport(fake.transport);
    const rec = orders.get((await post('/api/orders', { coin: 'ETH' })).json().id)!;
    for (let i = 0; i < 4; i++) {
      rec.auto.nextAt = 0;
      await again(rec);
    }
    expect(answers(fake)).toHaveLength(4); // three failures, then it went through
    expect(rec.auto.sentAt).not.toBeNull();
    expect(rec.auto.error).toBeNull();
  });

  it('sends a below-minimum payment straight back to the wallet it came from, once', async () => {
    const { fake, rec } = await createThenAnswer(tooSmall());
    Object.assign(chain, { to: rec.depositAddress, value: toBase('0.00236244', 18)! });
    await pollDue();
    await again(rec);
    expect(calls.filter((c) => c === 'eth_getTransactionByHash')).toHaveLength(2); // asked two RPCs
    expect(answers(fake)).toEqual([{ id: rec.id, token: rec.token, choice: 'REFUND', address: SENDER }]);
    expect(await view(rec.id)).toMatchObject({ stage: 'refunded', refundTo: SENDER, refundSource: 'sender', autoRefundError: null });
  });

  it('never auto-refunds when it is not clearly one ordinary wallet paying directly', async () => {
    const cases: [string, Partial<ChainState>][] = [
      ['a contract', { code: '0x6080604052' }],
      ['an exchange hot wallet', { nonce: '0x1e8480' }],
      ['a smart wallet (the transaction went to some contract)', { to: '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789' }],
      ['the two RPCs disagree', { disagree: true }],
      ['the amount does not match', { value: toBase('0.5', 18)! }],
    ];
    for (const [label, patch] of cases) {
      orders.reset();
      resetChain();
      const { fake, rec } = await createThenAnswer(tooSmall());
      Object.assign(chain, { to: rec.depositAddress, value: toBase('0.00236244', 18)! }, patch.to ? {} : {}, patch);
      if (patch.to) chain.to = patch.to;
      await pollDue();
      expect(answers(fake), label).toHaveLength(0);
      expect(await view(rec.id), label).toMatchObject({ stage: 'attention', autoRefundError: expect.stringMatching(/ordinary wallet/) });
    }
  });

  it('treats a public endpoint outage as temporary: retries later rather than giving up', async () => {
    const { fake, rec } = await createThenAnswer(tooSmall());
    Object.assign(chain, { to: rec.depositAddress, value: toBase('0.00236244', 18)!, down: true });
    await pollDue();
    expect(answers(fake)).toHaveLength(0);
    let v = await view(rec.id);
    expect(v.autoRefundError).toBeNull(); // no manual form: it is still trying
    expect(v.refundRetry).toMatch(/Retrying/);
    chain.down = false;
    rec.autoRefund!.nextAt = 0;
    await again(rec);
    expect(answers(fake)).toEqual([{ id: rec.id, token: rec.token, choice: 'REFUND', address: SENDER }]);
    v = await view(rec.id);
    expect(v.stage).toBe('refunded');
  });

  it('hands over to the owner when FixedFloat refuses the automatic refund', async () => {
    let created: ReturnType<typeof ffOrder> | null = null;
    const fake = fakeFixedFloat({
      price: () => priceAnswer('ETH'),
      create: () => (created = ffOrder({ coin: 'ETH' })),
      order: () => ({ ...tooSmall()(), id: created!.id, from: { ...tooSmall()().from, address: created!.from.address } }),
      emergency: () => {
        throw { code: 409, msg: 'Invalid refund address' };
      },
    });
    setTransport(fake.transport);
    const rec = orders.get((await post('/api/orders', { coin: 'ETH' })).json().id)!;
    Object.assign(chain, { to: rec.depositAddress, value: toBase('0.00236244', 18)! });
    rec.nextPollAt = 0;
    await pollDue();
    await again(rec);
    expect(answers(fake)).toHaveLength(1); // refused once: no point retrying
    expect(await view(rec.id)).toMatchObject({ stage: 'attention', autoRefundError: expect.stringMatching(/refused the automatic refund.*Invalid refund address/) });
  });

  it('shows the owner the form after a few temporary failures, while still retrying', async () => {
    const { rec } = await createThenAnswer(tooSmall());
    Object.assign(chain, { to: rec.depositAddress, value: toBase('0.00236244', 18)!, down: true });
    for (let i = 0; i < 3; i++) {
      if (rec.autoRefund) rec.autoRefund.nextAt = 0;
      await again(rec);
    }
    const v = await view(rec.id);
    expect(v.autoRefundError).toMatch(/keeps trying, or enter an address/);
    expect(rec.autoRefund?.gaveUp).toBe(false);
  });

  it('still spots a payment after earlier funds were swept out of the address', async () => {
    const { rec } = await createThenAnswer(() => ffOrder({ status: 'NEW' }));
    chain.totals = [toBase('0.1', 18)!, 0n, toBase('0.05', 18)!];
    await watchChain(); // baseline 0.1
    rec.chainNextAt = 0;
    await watchChain(); // swept to 0: baseline drops
    rec.chainNextAt = 0;
    await watchChain(); // a new 0.05 arrives
    expect(await view(rec.id)).toMatchObject({ stage: 'received', received: '0.05' });
  });

  it('sends Bitcoin back only when one address clearly paid the exact amount', async () => {
    const btcTooSmall = () => ffOrder({ coin: 'BTC', status: 'EMERGENCY', fromTx: { id: 'ab12', amount: '0.00005' }, emergency: em(['LESS', 'LIMIT']) });
    let { fake, rec } = await createThenAnswer(btcTooSmall, 'BTC');
    chain.btcOutputs = [{ scriptpubkey_address: rec.depositAddress, value: 5000 }, { scriptpubkey_address: BTC_PAYER, value: 1234 }];
    await pollDue();
    expect(calls.filter((c) => c.startsWith('btc-tx'))).toEqual(['btc-tx mempool.space', 'btc-tx blockstream.info']);
    expect(answers(fake)[0]).toMatchObject({ choice: 'REFUND', address: BTC_PAYER });

    orders.reset();
    resetChain();
    ({ fake, rec } = await createThenAnswer(btcTooSmall, 'BTC'));
    chain.btcInputs = [BTC_PAYER, 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'];
    chain.btcOutputs = [{ scriptpubkey_address: rec.depositAddress, value: 5000 }];
    await pollDue();
    expect(answers(fake)).toHaveLength(0);
  });

  it('leaves payments above the maximum to the owner (no automatic answer)', async () => {
    const { fake, rec } = await createThenAnswer(() => ffOrder({ status: 'EMERGENCY', fromTx: { id: '0xbig', amount: '60' }, emergency: em(['MORE', 'LIMIT']) }));
    await pollDue();
    expect(answers(fake)).toHaveLength(0);
    expect((await view(rec.id)).stage).toBe('attention');
  });

  it('lets the owner refund by hand (password + valid address) when it could not go back automatically', async () => {
    const { fake, rec } = await createThenAnswer(tooSmall());
    Object.assign(chain, { to: rec.depositAddress, value: toBase('0.00236244', 18)!, code: '0x60806040' });
    await pollDue();
    const to = '0x52908400098527886E0F7030069857D2E4169EE7';
    expect((await post(`/api/orders/${rec.id}/refund`, { address: to, password: 'wrong password!' })).statusCode).toBe(401);
    expect((await post(`/api/orders/${rec.id}/refund`, { address: 'not-an-address', password: 'correct horse battery staple' })).statusCode).toBe(400);
    const ok = await post(`/api/orders/${rec.id}/refund`, { address: to, password: 'correct horse battery staple' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ stage: 'refunded', refundTo: to, refundSource: 'manual' });
    expect(answers(fake)).toEqual([{ id: rec.id, token: rec.token, choice: 'REFUND', address: to }]);
    // A second refund for the same payment is refused.
    await expect(refundOrder(rec, to)).rejects.toThrow();
  });

  it('starts over when a new deposit arrives on the same order', async () => {
    let txid = '0xfirst';
    const { fake, rec } = await createThenAnswer(() => ffOrder({ status: 'EMERGENCY', fromTx: { id: txid, amount: '0.02' }, emergency: em(['EXPIRED']) }));
    await pollDue();
    expect(rec.auto.forTx).toBe('0xfirst');
    txid = '0xsecond';
    await again(rec); // within the 2-minute grace for the first answer, but it's a different payment
    expect(answers(fake)).toHaveLength(2);
    expect(rec.auto.forTx).toBe('0xsecond');
  });

  it('rings as soon as an ETH payment shows up on-chain, counting only new money', async () => {
    const { rec } = await createThenAnswer(() => ffOrder({ status: 'NEW' }));
    // The address already held 0.5 ETH when we started watching (e.g. reused by FixedFloat): it must not ring.
    chain.totals = [toBase('0.5', 18)!, toBase('0.5', 18)!, toBase('0.506', 18)!];
    await watchChain(); // baseline
    expect((await view(rec.id)).stage).toBe('waiting');
    rec.chainNextAt = 0;
    await watchChain(); // nothing new
    expect((await view(rec.id)).stage).toBe('waiting');
    rec.chainNextAt = 0;
    await watchChain(); // +0.006
    expect(await view(rec.id)).toMatchObject({ stage: 'received', received: '0.006', confirmations: 0 });
    expect(rec.nextPollAt).toBeLessThanOrEqual(Date.now()); // and FixedFloat gets asked right away
  });

  it('spots a Bitcoin payment while it is still in the mempool', async () => {
    const { rec } = await createThenAnswer(() => ffOrder({ coin: 'BTC', status: 'NEW' }), 'BTC');
    chain.totals = [0n, 150_000n];
    await watchChain();
    rec.chainNextAt = 0;
    await watchChain();
    expect(await view(rec.id)).toMatchObject({ stage: 'received', received: '0.0015' });
  });

  it('stops trusting its own sighting after an hour if FixedFloat never saw the payment', async () => {
    const { rec } = await createThenAnswer(() => ffOrder({ status: 'NEW' }));
    rec.seen = { at: Date.now() - 2 * 60 * 60 * 1000, amount: '0.01' };
    expect((await view(rec.id)).stage).toBe('waiting');
  });

  it('leaves reused addresses to FixedFloat', async () => {
    const { rec } = await createThenAnswer(() => ffOrder({ status: 'NEW' }));
    rec.reusedAddress = true;
    await watchChain();
    expect(calls.filter((c) => c === 'eth_getBalance')).toHaveLength(0);
  });

  it('converts base units exactly', () => {
    expect(fromBase(6_000_000_000_000_000n, 18)).toBe('0.006');
    expect(fromBase(150_000n, 8)).toBe('0.0015');
    expect(fromBase(100_000_000n, 8)).toBe('1');
    expect(fromBase(1n, 18)).toBe('0.000000000000000001');
    expect(toBase('0.00236244', 18)).toBe(2_362_440_000_000_000n);
    expect(toBase('1', 8)).toBe(100_000_000n);
    expect(toBase('abc', 8)).toBeNull();
  });

  it('shows the confirmed USDC amount and Basescan payout link when done', async () => {
    const { rec } = await createThenAnswer(() => ffOrder({ status: 'DONE', fromTx: { id: '0xin', amount: '0.0213', confirmations: 12 }, toTx: { id: '0xout', amount: '53.77' } }));
    await pollDue();
    expect(await view(rec.id)).toMatchObject({ stage: 'done', received: '0.0213', usdt: '53.77', usdtFinal: true, toCcy: 'USDCBASE', payoutTxUrl: 'https://basescan.org/tx/0xout' });
  });

  it('works out roughly what the swap cost once it is done: dollar value in minus USDT out', async () => {
    let status = 'EXCHANGE';
    const { rec } = await createThenAnswer(() =>
      ffOrder({ status, fromTx: { id: '0xin', amount: '0.0213', confirmations: 12 }, toTx: status === 'DONE' ? { id: '0xout', amount: '53.77' } : {} }),
    );
    await pollDue();
    expect((await view(rec.id)).cost).toBeNull(); // not done yet
    expect(rec.prices).toMatchObject({ from: 127.16 / 0.05, to: 1 }); // noted when the exchange started
    status = 'DONE';
    await again(rec);
    // 0.0213 ETH at $2,543.20 = $54.17 in, 53.77 USDT out.
    expect((await view(rec.id)).cost).toEqual({ usd: 0.4, pct: 0.7, inUsd: 54.17 });
  });

  it('only shows a USDT estimate when the payment matches the order amount', async () => {
    const { rec } = await createThenAnswer(() => ffOrder({ status: 'PENDING', fromTx: { id: '0xin', amount: '0.0213' } }));
    await pollDue();
    expect((await view(rec.id)).usdt).toBeNull(); // 0.0213 sent vs 0.015 nominal: estimate would be wrong
  });

  it('always lists unfinished transfers for the browser, even old ones', async () => {
    const { rec: busy } = await createThenAnswer(() => ffOrder({ status: 'EXCHANGE', fromTx: { id: '0xa', amount: '0.02' } }));
    await pollDue();
    setTransport(fakeFixedFloat({ price: () => priceAnswer('ETH'), create: () => ffOrder({ coin: 'ETH' }) }).transport);
    orders.reset(); // clear the create throttle (orders reload from disk)
    await post('/api/orders', { coin: 'ETH' });
    await post('/api/orders', { coin: 'ETH' });
    const ids = orders.forBrowser(1).map((r) => r.id);
    expect(ids).toContain(busy.id); // older than the newest one, but still in flight
    expect(ids).toHaveLength(2);
  });
});
