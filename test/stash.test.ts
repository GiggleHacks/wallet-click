import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import type { FastifyInstance } from 'fastify';
import { parseTransaction } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAYOUT_BASE, btcAddress, fakeFixedFloat, xmrAddress } from './helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-stash-'));
process.env.DATA_DIR = dataDir;
process.env.APP_PASSWORD = 'correct horse battery staple';
process.env.FF_API_KEY = 'test-key';
process.env.FF_API_SECRET = 'test-secret';
process.env.MONERO_RPC_URL = 'http://127.0.0.1:18083/json_rpc';
process.env.WALLET_KEY = 'test wallet key, long enough';
const AGENT = 'agent-token-0123456789-abcdefghijklmnop';
process.env.AGENT_TOKEN = AGENT;
delete process.env.ALLOWED_HOSTS;

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const { initWallet } = await import('../server/wallets/seed.js');
initWallet(process.env.WALLET_KEY, MNEMONIC);

const { buildApp } = await import('../server/app.js');
const { setTransport } = await import('../server/fixedfloat.js');
const { setChainFetch } = await import('../server/chain.js');
const { setXmrFetch } = await import('../server/wallets/xmr.js');
const { orders, pairBusy } = await import('../server/orders.js');
const { addresses } = await import('../server/addresses.js');
const engine = await import('../server/stash/engine.js');
const store = await import('../server/stash/store.js');
const { resetSwapCache } = await import('../server/stash/swap.js');
const { resetAgentFails } = await import('../server/routes/stash.js');

/** Phantom / Solflare's first account for the test mnemonic (m/44'/501'/0'/0'). */
const SOL_FIRST = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const BIP84_FIRST = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const BIP44_ETH_FIRST = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const solAddr = (seed: string) => base58.encode(sha256(utf8ToBytes(seed)));

