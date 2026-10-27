import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAYOUT, btcAddress, fakeFixedFloat, ffOrder, priceAnswer } from './helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-providers-'));
process.env.DATA_DIR = dataDir;
process.env.APP_PASSWORD = 'correct horse battery staple';
process.env.FF_API_KEY = 'test-key';
process.env.FF_API_SECRET = 'test-secret';
process.env.SWAP_FALLBACKS = 'swapzone,cyphergoat';
process.env.SWAPZONE_API_KEY = 'sz-test-key';
process.env.CYPHERGOAT_API_KEY = 'cg-test-key';
delete process.env.PRIVACY_TEST_DELAY_MIN;

const { config } = await import('../server/config.js');
const { setTransport } = await import('../server/fixedfloat.js');
const { setProviderTransport } = await import('../server/providers/http.js');
const { resetSwapzone, swapzone } = await import('../server/providers/swapzone.js');
const { createOrder, limits, openSwap, orderView, orders, pairBusy, pollDue, refundOrder } = await import('../server/orders.js');
const { SwapApiError } = await import('../server/providers/types.js');

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// ---------------------------------------------------------------- fakes

const SZ = 'https://api.swapzone.io/v1';
const CG = 'https://api.cyphergoat.com';

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/** A fake Swapzone and a fake CypherGoat behind one transport. Tests change `sz` and `cg` to describe what they answer. */
const sz = {
  down: false,
  payout: PAYOUT,
  status: 'waiting',
  deposit: btcAddress('sz-1'),
  quotes: [
    { adapter: 'changenow', amountFrom: 0.001, amountTo: 80, quotaId: 'q-cn', minAmount: 0.0002, maxAmount: 5, open_fincases: '' },
    { adapter: 'fixedfloat', amountFrom: 0.001, amountTo: 83, quotaId: 'q-ff', minAmount: 0.0002, maxAmount: 5, open_fincases: '' },
    { adapter: 'sketchy', amountFrom: 0.001, amountTo: 90, quotaId: 'q-sk', minAmount: 0.0002, maxAmount: 5, open_fincases: 'yes' },
  ] as Record<string, unknown>[],
  payoutHash: null as string | null,
};
const cg = {
  down: false,
  payout: PAYOUT,
  status: 'waiting',
  deposit: btcAddress('cg-1'),
  results: [
    { Exchange: 'exolix', Amount: 70, KYCScore: 0 },
    { Exchange: 'fixedfloat', Amount: 75, KYCScore: 2 },
    { Exchange: 'simpleswap', Amount: 99, KYCScore: 3 },
  ],
};
const calls: Call[] = [];

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

setProviderTransport(async (url, init) => {
  const u = new URL(url);
  const call: Call = {
    method: String(init.method),
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    headers: init.headers as Record<string, string>,
  };
  calls.push(call);

  if (url.startsWith(SZ)) {
    if (sz.down) return reply({ error: 'down' }, 503);
    const p = u.pathname.replace('/v1', '');
    if (p === '/exchange/currencies') {
      return reply([
        { name: 'Bitcoin', ticker: 'btc', network: 'BTC' },
        { name: 'Ethereum', ticker: 'eth', network: 'ETH' },
        { name: 'Monero', ticker: 'xmr', network: 'XMR' },
        { name: 'USD Coin', ticker: 'usdc', network: 'ETH' },
        { name: 'USD Coin (Base)', ticker: 'usdc', network: 'BASE' },
      ]);
    }
    if (p === '/exchange/get-rate') return reply(sz.quotes);
    const tx = (over: Record<string, unknown> = {}) => ({
      id: '64abc0ffee',
      from: 'btc',
      fromNetwork: 'BTC',
      to: 'usdc',
      toNetwork: 'BASE',
      status: sz.status,
      addressReceive: sz.payout,
      addressDeposit: sz.deposit,
      amountDeposit: '0.0006',
      amountEstimated: '49.5',
      amountRealReceive: sz.status === 'finished' ? '49.2' : null,
      payinHash: sz.status === 'waiting' ? null : 'szpayin',
      payoutHash: sz.payoutHash,
      createdAt: new Date().toISOString(),
      payTill: new Date(Date.now() + 1_800_000).toISOString(),
      ...over,
    });
    if (p === '/exchange/create') return reply({ transaction: tx({ refundAddress: call.body?.refundAddress ?? '' }) });
    if (p === '/exchange/tx') return reply({ transaction: tx() });
  }

  if (url.startsWith(CG)) {
    if (cg.down) return reply({ error: 'down' }, 503);
    if (u.pathname === '/estimate') return reply({ rates: { Results: cg.results, Min: 0.0002, EstimateId: 9 }, min: 0.0002 });
    const tx = () => ({
      Id: 'tok-1',
      CGID: 'CG123',
      Address: cg.deposit,
      DestinationAddress: cg.payout,
      Provider: 'exolix',
      Status: cg.status,
      Coin1: 'btc',
      Network1: 'btc',
      Coin2: 'usdc',
      Network2: 'base',
      SendAmount: 0.0006,
      EstimateAmount: 49,
      CreatedAt: new Date().toISOString(),
    });
    if (u.pathname === '/swap' || u.pathname === '/transaction') return reply({ transaction: tx() });
  }
  return reply({ error: 'no fake' }, 404);
});

