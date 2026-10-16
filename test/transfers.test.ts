import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as btc from '@scure/btc-signer';
import type { FastifyInstance } from 'fastify';
import { parseTransaction } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAYOUT, fakeFixedFloat, ffOrder, priceAnswer, xmrAddress } from './helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-transfers-'));
process.env.DATA_DIR = dataDir;
process.env.APP_PASSWORD = 'correct horse battery staple';
process.env.FF_API_KEY = 'test-key';
process.env.FF_API_SECRET = 'test-secret';
process.env.MONERO_RPC_URL = 'http://127.0.0.1:18083/json_rpc';
process.env.WALLET_KEY = 'test wallet key, long enough';
delete process.env.ALLOWED_HOSTS;
delete process.env.PRIVACY_TEST_DELAY_MIN;

// The BIP39 test mnemonic: its first addresses are published test vectors.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const { initWallet } = await import('../server/wallets/seed.js');
initWallet(process.env.WALLET_KEY, MNEMONIC);

const { buildApp } = await import('../server/app.js');
const { setTransport } = await import('../server/fixedfloat.js');
const { orders, pollDue } = await import('../server/orders.js');
const { transfers, stepTransfer, scanRoutes, createPrivacyTransfer, refreshPrices } = await import('../server/transfers.js');
const { addresses } = await import('../server/addresses.js');
const { setXmrFetch } = await import('../server/wallets/xmr.js');
const { setChainFetch } = await import('../server/chain.js');

const BIP84_FIRST = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const BIP44_ETH_FIRST = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const H = 3_600_000;

// ---------------------------------------------------------------- a fake monero-wallet-rpc

interface In {
  txid: string;
  amount: bigint;
  confirmations: number;
}
let wallet: ReturnType<typeof fakeMonero>;
function fakeMonero() {
  const w = {
    accounts: [{ account_index: 0, label: 'Primary account' }],
    next: 1,
    subs: new Map<number, string>(),
    incoming: new Map<number, In[]>(),
    balance: new Map<number, { total: bigint; unlocked: bigint }>(),
    sweeps: [] as { index: number; to: string; metadata: string; txid: string; amount: bigint; fee: bigint }[],
    relayed: [] as string[],
    relayFails: 0,
    calls: [] as { method: string; params: Record<string, unknown> }[],
    /** Money arrives at one of our subaddresses (locked until `unlock`). */
    receive(index: number, amount: bigint, txid = `in${index}-${amount}`) {
      w.incoming.set(index, [...(w.incoming.get(index) ?? []), { txid, amount, confirmations: 0 }]);
      const b = w.balance.get(index) ?? { total: 0n, unlocked: 0n };
      w.balance.set(index, { total: b.total + amount, unlocked: b.unlocked });
    },
    unlock(index: number) {
      for (const r of w.incoming.get(index) ?? []) r.confirmations = 12;
      const b = w.balance.get(index)!;
      w.balance.set(index, { total: b.total, unlocked: b.total });
    },
    indexOf: (address: string) => [...w.subs].find(([, a]) => a === address)?.[0],
  };
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: '0', result }));
  setXmrFetch(async (_url, init) => {
    const { method, params } = JSON.parse(String(init.body));
    w.calls.push({ method, params });
    switch (method) {
      case 'get_accounts':
        return ok({ subaddress_accounts: w.accounts });
      case 'create_account': {
        const i = w.accounts.length;
        w.accounts.push({ account_index: i, label: params.label });
        return ok({ account_index: i, address: xmrAddress(`Acct${i}`, '8') });
      }
      case 'create_address': {
        const i = w.next++;
        const address = xmrAddress(`Sub${i}`);
        w.subs.set(i, address);
        return ok({ address, address_index: i });
      }
      case 'get_transfers': {
        const i = params.subaddr_indices[0];
        const rows = (w.incoming.get(i) ?? []).map((r) => ({ txid: r.txid, amount: Number(r.amount), confirmations: r.confirmations, subaddr_index: { major: params.account_index, minor: i } }));
        return ok({ in: rows });
      }
      case 'get_balance': {
        const i = params.address_indices[0];
        const b = w.balance.get(i) ?? { total: 0n, unlocked: 0n };
        return ok({ per_subaddress: [{ address_index: i, balance: Number(b.total), unlocked_balance: Number(b.unlocked), blocks_to_unlock: b.unlocked === b.total ? 0 : 6 }] });
      }
      case 'sweep_all': {
        const i = params.subaddr_indices[0];
        const b = w.balance.get(i)!;
        if (!b || b.unlocked === 0n) return new Response(JSON.stringify({ error: { code: -37, message: 'No unlocked balance in the specified subaddress(es)' } }));
        const fee = 30_000_000n;
        const txid = `xtx${w.sweeps.length + 1}`;
        const s = { index: i, to: params.address, metadata: `META-SECRET-${txid}`, txid, amount: b.unlocked - fee, fee };
        w.sweeps.push(s);
        return ok({ tx_hash_list: [txid], amount_list: [Number(s.amount)], fee_list: [Number(fee)], tx_metadata_list: [s.metadata] });
      }
      case 'relay_tx': {
        if (w.relayFails > 0) {
          w.relayFails--;
          throw new TypeError('fetch failed');
        }
        const s = w.sweeps.find((x) => x.metadata === params.hex)!;
        if (w.relayed.includes(s.metadata)) return new Response(JSON.stringify({ error: { code: -1, message: 'Failed to relay: double spend' } }));
        w.relayed.push(s.metadata);
        w.balance.set(s.index, { total: 0n, unlocked: 0n });
        const own = w.indexOf(s.to);
        if (own !== undefined) w.receive(own, s.amount, s.txid);
        return ok({ tx_hash: s.txid });
      }
      case 'get_transfer_by_txid': {
        const s = w.sweeps.find((x) => x.txid === params.txid && w.relayed.includes(x.metadata));
        return s ? ok({ transfer: { type: 'pending', confirmations: 0 } }) : new Response(JSON.stringify({ error: { code: -8, message: 'Transaction not found.' } }));
      }
    }
    return new Response(JSON.stringify({ error: { code: -32601, message: `no fake for ${method}` } }));
  });
  return w;
}