/** Telegram pings queued while `fn` runs. */
async function pings(fn: () => Promise<void>): Promise<{ key: string; text: string }[]> {
  const { resetNotify } = await import('../server/notify.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ping-'));
  process.env.WC_NOTIFY_DIR = dir;
  process.env.WC_NOTIFY_TEST = '1';
  resetNotify();
  try {
    await fn();
    const file = path.join(dir, 'telegram-outbox.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { key: string; text: string });
  } finally {
    delete process.env.WC_NOTIFY_DIR;
    delete process.env.WC_NOTIFY_TEST;
    resetNotify();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- fakes

const net = {
  /** Esplora coins by address (BTC and LTC). */
  utxos: new Map<string, { txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }[]>(),
  utxoPosts: [] as string[],
  /** Solana balances by address: processed and finalized. */
  sol: new Map<string, { processed: bigint; finalized: bigint }>(),
  solSent: [] as string[],
  /** EVM (Base) balances by address. */
  evm: new Map<string, bigint>(),
  evmSent: [] as string[],
  calls: [] as string[],
};

function fakeNet() {
  net.utxos.clear();
  net.utxoPosts = [];
  net.sol.clear();
  net.solSent = [];
  net.evm.clear();
  net.evmSent = [];
  net.calls = [];
  const json = (v: unknown) => new Response(JSON.stringify(v));
  const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
  setChainFetch(async (url, init) => {
    net.calls.push(url);
    if (/litecoinspace|mempool|blockstream/.test(url)) {
      if (url.includes('/utxo')) return json(net.utxos.get(url.split('/address/')[1].split('/')[0]) ?? []);
      if (url.endsWith('/blocks/tip/height')) return new Response('3000000');
      if (url.endsWith('/v1/fees/recommended')) return json({ halfHourFee: 3 });
      if (url.endsWith('/tx') && init?.method === 'POST') {
        net.utxoPosts.push(String(init.body));
        return new Response('ok');
      }
      if (url.endsWith('/status')) return net.utxoPosts.length ? json({ confirmed: false }) : new Response('nope', { status: 404 });
      return new Response('nope', { status: 404 });
    }
    const { method, params } = JSON.parse(String(init?.body));
    if (/solana/.test(url)) {
      const result = (() => {
        switch (method) {
          case 'getBalance': {
            const b = net.sol.get(params[0]) ?? { processed: 0n, finalized: 0n };
            return { value: Number(params[1].commitment === 'finalized' ? b.finalized : b.processed) };
          }
          case 'getSignaturesForAddress':
            return net.sol.get(params[0]) ? [{ signature: `sig-${params[0].slice(0, 6)}`, err: null }] : [];
          case 'getLatestBlockhash':
            return { value: { blockhash: solAddr('blockhash'), lastValidBlockHeight: 1 } };
          case 'sendTransaction':
            net.solSent.push(params[0]);
            return 'sig';
          case 'getSignatureStatuses':
            return { value: [net.solSent.length ? { confirmations: 0, confirmationStatus: 'processed', err: null } : null] };
          case 'isBlockhashValid':
            return { value: true };
        }
        return null;
      })();
      return json({ jsonrpc: '2.0', id: 1, result });
    }
    // EVM (Base)
    const result = (() => {
      switch (method) {
        case 'eth_blockNumber':
          return hex(30_000_000);
        case 'eth_getBalance':
          return hex(net.evm.get(String(params[0]).toLowerCase()) ?? 0n);
        case 'eth_getTransactionCount':
          return hex(0);
        case 'eth_getBlockByNumber':
          return { baseFeePerGas: hex(10_000_000n) };
        case 'eth_maxPriorityFeePerGas':
          return hex(1_000_000n);
        case 'eth_gasPrice':
          return hex(11_000_000n);
        case 'eth_estimateGas':
          return hex(21_000);
        case 'eth_call':
          return hex(30_000_000_000n); // the L1 data fee
        case 'eth_sendRawTransaction':
          net.evmSent.push(params[0]);
          return '0xhash';
        case 'eth_getTransactionByHash':
          return net.evmSent.length ? { blockNumber: null } : null;
      }
      return null;
    })();
    return json({ jsonrpc: '2.0', id: 1, result });
  });
}

let xmr: ReturnType<typeof fakeMonero>;
function fakeMonero() {
  const w = {
    accounts: [{ account_index: 0, label: 'Primary account' }, { account_index: 1, label: 'wallet-click' }],
    next: 1,
    subs: new Map<number, { address: string; account: number }>(),
    calls: [] as { method: string; params: Record<string, unknown> }[],
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
        return ok({ account_index: i });
      }
      case 'create_address': {
        const i = w.next++;
        const address = xmrAddress(`Stash${i}`);
        w.subs.set(i, { address, account: params.account_index });
        return ok({ address, address_index: i });
      }
      case 'get_transfers':
        return ok({});
      case 'get_balance':
        return ok({ per_subaddress: [] });
    }
    return new Response(JSON.stringify({ error: { code: -32601, message: `no fake for ${method}` } }));
  });
  return w;
}