/** FixedFloat: healthy unless a test says otherwise. */
const ffState = { createError: null as { code: number; msg: string } | null, priceErrors: [] as string[] };
function fixedFloat() {
  const fake = fakeFixedFloat({
    price: () => ({ ...priceAnswer('BTC'), errors: ffState.priceErrors }),
    create: () => {
      if (ffState.createError) throw ffState.createError;
      return ffOrder({ coin: 'BTC' });
    },
    order: () => ffOrder({ coin: 'BTC', status: 'NEW' }),
  });
  setTransport(fake.transport);
  return fake;
}

const only = (...names: string[]) => (config.swapFallbacks = names);
const callsTo = (prefix: string) => calls.filter((c) => (prefix === 'sz' ? c.path.startsWith('/v1') : !c.path.startsWith('/v1')));

beforeEach(() => {
  fs.rmSync(path.join(dataDir, 'orders.json'), { force: true });
  orders.reset();
  resetSwapzone();
  calls.length = 0;
  ffState.createError = null;
  ffState.priceErrors = [];
  Object.assign(sz, { down: false, payout: PAYOUT, status: 'waiting', deposit: btcAddress('sz-1'), payoutHash: null });
  Object.assign(cg, { down: false, payout: PAYOUT, status: 'waiting', deposit: btcAddress('cg-1') });
  only('swapzone', 'cyphergoat');
});
afterEach(() => setTransport(null));

// ---------------------------------------------------------------- the default: FixedFloat only