// ---------------------------------------------------------------- a fake FixedFloat that remembers its orders

let ff: ReturnType<typeof fakeFF>;
function fakeFF() {
  const made = new Map<string, ReturnType<typeof ffOrder>>();
  const fake = fakeFixedFloat({
    price: (b) => priceAnswer(b.fromCcy as 'BTC', b.toCcy as 'USDT'),
    create: (b) => {
      const o = ffOrder({ coin: b.fromCcy as 'BTC', toCode: String(b.toCcy), payout: String(b.toAddress), fromAmount: String(b.amount) });
      made.set(o.id, o);
      return o;
    },
    order: (b) => made.get(String(b.id)),
    emergency: () => true,
  });
  setTransport(fake.transport);
  return {
    ...fake,
    made,
    creates: () => fake.calls.filter((c) => c.method === 'create').map((c) => c.body),
    /** FixedFloat finishes an order, paying out `out`. */
    finish(id: string, out: string, payTx = `0xpay${id}`) {
      const o = made.get(id)!;
      made.set(id, { ...o, status: 'DONE', from: { ...o.from, tx: { ...o.from.tx, id: `dep${id}`, amount: o.from.amount } }, to: { ...o.to, amount: out, tx: { ...o.to.tx, id: payTx, amount: out } } });
    },
    set(id: string, status: string) {
      made.set(id, { ...made.get(id)!, status });
    },
  };
}

// ---------------------------------------------------------------- a fake Bitcoin/Ethereum network