let ffOrders: Map<string, Record<string, unknown>>;
let ffCreates: Record<string, unknown>[];
/** What the fake FixedFloat pays out to, regardless of what was asked (to test the refusal). */
let ffPayoutOverride: string | null = null;
let ffCalls: ReturnType<typeof fakeFixedFloat>['calls'];
function fakeFF() {
  ffOrders = new Map();
  ffCreates = [];
  ffPayoutOverride = null;
  let n = 0;
  const f = fakeFixedFloat({
    ccies: () => [
      { code: 'ZEC', coin: 'ZEC', network: 'ZEC', name: 'Zcash', recv: 1, send: 1, tag: null, priority: 5 },
      { code: 'XRP', coin: 'XRP', network: 'XRP', name: 'Ripple', recv: 1, send: 1, tag: 'DESTINATION TAG', priority: 6 },
      { code: 'SOL', coin: 'SOL', network: 'SOL', name: 'Solana', recv: 1, send: 1, tag: null, priority: 9 },
      { code: 'OLD', coin: 'OLD', network: 'OLD', name: 'Paused', recv: 0, send: 0, tag: null, priority: 1 },
    ],
    price: (b) => ({
      from: { code: b.fromCcy, network: b.fromCcy, coin: b.fromCcy, amount: b.amount, rate: 1, precision: 8, min: 0.05, max: 1000, usd: Number(b.amount) * 150 },
      to: { code: b.toCcy, network: b.toCcy === 'USDCBASE' ? 'BASE' : 'XMR', coin: b.toCcy, amount: Number(b.amount) * 149, rate: 1, precision: 8, min: 1, max: 1e6, usd: 1 },
      errors: Number(b.amount) < 0.05 ? ['LIMIT_MIN'] : [],
    }),
    create: (b) => {
      ffCreates.push(b);
      n++;
      const from = String(b.fromCcy);
      const deposit = from === 'BTC' ? btcAddress(`dep${n}`) : from === 'SOL' ? solAddr(`ff-dep-${n}`) : from === 'ETHBASE' ? `0x${n.toString(16).padStart(40, 'd')}` : from === 'XRP' ? 'rFixedFloatSharedDeposit' : `t1FakeZcashDeposit${n}`;
      const now = Math.floor(Date.now() / 1000);
      const o = {
        id: `SO${n}`,
        token: `stash-tok-${n}-SECRET`,
        type: 'float',
        status: 'NEW',
        time: { reg: now, start: null, finish: null, update: now, expiration: now + 1800, left: 1800 },
        from: { code: from, coin: from, network: from, name: from, amount: String(b.amount), address: deposit, tag: from === 'XRP' ? '123456' : '', tx: { id: null, amount: null } },
        to: { code: b.toCcy, coin: b.toCcy, network: b.toCcy === 'USDCBASE' ? 'BASE' : 'XMR', name: '', amount: '1', address: ffPayoutOverride ?? b.toAddress, tag: '', tx: { id: null, amount: null } },
        back: { amount: null, address: '', tag: '', tx: null },
        emergency: { status: [], choice: 'NONE', repeat: '0' },
      };
      ffOrders.set(o.id, o);
      return o;
    },
    order: (b) => {
      const o = ffOrders.get(String(b.id))!;
      return o;
    },
    emergency: () => true,
  });
  setTransport(f.transport);
  ffCalls = f.calls;
}

// ---------------------------------------------------------------- app