describe('FixedFloat stays the primary', () => {
  it('uses only FixedFloat while it works, even with fallbacks configured', async () => {
    const ff = fixedFloat();
    const r = await createOrder('BTC');
    expect(r.provider).toBeUndefined();
    expect(r.id).toMatch(/^ORD/);
    expect(callsTo('sz')).toHaveLength(0);
    expect(callsTo('cg')).toHaveLength(0);
    expect(ff.calls.map((c) => c.method)).toEqual(['price', 'create']);
    expect(orderView(r)).toMatchObject({ provider: 'fixedfloat', exchange: 'fixedfloat' });
  });

  it('behaves exactly as before when no fallback is listed: its own error comes back, nothing else is called', async () => {
    only();
    ffState.createError = { code: 503, msg: 'maintenance' };
    fixedFloat();
    await expect(createOrder('BTC')).rejects.toThrow('FixedFloat: maintenance');
    expect(calls).toHaveLength(0);
  });

  it('ignores a fallback that is listed but has no key', async () => {
    const saved = config.swapzone.apiKey;
    config.swapzone.apiKey = '';
    try {
      only('swapzone');
      ffState.createError = { code: 503, msg: 'maintenance' };
      fixedFloat();
      await expect(createOrder('BTC')).rejects.toThrow('FixedFloat: maintenance');
      expect(calls).toHaveLength(0);
    } finally {
      config.swapzone.apiKey = saved;
    }
  });

  it('does not use a fallback when FixedFloat refuses the request itself', async () => {
    ffState.createError = { code: 301, msg: 'Invalid address' };
    fixedFloat();
    await expect(createOrder('BTC')).rejects.toThrow('FixedFloat: Invalid address');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- falling back

describe('a fresh address when FixedFloat is down', () => {
  it('goes to Swapzone: the best clean quote, no refund address, checked against what it answered', async () => {
    ffState.createError = { code: 503, msg: 'maintenance' };
    fixedFloat();
    const r = await createOrder('BTC');
    expect(r).toMatchObject({ provider: 'swapzone', nativeId: '64abc0ffee', exchange: 'fixedfloat', depositAddress: sz.deposit, toAddress: PAYOUT });
    expect(r.id).toBe('sz_64abc0ffee');
    expect(r.token).toBe('');

    const create = calls.find((c) => c.path.endsWith('/exchange/create'))!;
    expect(create.headers['x-api-key']).toBe('sz-test-key');
    // The quote with open financial claims is skipped; the best clean one is used.
    expect(create.body).toMatchObject({ from: 'btc', fromNetwork: 'BTC', to: 'usdc', toNetwork: 'BASE', addressReceive: PAYOUT, quotaId: 'q-ff', noRefundAddress: true });
    expect(create.body).not.toHaveProperty('refundAddress');
    const rate = calls.filter((c) => c.path.endsWith('/exchange/get-rate')).pop()!; // the one made for the order
    expect(rate.query).toMatchObject({ rateType: 'floating', chooseRate: 'all', noRefundAddress: 'true' });
    expect(orderView(r)).toMatchObject({ provider: 'swapzone', exchange: 'fixedfloat', stage: 'waiting', address: sz.deposit, payoutAddress: PAYOUT });
  });

  it('also goes there when FixedFloat has the pair paused', async () => {
    ffState.priceErrors = ['MAINTENANCE_FROM'];
    fixedFloat();
    const r = await createOrder('BTC');
    expect(r.provider).toBe('swapzone');
    expect(await limits('BTC', 'USDCBASE')).toMatchObject({ provider: 'swapzone', min: 0.0002 });
  });

  it('refuses a Swapzone order that pays somewhere else, and tries CypherGoat', async () => {
    ffState.createError = { code: 503, msg: 'maintenance' };
    fixedFloat();
    sz.payout = '0x1111111111111111111111111111111111111111';
    const r = await createOrder('BTC');
    expect(r).toMatchObject({ provider: 'cyphergoat', nativeId: 'CG123', exchange: 'exolix', depositAddress: cg.deposit });
    expect(r.id).toBe('cg_CG123');
    const swap = calls.find((c) => c.path === '/swap')!;
    expect(swap.headers.authorization).toBe('Bearer cg-test-key');
    // Exchanges with a KYC score above the limit are not picked; of the rest, the best.
    expect(swap.query).toMatchObject({ coin1: 'btc', network1: 'btc', coin2: 'usdc', network2: 'base', partner: 'fixedfloat', address: PAYOUT, estimateid: '9' });
  });

  it("gives FixedFloat's own error when the fallbacks can't help either", async () => {
    ffState.createError = { code: 503, msg: 'maintenance' };
    fixedFloat();
    sz.down = true;
    cg.down = true;
    await expect(createOrder('BTC')).rejects.toThrow('FixedFloat: maintenance');
  });

  it("doesn't pick an unknown asset network: a coin Swapzone doesn't list is skipped", async () => {
    ffState.createError = { code: 503, msg: 'maintenance' };
    fixedFloat();
    only('swapzone');
    await expect(createOrder('BTC')).resolves.toMatchObject({ provider: 'swapzone' });
    resetSwapzone();
    sz.quotes = [];
    await expect(createOrder('BTC')).rejects.toThrow('FixedFloat: maintenance');
    sz.quotes = [{ adapter: 'changenow', amountFrom: 0.001, amountTo: 80, quotaId: 'q-cn', minAmount: 0.0002, maxAmount: 5, open_fincases: '' }];
  });
});

describe('an order our own wallet pays', () => {
  const req = (over: Record<string, unknown> = {}) => ({
    from: 'BTC' as const,
    amount: 0.0006,
    expect: { toCcy: 'USDCBASE' as const, toAddress: PAYOUT, label: 'Coinbase (USDC on Base)' },
    transferId: 't_1',
    ownRefund: btcAddress('route'),
    ...over,
  });

  it('only falls back to a provider that takes a refund address, and passes ours', async () => {
    ffState.createError = { code: 503, msg: 'maintenance' };
    fixedFloat();
    const r = await openSwap(req());
    expect(r).toMatchObject({ provider: 'swapzone', ownRefund: btcAddress('route') });
    const create = calls.find((c) => c.path.endsWith('/exchange/create'))!;
    expect(create.body).toMatchObject({ refundAddress: btcAddress('route') });
    expect(create.body).not.toHaveProperty('noRefundAddress');
    expect(calls.find((c) => c.path.endsWith('/exchange/get-rate'))!.query).not.toHaveProperty('noRefundAddress');
  });

  it('never uses CypherGoat for it (no refund address): FixedFloat\'s error comes back', async () => {
    ffState.createError = { code: 503, msg: 'maintenance' };
    fixedFloat();
    only('cyphergoat');
    await expect(openSwap(req())).rejects.toThrow('FixedFloat: maintenance');
    expect(callsTo('cg')).toHaveLength(0);
  });

  it("keeps FixedFloat's wording and limit errors, and never retries a limit elsewhere", async () => {
    fixedFloat();
    await expect(openSwap(req({ amount: 0.00001 }))).rejects.toThrow(/Below FixedFloat's minimum/);
    expect(calls).toHaveLength(0);
  });

  it('skips the exchange that did the first leg when a fallback does the second', async () => {
    ffState.createError = { code: 503, msg: 'maintenance' };
    fixedFloat();
    // FixedFloat would be the best quote, but it did leg one.
    await openSwap(req({ avoid: ['fixedfloat'] }));
    expect(calls.find((c) => c.path.endsWith('/exchange/create'))!.body).toMatchObject({ quotaId: 'q-cn' });
  });

  it('does not count fallback orders for FixedFloat\'s one-order-per-direction rule', async () => {
    ffState.createError = { code: 503, msg: 'maintenance' };
    fixedFloat();
    sz.status = 'exchanging';
    const r = await openSwap(req());
    expect(r.provider).toBe('swapzone');
    expect(pairBusy('BTC', 'USDCBASE')).toBeNull();
  });
});

// ---------------------------------------------------------------- following a fallback order

describe('following a fallback order', () => {
  async function swapzoneOrder() {
    ffState.createError = { code: 503, msg: 'maintenance' };
    const ff = fixedFloat();
    const r = await createOrder('BTC');
    ffState.createError = null;
    ff.calls.length = 0;
    calls.length = 0;
    return { r, ff };
  }
  const poll = async (r: Awaited<ReturnType<typeof createOrder>>) => {
    r.nextPollAt = 0;
    await pollDue();
    return orderView(r);
  };

  it("asks the provider by its own id, never FixedFloat, and maps each status", async () => {
    const { r, ff } = await swapzoneOrder();
    expect(await poll(r)).toMatchObject({ stage: 'waiting', provider: 'swapzone' });
    expect(calls[0]).toMatchObject({ path: '/v1/exchange/tx', query: { id: '64abc0ffee' } });
    expect(ff.calls).toHaveLength(0);

    sz.status = 'confirming';
    expect(await poll(r)).toMatchObject({ stage: 'received', depositTx: 'szpayin' });
    sz.status = 'exchanging';
    expect(await poll(r)).toMatchObject({ stage: 'swapping' });
    sz.status = 'sending';
    expect(await poll(r)).toMatchObject({ stage: 'sending' });
    sz.status = 'finished';
    sz.payoutHash = '0xpayout';
    expect(await poll(r)).toMatchObject({ stage: 'done', usdt: '49.2', payoutTx: '0xpayout', payoutAddress: PAYOUT });
  });

  it('shows a provider refund, an overdue order, a failure and an unknown status', async () => {
    const { r } = await swapzoneOrder();
    sz.status = 'refunded';
    expect(await poll(r)).toMatchObject({ stage: 'refunded', providerRefunded: true });
    sz.status = 'overdue';
    expect(await poll(r)).toMatchObject({ stage: 'expired' });
    sz.status = 'failed';
    expect(await poll(r)).toMatchObject({ stage: 'attention' });
    sz.status = 'something-new';
    expect(await poll(r)).toMatchObject({ stage: 'attention' });
  });

  it('keeps going when the provider is down for a moment', async () => {
    const { r } = await swapzoneOrder();
    sz.down = true;
    expect((await poll(r)).pollError).toMatch(/Swapzone/);
    sz.down = false;
    expect((await poll(r)).pollError).toBeNull();
  });

  it('follows a CypherGoat order by its CGID', async () => {
    ffState.createError = { code: 503, msg: 'maintenance' };
    fixedFloat();
    only('cyphergoat');
    const r = await createOrder('BTC');
    calls.length = 0;
    cg.status = 'Exchanging';
    expect(await poll(r)).toMatchObject({ stage: 'swapping', provider: 'cyphergoat', exchange: 'exolix' });
    expect(calls[0]).toMatchObject({ path: '/transaction', query: { id: 'CG123' } });
    cg.status = 'zzz';
    expect(await poll(r)).toMatchObject({ stage: 'attention' });
  });

  it("can't be refunded through FixedFloat's emergency answer", async () => {
    const { r } = await swapzoneOrder();
    await expect(refundOrder(r, btcAddress('me'))).rejects.toThrow(/Swapzone/);
  });
});

// ---------------------------------------------------------------- configuration

describe('configuration', () => {
  it('limits() is only FixedFloat\'s answer when no fallback is listed', async () => {
    only();
    fixedFloat();
    expect(await limits('BTC', 'USDCBASE')).toMatchObject({ min: 0.0001243 });
    expect((await limits('BTC', 'USDCBASE')).provider).toBeUndefined();
  });

  it('an unknown asset is an error from the adapter, with no key in the message', async () => {
    await expect(swapzone.limits('XMR', 'USDT', 0.1)).rejects.toThrow(SwapApiError);
    const err = await swapzone.limits('XMR', 'USDT', 0.1).catch((e: Error) => e);
    expect(String(err.message)).not.toContain('sz-test-key');
  });

  it('refuses an unknown name in SWAP_FALLBACKS', async () => {
    process.env.SWAP_FALLBACKS = 'swapzone,trocador';
    vi.resetModules();
    await expect(import('../server/config.js')).rejects.toThrow(/SWAP_FALLBACKS "trocador"/);
    process.env.SWAP_FALLBACKS = 'swapzone,cyphergoat';
  });
});