const chain = {
  utxos: [] as { txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }[],
  tip: 900_000,
  btcBroadcast: [] as string[],
  eth: { latest: 0n, settled: 0n, pending: 0n, nonce: 0, pendingNonce: 0, block: 20_000_000 },
  ethSent: [] as string[],
  baseFee: 3_000_000_000n,
};
function fakeChain() {
  chain.utxos = [];
  chain.btcBroadcast = [];
  chain.ethSent = [];
  chain.baseFee = 3_000_000_000n;
  chain.eth = { latest: 0n, settled: 0n, pending: 0n, nonce: 0, pendingNonce: 0, block: 20_000_000 };
  const json = (v: unknown) => new Response(JSON.stringify(v));
  const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
  setChainFetch(async (url, init) => {
    if (url.includes('/utxo')) return json(chain.utxos);
    if (url.endsWith('/blocks/tip/height')) return new Response(String(chain.tip));
    if (url.endsWith('/v1/fees/recommended')) return json({ fastestFee: 9, halfHourFee: 5, hourFee: 3 });
    if (url.endsWith('/tx') && init?.method === 'POST') {
      chain.btcBroadcast.push(String(init.body));
      return new Response('ok');
    }
    if (url.includes('/tx/') && url.endsWith('/status')) return chain.btcBroadcast.length ? json({ confirmed: false }) : new Response('not found', { status: 404 });
    const { method, params } = JSON.parse(String(init?.body));
    const e = chain.eth;
    const result = (() => {
      switch (method) {
        case 'eth_blockNumber':
          return hex(e.block);
        case 'eth_getBalance':
          return hex(params[1] === 'pending' ? e.pending : params[1] === 'latest' ? e.latest : e.settled);
        case 'eth_getTransactionCount':
          return hex(params[1] === 'pending' ? e.pendingNonce : e.nonce);
        case 'eth_getBlockByNumber':
          return { baseFeePerGas: hex(chain.baseFee) };
        case 'eth_maxPriorityFeePerGas':
          return hex(1_000_000_000n);
        case 'eth_estimateGas':
          return hex(21_000);
        case 'eth_sendRawTransaction':
          chain.ethSent.push(params[0]);
          e.pendingNonce++;
          return '0xhash';
        case 'eth_getTransactionByHash':
          return chain.ethSent.length ? { blockNumber: null } : null;
      }
      return null;
    })();
    return json({ jsonrpc: '2.0', id: 1, result });
  });
}

// ---------------------------------------------------------------- app