let app: FastifyInstance;
let cookie = '';
const HDR = { host: 'wallet.test', 'x-wallet': '1', 'content-type': 'application/json' };
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, headers: { ...HDR, cookie, ...headers }, payload: JSON.stringify(body) });
const get = (url: string, headers: Record<string, string> = { cookie }) => app.inject({ url, headers: { host: 'wallet.test', ...headers } });
const agentPost = (url: string, body: unknown, token = AGENT) => app.inject({ method: 'POST', url, headers: { host: '127.0.0.1:8787', 'x-wallet': '1', 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify(body) });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const res = await post('/api/login', { password: 'correct horse battery staple' });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
beforeEach(() => {
  for (const f of ['stash.json', 'orders.json', 'routes.json', 'monero.json']) fs.rmSync(path.join(dataDir, f), { force: true });
  store.resetStore();
  engine.resetEngine();
  resetSwapCache();
  resetAgentFails();
  orders.reset();
  addresses.reset();
  fakeNet();
  xmr = fakeMonero();
  fakeFF();
});
afterAll(async () => {
  setTransport(null);
  setXmrFetch(null);
  setChainFetch(null);
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Runs a move's steps until it stops changing. */
async function runMove(id: string, t = Date.now(), max = 10) {
  for (let i = 0; i < max; i++) {
    const e = engine.getEntry(id)!;
    const m = e.moves[e.moves.length - 1];
    const before = `${m.step}|${m.error}`;
    await engine.stepMove(e, m, t);
    if (`${m.step}|${m.error}` === before) break;
  }
  const e = engine.getEntry(id)!;
  return e.moves[e.moves.length - 1];
}

// ---------------------------------------------------------------- tests

describe('fresh addresses', () => {
  it('derives Solana like Phantom, EVM from account 2, and never hands out an address twice (restarts included)', async () => {
    const sol = await engine.createAddress('SOL', { label: 'Bob', by: 'you' });
    expect(sol.address).toBe(SOL_FIRST);
    const base = await engine.createAddress('ETH-BASE', { by: 'you' });
    expect(base.address).toBe(mnemonicToAccount(MNEMONIC, { accountIndex: 2 }).address);
    const arb = await engine.createAddress('ETH-ARB', { by: 'you' });
    expect(arb.address).toBe(mnemonicToAccount(MNEMONIC, { accountIndex: 2, addressIndex: 1 }).address); // EVM chains share one counter
    const ltc = await engine.createAddress('LTC', { by: 'you' });
    expect(ltc.address).toMatch(/^ltc1q[02-9ac-hj-np-z]{38}$/);
    const b1 = await engine.createAddress('BTC', { by: 'you' });
    expect(b1.address).toMatch(/^bc1q/);

    store.resetStore(); // a restart: the counters come back from disk
    engine.resetEngine();
    const sol2 = await engine.createAddress('SOL', { by: 'you' });
    const b2 = await engine.createAddress('BTC', { by: 'you' });
    const all = store.load().entries.map((e) => e.address);
    expect(new Set(all).size).toBe(all.length);
    expect(sol2.address).not.toBe(SOL_FIRST);
    // None of them is one of the transfers' own addresses (BIP84 account 0, BIP44 ETH account 0).
    expect(all).not.toContain(BIP84_FIRST);
    expect(all.map((a) => a.toLowerCase())).not.toContain(BIP44_ETH_FIRST.toLowerCase());
    expect(b2.address).not.toBe(b1.address);
  });

  it('makes Monero addresses in an account of its own, never the transfers\' one or account 0', async () => {
    const e = await engine.createAddress('XMR', { by: 'you' });
    const create = xmr.calls.find((c) => c.method === 'create_address')!;
    expect(create.params.account_index).toBe(2);
    expect(xmr.accounts[2].label).toBe('wallet-click-stash');
    expect(e.address).toBe(xmr.subs.get(e.index)!.address);
  });

  it('gives each address its network warning and a wallet link', async () => {
    const res = await post('/api/stash', { asset: 'ETH-BASE', label: 'Alice' });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.uri).toBe(`ethereum:${v.address}@8453`);
    expect(v.warning).toMatch(/Base/);
    expect(v.label).toBe('Alice');
    expect(v.state).toBe('waiting');
  });
});

describe('watching', () => {
  it('pings once when a payment is broadcast and once when it is confirmed', async () => {
    const e = await engine.createAddress('LTC', { label: 'Carol', by: 'you' });
    const out = await pings(async () => {
      net.utxos.set(e.address, [{ txid: 'aa'.repeat(32), vout: 0, value: 50_000_000, status: { confirmed: false } }]);
      await engine.scanEntry(engine.getEntry(e.id)!);
      await engine.scanEntry(engine.getEntry(e.id)!); // nothing new
      expect(engine.entryView(engine.getEntry(e.id)!).state).toBe('incoming');
      net.utxos.set(e.address, [{ txid: 'aa'.repeat(32), vout: 0, value: 50_000_000, status: { confirmed: true, block_height: 2_999_999 } }]);
      await engine.scanEntry(engine.getEntry(e.id)!);
      await engine.scanEntry(engine.getEntry(e.id)!);
    });
    expect(out.map((p) => p.key)).toEqual([`stash:in:${e.id}:${'aa'.repeat(32)}`, `stash:held:${e.id}:50000000`]);
    expect(out[0].text).toMatch(/Received[\s\S]*LTC[\s\S]*Carol/);
    expect(out[0].text).not.toMatch(/ltc1/); // no addresses unless NOTIFY_DETAIL=full
    const v = engine.entryView(engine.getEntry(e.id)!);
    expect(v.state).toBe('held');
    expect(v.amount).toBe('0.5');
  });
});

describe('moving', () => {
  it('sends Solana to a checked FixedFloat order for USDC on Base, signed, saved, then broadcast', async () => {
    const e = await engine.createAddress('SOL', { by: 'you' });
    net.sol.set(e.address, { processed: 2_000_000_000n, finalized: 2_000_000_000n });
    await engine.scanEntry(engine.getEntry(e.id)!);
    const res = await post(`/api/stash/${e.id}/move`, { to: 'coinbase', password: 'correct horse battery staple', toAddress: 'evil' });
    expect(res.statusCode).toBe(200);
    const m = await runMove(e.id);
    expect(m.step).toBe('sent');
    expect(ffCreates[0]).toMatchObject({ fromCcy: 'SOL', toCcy: 'USDCBASE', toAddress: PAYOUT_BASE });
    // Exactly one transaction: everything minus the fee, to FixedFloat's deposit address, signed by our key.
    expect(net.solSent).toHaveLength(1);
    const raw = base64.decode(net.solSent[0]);
    const sig = raw.slice(1, 65);
    const msg = raw.slice(65);
    const keys = [msg.slice(4, 36), msg.slice(36, 68)];
    expect(base58.encode(keys[0])).toBe(e.address);
    expect(base58.encode(keys[1])).toBe(ffOrders.get('SO1')!.from && (ffOrders.get('SO1')!.from as { address: string }).address);
    expect(ed25519.verify(sig, msg, keys[0])).toBe(true);
    const data = msg.slice(msg.length - 12);
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(4, true)).toBe(2_000_000_000n - 5000n);
    // The order's token and the signed transaction never reach the browser.
    const view = await get('/api/stash');
    expect(view.body).not.toMatch(/SECRET/);
    expect(view.body).not.toContain(net.solSent[0].slice(0, 40));
  });

  it('refuses an order that pays out anywhere else, and sends nothing', async () => {
    const e = await engine.createAddress('SOL', { by: 'you' });
    net.sol.set(e.address, { processed: 2_000_000_000n, finalized: 2_000_000_000n });
    await engine.scanEntry(engine.getEntry(e.id)!);
    await engine.startMove(e.id, 'coinbase', { by: 'you' });
    ffPayoutOverride = '0x000000000000000000000000000000000000dEaD';
    const m = await runMove(e.id);
    expect(m.step).toBe('quote');
    expect(m.error).toMatch(/Refusing FixedFloat order/);
    expect(net.solSent).toHaveLength(0);
  });

  it('swaps to Monero at a fresh subaddress of its own account, which then shows up as held Monero', async () => {
    const e = await engine.createAddress('ETH-BASE', { by: 'you' });
    net.evm.set(e.address.toLowerCase(), 10n ** 18n);
    await engine.scanEntry(engine.getEntry(e.id)!);
    await engine.startMove(e.id, 'xmr', { by: 'you' });
    const m = await runMove(e.id);
    expect(m.step).toBe('sent');
    const target = engine.getEntry(m.xmrEntryId!)!;
    expect(target.asset).toBe('XMR');
    expect(target.from).toMatchObject({ kind: 'move', entryId: e.id });
    expect(ffCreates[0]).toMatchObject({ fromCcy: 'ETHBASE', toCcy: 'XMR', toAddress: target.address });
    const tx = parseTransaction(net.evmSent[0] as `0x${string}`);
    expect(tx.chainId).toBe(8453);
    expect(tx.to).toBe((ffOrders.get('SO1')!.from as { address: string }).address);
    // Gas and twice the L1 data fee are kept back.
    expect(tx.value! + 21_000n * tx.maxFeePerGas! + 2n * 30_000_000_000n).toBeLessThanOrEqual(10n ** 18n);
  });

  it('sends Bitcoin with exactly the quoted coins, and its order holds the pair for the transfers too', async () => {
    const e = await engine.createAddress('BTC', { by: 'you' });
    net.utxos.set(e.address, [{ txid: 'bb'.repeat(32), vout: 1, value: 20_000_000, status: { confirmed: true, block_height: 2_999_999 } }]);
    await engine.scanEntry(engine.getEntry(e.id)!);
    await engine.startMove(e.id, 'xmr', { by: 'you' });
    expect(pairBusy('BTC', 'XMR')).toBeNull();
    const m = await runMove(e.id);
    expect(m.step).toBe('sent');
    const tx = btc.Transaction.fromRaw(Buffer.from(net.utxoPosts[0], 'hex'));
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(tx.getOutput(0).script!))).toBe((ffOrders.get('SO1')!.from as { address: string }).address);
    expect(tx.getOutput(0).amount).toBe(20_000_000n - BigInt(m.quote!.fee));
    // Paid, not finished: a transfer must wait for it (FixedFloat's one order per pair).
    expect(pairBusy('BTC', 'XMR')?.id).toBe('SO1');
    (ffOrders.get('SO1') as { status: string }).status = 'DONE';
    (ffOrders.get('SO1') as { to: { tx: unknown } }).to.tx = { id: 'xmrout', amount: '1.5' };
    await engine.pollStashOrder(store.load().orders[0]);
    expect((await runMove(e.id, Date.now() + 60_000)).step).toBe('done');
    expect(pairBusy('BTC', 'XMR')).toBeNull();
  });

  it('can move a confirmed payment on its own (on arrival: Send to Coinbase)', async () => {
    store.load().settings.onArrival = 'coinbase';
    const e = await engine.createAddress('SOL', { by: 'you' });
    net.sol.set(e.address, { processed: 2_000_000_000n, finalized: 2_000_000_000n });
    await engine.scanEntry(engine.getEntry(e.id)!);
    const m = engine.getEntry(e.id)!.moves[0];
    expect(m).toMatchObject({ to: 'coinbase', by: 'auto', step: 'quote' });
  });

  it('refuses below the minimum up front', async () => {
    const e = await engine.createAddress('SOL', { by: 'you' });
    net.sol.set(e.address, { processed: 10_000_000n, finalized: 10_000_000n });
    await engine.scanEntry(engine.getEntry(e.id)!);
    await expect(engine.startMove(e.id, 'coinbase', { by: 'you' })).rejects.toThrow(/minimum/);
  });

  it('needs the password to move', async () => {
    const e = await engine.createAddress('SOL', { by: 'you' });
    const res = await post(`/api/stash/${e.id}/move`, { to: 'xmr', password: 'wrong' });
    expect(res.statusCode).toBe(401);
  });
});

describe('other coins (via FixedFloat)', () => {
  it('lists what FixedFloat takes, minus the held coins', async () => {
    const res = await get('/api/stash/coins');
    expect(res.json().coins.map((c: { code: string }) => c.code)).toEqual(['XRP', 'ZEC']);
  });

  it('makes a FixedFloat address that pays our own fresh Monero subaddress, memo included', async () => {
    const res = await post('/api/stash', { code: 'XRP', label: 'Dave' });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    const e = engine.getEntry(v.id)!;
    expect(e.asset).toBe('XMR');
    expect(ffCreates[0]).toMatchObject({ fromCcy: 'XRP', toCcy: 'XMR', toAddress: e.address });
    expect(v.address).toBe('rFixedFloatSharedDeposit');
    expect(v.via.tag).toBe('123456');
    expect(v.warning).toMatch(/memo/);
    expect(res.body).not.toMatch(/SECRET/);
  });

  it('refuses an order that pays another Monero address', async () => {
    ffPayoutOverride = xmrAddress('Someone');
    await expect(engine.createVia('ZEC', { by: 'you' })).rejects.toThrow(/Refusing/);
    expect(store.load().entries.every((e) => e.archived)).toBe(true);
  });

  it('pings when FixedFloat sees the payment', async () => {
    const e = await engine.createVia('ZEC', { label: 'Eve', by: 'you' });
    const o = ffOrders.get(e.via!.orderId)! as { status: string; from: { tx: { id: string | null; amount: string | null } } };
    const out = await pings(async () => {
      o.status = 'PENDING';
      o.from.tx = { id: 'zectx', amount: '3' };
      await engine.pollStashOrder(store.load().orders[0]);
      await engine.pollStashOrder(store.load().orders[0]);
    });
    expect(out.map((p) => p.key)).toEqual([`stash:via:${e.via!.orderId}:zectx`]);
    expect(engine.entryView(engine.getEntry(e.id)!).state).toBe('incoming');
  });
});