let app: FastifyInstance;
let cookie = '';
const HDR = { host: 'wallet.test', 'x-wallet': '1', 'content-type': 'application/json' };
const post = (url: string, body: unknown) => app.inject({ method: 'POST', url, headers: { ...HDR, cookie }, payload: JSON.stringify(body) });
const get = (url: string) => app.inject({ url, headers: { host: 'wallet.test', cookie } });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const res = await post('/api/login', { password: 'correct horse battery staple' });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
beforeEach(() => {
  for (const f of ['orders.json', 'transfers.json', 'routes.json', 'monero.json']) fs.rmSync(path.join(dataDir, f), { force: true });
  orders.reset();
  transfers.reset();
  addresses.reset();
  wallet = fakeMonero();
  ff = fakeFF();
  fakeChain();
});
afterAll(async () => {
  setTransport(null);
  setXmrFetch(null);
  setChainFetch(null);
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Runs a transfer's steps until it stops moving (or `max` steps). */
async function run(id: string, now = Date.now(), max = 12) {
  for (let i = 0; i < max; i++) {
    const t = transfers.get(id)!;
    const before = `${t.state}|${t.attention}|${t.waitingFor}`;
    await stepTransfer(t, now);
    if (`${t.state}|${t.attention}|${t.waitingFor}` === before && t.nextAt > now) break;
  }
  return transfers.get(id)!;
}

describe('Privacy Enhanced (fresh address)', () => {
  it('goes BTC → XMR (own vault) → churn → wait → XMR → USDT to Coinbase', async () => {
    const res = await post('/api/transfers', { coin: 'BTC', delayHours: 24 });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view).toMatchObject({ privacy: true, delayHours: 24, destinationLabel: 'Coinbase', state: 'swap1' });

    // Our own account, never account 0.
    expect(wallet.calls.find((c) => c.method === 'create_account')?.params).toEqual({ label: 'wallet-click' });
    expect(wallet.calls.filter((c) => 'account_index' in c.params).every((c) => c.params.account_index === 1)).toBe(true);

    // The first swap pays XMR to our fresh vault subaddress.
    const [first] = ff.creates();
    const vault = wallet.subs.get(1)!;
    expect(first).toMatchObject({ fromCcy: 'BTC', toCcy: 'XMR', toAddress: vault });
    const leg1 = view.leg1.id;
    expect(view.leg1.address).toMatch(/^bc1q/); // what the payer pays

    // Nothing happens until FixedFloat is done.
    let t = await run(view.id);
    expect(t.state).toBe('swap1');

    ff.finish(leg1, '0.3');
    orders.get(leg1)!.nextPollAt = 0;
    await pollDue();
    t = await run(view.id);
    expect(t.state).toBe('xmr-in');
    expect(t.waitingFor).toMatch(/show up/);

    wallet.receive(1, 300_000_000_000n);
    t = await run(view.id);
    expect(t.waitingFor).toMatch(/unlock \(0 of 10/);

    wallet.unlock(1);
    const unlockedAt = Date.now();
    t = await run(view.id, unlockedAt);
    // Moved once within our wallet to a fresh subaddress, then waiting.
    expect(wallet.sweeps[0]).toMatchObject({ index: 1, to: wallet.subs.get(2) });
    expect(t.state).toBe('wait');
    expect(t.releaseAt! - t.vault!.unlockedAt!).toBeGreaterThanOrEqual(24 * H);
    expect(t.releaseAt! - t.vault!.unlockedAt!).toBeLessThanOrEqual(24 * H + 30 * 60_000);

    // Its dollar value (for the countdown on the desktop): the Monero held, at FixedFloat's current price.
    await refreshPrices(unlockedAt);
    expect((await get(`/api/transfers/${view.id}`)).json().usdValue).toBeCloseTo(0.3 * 541.7, 2);

    // Still waiting an hour before the release time, even once the churn unlocked.
    wallet.unlock(2);
    t = await run(view.id, t.releaseAt! - H);
    expect(t.state).toBe('wait');
    expect(ff.creates()).toHaveLength(1);

    // Time's up: an order for exactly what the wallet can send, paid from the churn subaddress.
    t = await run(view.id, t.releaseAt! + 1);
    const second = ff.creates()[1];
    expect(second).toMatchObject({ fromCcy: 'XMR', toCcy: 'USDT', toAddress: PAYOUT });
    expect(second.amount).toBe(0.29994); // 0.3 - two 0.00003 fees, floored to 8 decimals
    const leg2 = orders.get(t.leg2!)!;
    expect(leg2.ownRefund).toBe(wallet.subs.get(2)); // a refund comes back to us
    expect(wallet.sweeps[wallet.sweeps.length - 1].to).toBe(leg2.depositAddress);
    expect(t.state).toBe('swap2');

    ff.finish(leg2.id, '160.12');
    leg2.nextPollAt = 0;
    await pollDue();
    t = await run(view.id);
    expect(t).toMatchObject({ state: 'done', usdt: '160.12' });

    // Every spend went to our own subaddress or a FixedFloat order we created.
    const ffDeposits = new Set([...ff.made.values()].map((o) => o.from.address));
    for (const s of wallet.sweeps.filter((x) => wallet.relayed.includes(x.metadata))) expect(ffDeposits.has(s.to) || wallet.indexOf(s.to) !== undefined).toBe(true);

    const v = (await get(`/api/transfers/${view.id}`)).json();
    expect(v.steps.map((s: { status: string }) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done']);

    // What it cost: FixedFloat's cut on both swaps plus the Monero fees, at the prices when each swap ran.
    const BTC = 83.86 / 0.001;
    const XMR = 54.17 / 0.1;
    const inUsd = Number(t.received) * BTC;
    const fees = inUsd - 0.3 * XMR + (0.3 - 0.29994) * XMR + (0.29994 * XMR - 160.12);
    expect(v.cost).toEqual({ usd: Math.round(fees * 100) / 100, pct: Math.round((fees / inUsd) * 1000) / 10, inUsd: Math.round(inUsd * 100) / 100, drift: 0 });
    expect(JSON.stringify(v)).not.toMatch(/META-SECRET|SECRET|token/);
  });

  it('can be released early or given another delay while waiting', async () => {
    const t0 = await createPrivacyTransfer('ETH', 42);
    ff.finish(t0.leg1!, '0.5');
    orders.get(t0.leg1!)!.nextPollAt = 0;
    await pollDue();
    await run(t0.id);
    wallet.receive(1, 500_000_000_000n);
    wallet.unlock(1);
    let t = await run(t0.id);
    expect(t.state).toBe('wait');
    const start = t.vault!.unlockedAt!;

    let v = (await post(`/api/transfers/${t.id}/delay`, { delayHours: 4 })).json();
    expect(v.releaseAt - start).toBeLessThanOrEqual(4 * H + 30 * 60_000);
    expect((await post(`/api/transfers/${t.id}/delay`, { delayHours: 5 })).statusCode).toBe(400);

    wallet.unlock(2);
    v = (await post(`/api/transfers/${t.id}/release`, {})).json();
    expect(v.releaseAt).toBeLessThanOrEqual(Date.now());
    t = await run(t.id);
    expect(t.state).toBe('swap2');
  });

  it('never broadcasts a second transaction after a failed relay: it relays the saved one again', async () => {
    const t0 = await createPrivacyTransfer('BTC', 4);
    ff.finish(t0.leg1!, '0.3');
    orders.get(t0.leg1!)!.nextPollAt = 0;
    await pollDue();
    await run(t0.id);
    wallet.receive(1, 300_000_000_000n);
    wallet.unlock(1);
    wallet.relayFails = 1;
    let t = await run(t0.id);
    expect(t.state).toBe('churn');
    expect(t.error).toMatch(/Couldn't reach|Monero/);
    t = await run(t0.id, Date.now() + 60_000);
    expect(t.state).toBe('wait');
    expect(wallet.sweeps.filter((s) => s.index === 1)).toHaveLength(1); // signed once
    expect(wallet.relayed).toEqual([wallet.sweeps[0].metadata]);
  });

  it('waits for an earlier XMR → USDT order to finish first (FixedFloat rule)', async () => {
    const a = await createPrivacyTransfer('BTC', 4);
    const b = await createPrivacyTransfer('BTC', 4);
    for (const [t, vaultIndex] of [
      [a, 1],
      [b, 2],
    ] as const) {
      ff.finish(t.leg1!, '0.3');
      orders.get(t.leg1!)!.nextPollAt = 0;
      await pollDue();
      await run(t.id);
      wallet.receive(vaultIndex, 300_000_000_000n);
      wallet.unlock(vaultIndex);
      await run(t.id);
    }
    for (const t of [a, b]) wallet.unlock(transfers.get(t.id)!.churn!.index);
    const later = Date.now() + 5 * H;
    const ta = await run(a.id, later);
    expect(ta.state).toBe('swap2');
    const tb = await run(b.id, later);
    expect(tb.state).toBe('open2');
    expect(tb.waitingFor).toMatch(new RegExp(`order ${ta.leg2}.*to finish first`));
  });

  it('needs Bitcoin or Ethereum and one of the offered delays', async () => {
    expect((await post('/api/transfers', { coin: 'XMR', delayHours: 4 })).statusCode).toBe(400);
    expect((await post('/api/transfers', { coin: 'BTC', delayHours: 6 })).statusCode).toBe(400);
  });
});

describe('permanent addresses', () => {
  it('forwards a Monero payment once it unlocks and is above the minimum', async () => {
    const r = (await post('/api/addresses', { coin: 'XMR', mode: 'direct' })).json();
    expect(r.address).toBe(wallet.subs.get(1));
    expect(r).toMatchObject({ coin: 'XMR', destinationLabel: 'Coinbase', label: 'XMR to Coinbase' });

    wallet.receive(1, 10_000_000_000n); // 0.01 XMR: below the 0.0184 minimum
    await scanRoutes();
    const id = transfers.all()[0].id;
    let t = await run(id);
    expect(t.state).toBe('collect');
    expect(t.waitingFor).toMatch(/confirmations/);
    wallet.unlock(1);
    t = await run(id);
    expect(t.waitingFor).toMatch(/minimum is 0.0184 XMR/);

    wallet.receive(1, 90_000_000_000n);
    wallet.unlock(1);
    t = await run(id, Date.now() + 3 * 60_000);
    expect(ff.creates()[0]).toMatchObject({ fromCcy: 'XMR', toCcy: 'USDT', toAddress: PAYOUT, amount: 0.09997 });
    const leg = orders.get(t.leg1!)!;
    expect(leg.ownRefund).toBe(r.address);
    expect(wallet.sweeps[wallet.sweeps.length - 1]).toMatchObject({ index: 1, to: leg.depositAddress });
    expect(t.state).toBe('swap1');

    // Another payment while that one's swapping becomes its own transfer.
    wallet.receive(1, 50_000_000_000n);
    await scanRoutes(Date.now() + 60_000);
    expect(transfers.all()).toHaveLength(2);
  });

  it('forwards Bitcoin from a BIP84 address: exactly the order amount, from exactly the quoted coins', async () => {
    const r = (await post('/api/addresses', { coin: 'BTC', mode: 'direct', label: 'Phone → Coinbase' })).json();
    expect(r.address).toBe(BIP84_FIRST);
    chain.utxos = [{ txid: 'aa'.repeat(32), vout: 1, value: 300_000, status: { confirmed: false } }];
    await scanRoutes();
    const id = transfers.all()[0].id;
    let t = await run(id);
    expect(t.received).toBe('0.003');
    expect(t.waitingFor).toMatch(/confirmations \(0 of 1\)/);

    chain.utxos[0].status = { confirmed: true, block_height: chain.tip };
    t = await run(id);
    // 300000 sats minus 5 sat/vB × 122 vB
    expect(ff.creates()[0]).toMatchObject({ fromCcy: 'BTC', toCcy: 'USDT', toAddress: PAYOUT, amount: 0.0029939 });
    const leg = orders.get(t.leg1!)!;
    expect(leg.ownRefund).toBe(BIP84_FIRST);
    expect(chain.btcBroadcast).toHaveLength(1);
    const tx = btc.Transaction.fromRaw(Buffer.from(chain.btcBroadcast[0], 'hex'));
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    expect(tx.getOutput(0).amount).toBe(299_390n);
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(tx.getOutput(0).script!))).toBe(leg.depositAddress);
    expect(t.state).toBe('swap1');

    ff.finish(leg.id, '240.5');
    leg.nextPollAt = 0;
    await pollDue();
    t = await run(id);
    expect(t).toMatchObject({ state: 'done', usdt: '240.5' });
    expect(t.forward!.raw).toEqual([]); // nothing signed left lying around
  });

  it('forwards Ethereum: exactly the order amount, gas kept back, mainnet only', async () => {
    const r = (await post('/api/addresses', { coin: 'ETH', mode: 'direct' })).json();
    expect(r.address).toBe(BIP44_ETH_FIRST);
    const one = 10n ** 18n / 10n; // 0.1 ETH
    Object.assign(chain.eth, { latest: one, pending: one, settled: 0n });
    await scanRoutes();
    const id = transfers.all()[0].id;
    let t = await run(id);
    expect(t.waitingFor).toMatch(/confirmations/);
    chain.eth.settled = one;
    t = await run(id);
    const order = ff.creates()[0];
    expect(order).toMatchObject({ fromCcy: 'ETH', toCcy: 'USDT', toAddress: PAYOUT });
    const leg = orders.get(t.leg1!)!;
    const sent = parseTransaction(chain.ethSent[0] as `0x${string}`);
    expect(sent).toMatchObject({ chainId: 1, to: leg.depositAddress, type: 'eip1559' });
    expect(sent.value).toBe(BigInt(Math.round(Number(order.amount) * 1e8)) * 10n ** 10n);
    expect(sent.value! + sent.gas! * sent.maxFeePerGas!).toBeLessThanOrEqual(one);
  });

  it('runs a permanent Privacy address through Monero too', async () => {
    const r = (await post('/api/addresses', { coin: 'BTC', mode: 'privacy', delayHours: 12 })).json();
    chain.utxos = [{ txid: 'bb'.repeat(32), vout: 0, value: 200_000, status: { confirmed: true, block_height: chain.tip } }];
    await scanRoutes();
    const t = await run(transfers.all()[0].id);
    expect(ff.creates()[0]).toMatchObject({ fromCcy: 'BTC', toCcy: 'XMR', toAddress: wallet.subs.get(1) });
    expect(t).toMatchObject({ state: 'swap1', privacy: true, delayHours: 12, routeId: r.id });
  });

  it('collects small Bitcoin payments until they reach the minimum (≈ $109 into Monero)', async () => {
    await post('/api/addresses', { coin: 'BTC', mode: 'privacy', delayHours: 4 });
    chain.utxos = [{ txid: 'cc'.repeat(32), vout: 0, value: 60_000, status: { confirmed: true, block_height: chain.tip } }];
    await scanRoutes();
    const t = await run(transfers.all()[0].id);
    expect(t.state).toBe('collect');
    expect(t.waitingFor).toMatch(/FixedFloat's minimum is 0.00129979 BTC \(≈ \$109.00\), 0.0005939 BTC so far/);
    expect(ff.creates()).toHaveLength(0);
  });

  it('keeps the address and destination fixed: only the name and delay change', async () => {
    const r = (await post('/api/addresses', { coin: 'XMR', mode: 'direct' })).json();
    const changed = (await post(`/api/addresses/${r.id}`, { label: 'Rent', address: 'x', destinationId: 'd_other' })).json();
    expect(changed).toMatchObject({ label: 'Rent', address: r.address, destinationId: 'coinbase' });
    expect((await post(`/api/addresses/${r.id}`, { delayHours: 4 })).json().error).toMatch(/Only Privacy/);
    expect((await post('/api/addresses', { coin: 'XMR', mode: 'privacy', delayHours: 4 })).json().error).toMatch(/already private/);
    // Coinbase can't go, and neither can a destination a permanent address uses (not tested here: Coinbase is built in).
  });

  it('never shows the seed, keys or signed transactions to the browser', async () => {
    await post('/api/addresses', { coin: 'BTC', mode: 'direct' });
    chain.utxos = [{ txid: 'dd'.repeat(32), vout: 0, value: 300_000, status: { confirmed: true, block_height: chain.tip } }];
    await scanRoutes();
    await run(transfers.all()[0].id);
    const bodies = [await get('/api/orders'), await get('/api/transfers'), await get('/api/addresses'), await get('/api/meta')].map((r) => r.body).join('\n');
    expect(bodies).not.toMatch(/abandon|SECRET|token/);
    expect(bodies).not.toContain(chain.btcBroadcast[0]);
    expect(fs.readFileSync(path.join(dataDir, 'wallet.enc'), 'utf8')).not.toMatch(/abandon/);
  });
});

describe('safety checks from review', () => {
  it('never pays a FixedFloat order that went stale: it makes a fresh one', async () => {
    await post('/api/addresses', { coin: 'BTC', mode: 'direct' });
    chain.utxos = [{ txid: 'ee'.repeat(32), vout: 0, value: 300_000, status: { confirmed: true, block_height: chain.tip } }];
    await scanRoutes();
    const id = transfers.all()[0].id;
    const t = transfers.get(id)!;
    await stepTransfer(t); // collect → open1
    await stepTransfer(t); // open1 → send1 (order made)
    expect(t.state).toBe('send1');
    const first = t.leg1!;
    // The hot wallet was busy for a while: the order is now too old to pay.
    await run(id, Date.now() + 15 * 60_000);
    expect(orders.get(first)!.abandoned).toBe(true);
    expect(ff.creates()).toHaveLength(2);
    expect(t.leg1).not.toBe(first);
    expect(chain.btcBroadcast).toHaveLength(1);
    const tx = btc.Transaction.fromRaw(Buffer.from(chain.btcBroadcast[0], 'hex'));
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(tx.getOutput(0).script!))).toBe(orders.get(t.leg1!)!.depositAddress);
  });

  it('refuses to pay a deposit address FixedFloat has used before', async () => {
    const reused = ffOrder({ coin: 'XMR' }).from.address;
    // An old order already used this address.
    setTransport(
      fakeFixedFloat({
        price: (b) => priceAnswer(b.fromCcy as 'XMR'),
        create: (b) => ffOrder({ coin: b.fromCcy as 'XMR', payout: String(b.toAddress), address: reused }),
      }).transport,
    );
    await post('/api/orders', { coin: 'XMR' });
    await post('/api/addresses', { coin: 'XMR', mode: 'direct' });
    wallet.receive(1, 100_000_000_000n);
    wallet.unlock(1);
    await scanRoutes();
    const t = await run(transfers.all()[0].id);
    expect(t.state).toBe('open1');
    expect(t.error).toMatch(/reuses an old deposit address/);
    expect(wallet.relayed).toHaveLength(0);
  });

  it('turns Monero left at a finished transfer’s subaddress into a new transfer', async () => {
    const { rescueLeftovers } = await import('../server/transfers.js');
    const t0 = await createPrivacyTransfer('BTC', 4);
    ff.finish(t0.leg1!, '0.3');
    orders.get(t0.leg1!)!.nextPollAt = 0;
    await pollDue();
    await run(t0.id);
    wallet.receive(1, 300_000_000_000n);
    wallet.unlock(1);
    await run(t0.id); // churned: the vault is retired
    // FixedFloat pays the same Privacy address a second time.
    wallet.receive(1, 200_000_000_000n, 'second-payout');
    await rescueLeftovers(Date.now() + 11 * 60_000);
    const rescued = transfers.all().find((t) => t.id !== t0.id)!;
    expect(rescued).toMatchObject({ state: 'xmr-in', privacy: true, delayHours: 4, destinationId: 'coinbase' });
    expect(rescued.vault!.index).toBe(1);
    // Not twice.
    await rescueLeftovers(Date.now() + 22 * 60_000);
    expect(transfers.all()).toHaveLength(2);
  });

  it("won't remove a destination a transfer is still paying out to", async () => {
    const FRIEND = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    const PASSWORD = 'correct horse battery staple';
    const { destinations } = await import('../server/destinations.js');
    destinations.reset();
    fs.rmSync(path.join(dataDir, 'destinations.json'), { force: true });
    const id = (await post('/api/destinations', { label: 'Friend', address: FRIEND, password: PASSWORD })).json().destinations[1].id;
    await createPrivacyTransfer('BTC', 4, id);
    const res = await post(`/api/destinations/${id}/delete`, { password: PASSWORD });
    expect(res.json().error).toMatch(/A transfer still in progress pays out here/);
  });

  it('refuses absurd Ethereum gas, whatever the RPC says', async () => {
    await post('/api/addresses', { coin: 'ETH', mode: 'direct' });
    const one = 10n ** 17n;
    Object.assign(chain.eth, { latest: one, pending: one, settled: one });
    chain.baseFee = 500n * 10n ** 9n; // a lying (or panicking) RPC
    await scanRoutes();
    const t = await run(transfers.all()[0].id);
    expect(t.state).toBe('collect');
    expect(t.error).toMatch(/unusually expensive/);
    expect(chain.ethSent).toHaveLength(0);
  });
});