describe('OpenClaw (agent token)', () => {
  it('refuses without the token, with a wrong one, and from loopback alone', async () => {
    expect((await agentPost('/api/agent/address', { coin: 'sol' }, 'x'.repeat(40))).statusCode).toBe(401);
    const none = await app.inject({ method: 'POST', url: '/api/agent/address', headers: { host: '127.0.0.1:8787', 'x-wallet': '1', 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' }, payload: '{"coin":"sol"}' });
    expect(none.statusCode).toBe(401);
    expect((await get('/api/agent/wallet', { cookie })).statusCode).toBe(401); // a sign-in isn't the token either
    expect(store.load().entries).toHaveLength(0);
  });

  it('the token opens only the agent routes', async () => {
    const res = await app.inject({ url: '/api/stash', headers: { host: '127.0.0.1:8787', authorization: `Bearer ${AGENT}` } });
    expect(res.statusCode).toBe(401);
  });

  it('gives a fresh address every time, by any common name', async () => {
    const a = (await agentPost('/api/agent/address', { coin: 'solana', label: 'Frank' })).json();
    const b = (await agentPost('/api/agent/address', { coin: 'SOL' })).json();
    expect(a.address).toBe(SOL_FIRST);
    expect(b.address).not.toBe(a.address);
    expect(a.warning).toMatch(/Solana/);
    const z = await agentPost('/api/agent/address', { coin: 'zec' });
    expect(z.statusCode).toBe(200);
    expect(z.json().landsIn).toMatch(/Monero/);
    expect(store.load().entries.find((e) => e.address === SOL_FIRST)!.by).toBe('openclaw');
  });

  it('moves only to our own Monero or the address book, and pings that OpenClaw did it', async () => {
    const e = await engine.createAddress('SOL', { label: 'Gina', by: 'you' });
    net.sol.set(e.address, { processed: 2_000_000_000n, finalized: 2_000_000_000n });
    await engine.scanEntry(engine.getEntry(e.id)!);
    const out = await pings(async () => {
      const res = await agentPost('/api/agent/move', { id: e.id, to: 'coinbase', address: '0x000000000000000000000000000000000000dEaD' });
      expect(res.statusCode).toBe(200);
    });
    expect(out[0].text).toMatch(/OpenClaw/);
    await runMove(e.id);
    expect(ffCreates[0]).toMatchObject({ toAddress: PAYOUT_BASE });
    expect((await agentPost('/api/agent/move', { id: e.id, to: 'coinbase', destinationId: 'd_nope' })).statusCode).toBe(400);
  });

  it('lists balances without secrets', async () => {
    await engine.createAddress('SOL', { by: 'you' });
    const res = await app.inject({ url: '/api/agent/wallet', headers: { host: '127.0.0.1:8787', authorization: `Bearer ${AGENT}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(1);
    expect(res.body).not.toMatch(/SECRET|raw|token/);
  });
});

describe('separation', () => {
  it("never touches the transfers' files", async () => {
    await engine.createAddress('BTC', { by: 'you' });
    expect(fs.existsSync(path.join(dataDir, 'routes.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'orders.json'))).toBe(false);
    expect(btc.Address(btc.NETWORK).decode(store.load().entries[0].address).type).toBe('wpkh');
  });
});
