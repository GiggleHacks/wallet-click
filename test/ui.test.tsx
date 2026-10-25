// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Order, Transfer } from '../web/src/types';
import { APP_VERSION } from '../web/src/version';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sounds = vi.hoisted(() => ({ ding: 0, swap: 0, send: 0, tada: 0, error: 0, vaultLock: 0, shuffle: 0, vaultOpen: 0, boom: 0 }));
vi.mock('../web/src/lib/sound', () => {
  const count = (k: keyof typeof sounds) => () => void sounds[k]++;
  return {
    sfx: {
      tap() {},
      open() {},
      copy() {},
      unlock() {},
      ding: count('ding'),
      swap: count('swap'),
      send: count('send'),
      tada: count('tada'),
      error: count('error'),
      vaultLock: count('vaultLock'),
      shuffle: count('shuffle'),
      vaultOpen: count('vaultOpen'),
      tick() {},
      block() {},
      boom: count('boom'),
    },
    audioState: () => 'ready',
    primeAudio() {},
    setSoundTheme() {},
  };
});

/** Coinbase's USDC-on-Base address: where every swap pays out. */
const PAYOUT = '0xBA5eba5EBa5EbA5eBA5EBA5eBa5EBa5ebA5ebA5E';
const DEPOSIT = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const meta = {
  payout: { address: PAYOUT, label: 'Coinbase (USDC on Base)', ccy: 'USDCBASE', network: 'Base' },
  coins: { BTC: { name: 'Bitcoin', network: 'Bitcoin' }, ETH: { name: 'Ethereum', network: 'Ethereum mainnet' } },
  swapConfigured: true,
  version: APP_VERSION,
};
const baseOrder: Order = {
  id: 'K7Q2XZ',
  coin: 'BTC',
  coinName: 'Bitcoin',
  network: 'Bitcoin',
  address: DEPOSIT,
  createdAt: Date.now(),
  stage: 'waiting',
  status: 'NEW',
  min: '0.0001243',
  minUsd: 10.42,
  expiresAt: Date.now() + 30 * 60_000,
  received: null,
  confirmations: 0,
  requiredConfirmations: 2,
  blockMinutes: 10,
  depositTx: null,
  depositTxUrl: null,
  usdt: null,
  usdtFinal: false,
  payoutTx: null,
  payoutTxUrl: null,
  payoutAddress: PAYOUT,
  refundTx: null,
  emergency: null,
  autoContinued: false,
  autoError: null,
  reusedAddress: false,
  pollError: null,
  updatedAt: Date.now(),
};

let status = { ready: true, authed: false, lockedUntil: 0, retryAfterMs: 0, triesLeft: 5 };
let loginBody: unknown = null;
let serverOrders: Order[] = [];
let serverTransfers: Transfer[] = [];
let transferBody: unknown = null;
let onceBody: unknown = null;
let destinationBody: unknown = null;
/** The address book request fails (a failing call for the Logs window to show). */
let destinationsDown = false;
const coinbaseBaseDest = { id: 'coinbase-base', label: 'Coinbase (USDC on Base)', address: PAYOUT, ccy: 'USDCBASE' as const, createdAt: 0, builtIn: true };
const krakenDest = { id: 'd_kraken', label: 'Kraken', address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', ccy: 'USDCBASE' as const, createdAt: 1 };
/** What GET /api/destinations answers: the built-in Coinbase (USDC on Base) alone, unless a test adds more. */
let serverDestinations: { id: string; label: string; address: string; ccy: 'USDT' | 'USDCBASE'; createdAt: number; builtIn?: boolean }[] = [coinbaseBaseDest];
const serverLog = [
  { id: 1, run: 1, count: 1, at: Date.now() - 60_000, first: Date.now() - 60_000, level: 'info', msg: '[order K7Q2XZ] FixedFloat: NEW → PENDING, received 0.0015 BTC' },
  { id: 2, run: 2, count: 3, at: Date.now() - 30_000, first: Date.now() - 50_000, level: 'warn', msg: "[order K7Q2XZ] couldn't check with FixedFloat: timeout" },
  { id: 3, run: 3, count: 1, at: Date.now() - 10_000, first: Date.now() - 10_000, level: 'error', msg: 'POST /api/orders → 502 (812 ms)', detail: 'at createOrder (orders.js:12)' },
];
const calls: string[] = [];

const VAULT_LEG: Order = { ...baseOrder, id: 'PRIV01', coin: 'ETH', coinName: 'Ethereum', network: 'Ethereum mainnet', address: '0x1111111111111111111111111111111111111111', toCcy: 'XMR', transferId: 't_ui' };
const privacyTransfer = (over: Partial<Transfer> = {}): Transfer => ({
  id: 't_ui',
  createdAt: Date.now(),
  coin: 'ETH',
  coinName: 'Ethereum',
  privacy: true,
  delayHours: 12,
  routeId: null,
  routeLabel: null,
  destinationId: 'coinbase-base',
  destinationLabel: 'Coinbase (USDC on Base)',
  destinationAddress: PAYOUT,
  payoutCcy: 'USDCBASE',
  state: 'swap1',
  stage: 'waiting',
  received: null,
  usdt: null,
  payoutTxUrl: null,
  releaseAt: null,
  unlockedAt: null,
  xmr: null,
  steps: [
    { key: 'in', label: 'Ethereum payment', status: 'active', detail: 'Waiting for the payment', link: null },
    { key: 'swap1', label: 'Swap to Monero', status: 'pending', detail: null, link: null },
    { key: 'wait', label: 'Wait 12 hours', status: 'pending', detail: null, link: null },
  ],
  attention: null,
  error: null,
  waitingFor: null,
  canRelease: true,
  canChangeDelay: true,
  canRetry: false,
  leg1: VAULT_LEG,
  leg2: null,
  log: [],
  updatedAt: Date.now(),
  ...over,
});

function route(method: string, path: string, body: unknown): [number, unknown] {
  if (path === '/api/status') return [200, status];
  if (path === '/api/login') {
    loginBody = body;
    return [200, { ok: true }];
  }
  if (path === '/api/meta') return [200, meta];
  if (path.startsWith('/api/logs')) return [200, { lines: path.endsWith('after=0') ? serverLog : [], startedAt: Date.now() - 3_600_000 }];
  if (path === '/api/orders' && method === 'GET') return [200, { orders: serverOrders, transfers: serverTransfers }];
  if (path === '/api/transfers' && method === 'POST') {
    transferBody = body;
    serverTransfers = [privacyTransfer()];
    return [200, serverTransfers[0]];
  }
  if (path === '/api/destinations' && method === 'GET') return destinationsDown ? [404, { error: 'unmocked GET /api/destinations' }] : [200, { destinations: serverDestinations }];
  if (path === '/api/destinations' && method === 'POST') {
    destinationBody = body;
    const b = body as { label: string; address: string; ccy: 'USDT' | 'USDCBASE' };
    serverDestinations = [...serverDestinations, { id: 'd_new', label: b.label, address: b.address, ccy: b.ccy, createdAt: Date.now() }];
    return [200, { destinations: serverDestinations }];
  }
  if (path === '/api/minimums') return [200, { BTC: { direct: 10.42, intoMonero: 109 }, ETH: { direct: 12.72, intoMonero: 109 }, XMR: { direct: 9.97, intoMonero: null }, pieceFactor: 1.5 }];
  if (path === '/api/addresses/once' && method === 'POST') {
    onceBody = body;
    const b = body as { coin: 'BTC'; delayHours: number; pieces: number };
    return [200, { id: 'r_once', label: 'One-time BTC address', coin: b.coin, coinName: 'Bitcoin', mode: 'direct', delayHours: b.delayHours, pieces: b.pieces, oneTime: true, expiresAt: Date.now() + 30 * 86_400_000, destinationId: 'coinbase', destinationLabel: 'Coinbase', destinationAddress: PAYOUT, address: 'bc1qonetimeaddressxxxxxxxxxxxxxxxxxxxxxx', createdAt: Date.now(), archived: true }];
  }
  if (path === '/api/orders' && method === 'POST') {
    expect(body).toEqual({ coin: 'BTC' }); // the browser only ever names the coin
    serverOrders = [baseOrder];
    return [200, baseOrder];
  }
  return [404, { error: `unmocked ${method} ${path}` }];
}

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(url);
    calls.push(`${method} ${path}`);
    const [code, data] = route(method, path, init?.body ? JSON.parse(String(init.body)) : undefined);
    return { ok: code < 400, status: code, json: async () => data } as Response;
  }) as typeof fetch;
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});

let root: Root | null = null;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});

async function mount() {
  const { App } = await import('../web/src/App');
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<App />);
  });
}

async function waitFor(check: () => boolean, label: string, ms = 6000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for: ${label}\n\nDOM:\n${host.textContent?.slice(0, 800)}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
}

const setInput = async (el: HTMLInputElement, v: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const text = () => host.textContent ?? '';
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label) || b.getAttribute('aria-label') === label);
async function click(el: Element | undefined, label: string) {
  if (!el) throw new Error(`No element: ${label}\n\nDOM:\n${host.textContent?.slice(0, 800)}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe('Wallet Click UI', () => {
  it('logs on with a pasted password, then offers Bitcoin and Ethereum', async () => {
    await mount();
    await waitFor(() => text().includes('Type your password'), 'logon dialog');
    const field = host.querySelector('input.pw-input') as HTMLInputElement;
    expect(field.type).toBe('password');
    await setInput(field, 'pasted password 123');
    const remember = host.querySelector('.check98 input') as HTMLInputElement;
    expect(remember.checked).toBe(true); // "Remember this device" is on by default
    expect(text()).toContain('Remember this device');
    expect(text()).toContain(`Wallet Click v${APP_VERSION}`); // the version number sits on the sign-in screen
    await click(button('OK'), 'OK');
    expect(loginBody).toEqual({ password: 'pasted password 123', remember: true });
    await waitFor(() => text().includes('Get paid in'), 'home window');
    expect(button('Bitcoin')).toBeTruthy();
    expect(button('Ethereum')).toBeTruthy();
    expect(text()).toContain('USDC');
    expect(text()).toContain('0xBA5e…bA5E');
  });

  it('can hide amounts and addresses for privacy, and remembers the choice', async () => {
    status = { ...status, authed: true };
    serverOrders = [{ ...baseOrder, stage: 'done', status: 'DONE', received: '0.00250000', usdt: '123.45' }];
    localStorage.removeItem('wc.hideFigures');
    await mount();
    await waitFor(() => text().includes('0xBA5e…bA5E'), 'address preview');
    await waitFor(() => text().includes('123.45'), 'transfer list');
    expect(text()).toContain('0.0025');
    await click(host.querySelector('button[aria-label="Hide amounts and addresses"]'), 'Hide');
    expect(text()).not.toContain('0xBA5e');
    expect(text()).not.toContain('123.45');
    expect(text()).not.toContain('0.0025');
    expect(host.querySelector('.payout-line code')?.getAttribute('title')).toBeNull();
    expect(localStorage.getItem('wc.hideFigures')).toBe('1');
    await click(host.querySelector('button[aria-label="Show amounts and addresses"]'), 'Show');
    expect(text()).toContain('0xBA5e…bA5E');
    expect(text()).toContain('123.45');
    expect(localStorage.getItem('wc.hideFigures')).toBe('0');
    localStorage.removeItem('wc.hideFigures');
  });

  it('shows a fresh address with a QR code, then plays the whole swap when the payment lands', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    await mount();
    await waitFor(() => !!button('Bitcoin'), 'coin buttons');
    await click(button('Bitcoin'), 'Bitcoin');
    await waitFor(() => text().includes(DEPOSIT), 'receive window');
    expect(text()).toContain(DEPOSIT);
    expect(host.querySelector('svg[aria-label="QR code of the address"]')).toBeTruthy();
    expect(text()).toContain('Waiting for payment');
    expect(text()).toContain('0.0001243 BTC');
    expect(sounds.ding).toBe(0);

    // FixedFloat sees the payment: the watcher pops the transfer window and rings.
    serverOrders = [{ ...baseOrder, stage: 'received', status: 'PENDING', received: '0.00250000', confirmations: 1, depositTx: 'abc', depositTxUrl: 'https://mempool.space/tx/abc' }];
    await waitFor(() => text().includes('Payment received'), 'payment received', 8000);
    expect(text()).toContain('0.0025 BTC');
    expect(text()).toContain('Confirmations 1/2');
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    expect(host.querySelector('[role="progressbar"]')).toBeTruthy();
    expect(sounds.ding).toBe(1);

    // It finishes between polls: every step still gets shown, in order.
    serverOrders = [{ ...serverOrders[0], stage: 'done', status: 'DONE', confirmations: 2, usdt: '208.31', usdtFinal: true, payoutTx: '0xout', payoutTxUrl: 'https://etherscan.io/tx/0xout' }];
    await waitFor(() => text().includes('to USDC…'), 'swapping step', 8000);
    await waitFor(() => text().includes('to Coinbase…'), 'sending step');
    await waitFor(() => text().includes('Done!'), 'done step');
    expect(text()).toContain('208.31 USDC');
    expect(sounds).toMatchObject({ ding: 1, swap: 1, send: 1, tada: 1, error: 0 });
    expect(host.querySelector('a[href="https://etherscan.io/tx/0xout"]')).toBeTruthy();
  });

  it('sends through Monero in pieces from Send options, then shows the Monero wait with its countdown', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    serverTransfers = [];
    localStorage.removeItem('wc.sendOptions');
    await mount();
    await waitFor(() => text().includes('Straight to USDC · no wait · 1 piece'), 'send options box');
    expect(text()).not.toContain('Privacy Enhanced…');
    await click(button('Change…'), 'Change…');
    await waitFor(() => !!host.querySelector('.win-sendopts'), 'send options dialog');
    const inDialog = (label: string) => [...host.querySelectorAll('.win-sendopts button')].find((b) => b.textContent?.trim() === label);
    await click(inDialog('Through Monero'), 'Through Monero');
    expect(text()).toContain('about $110 or more');
    await click(inDialog('12 h'), '12 h');
    expect(text()).toContain('Wait in Monero: 12 h');
    await click(inDialog('3'), '3 pieces');
    expect(text()).toContain('Pieces: 3');
    expect(text()).toContain("can't be linked");
    // Into Monero needs about $110; with room to spare: $145 (BTC and ETH alike), and 3 × 1.5 × $9.97 for Monero.
    await waitFor(() => text().includes('Send ≥'), 'minimum note');
    expect(host.querySelector('.min-note')!.textContent).toMatch(/BTC \$145 · ETH \$145 · XMR \$60/);
    await click(inDialog('OK'), 'OK');
    await waitFor(() => !host.querySelector('.win-sendopts'), 'dialog closed', 3000);
    expect(text()).toContain('Through Monero · wait 12 h · 3 pieces');
    expect(text()).toContain('To be safe, send at least $145');
    expect(text()).toContain('Private · 12 h · 3 pieces'); // under each coin button
    await click(button('Ethereum'), 'Ethereum');
    expect(transferBody).toEqual({ coin: 'ETH', delayHours: 12, destinationId: 'coinbase-base', pieces: 3 }); // never an address
    await waitFor(() => text().includes(VAULT_LEG.address), 'receive window for the first swap');
    expect(text()).toContain('swapped to Monero first');

    // The payment went through and the Monero is waiting: the transfer window opens with the countdown.
    const releaseAt = Date.now() + 11 * 3_600_000;
    serverTransfers = [
      privacyTransfer({
        state: 'wait',
        stage: 'holding',
        received: '0.05',
        xmr: '0.2231',
        releaseAt,
        steps: [
          { key: 'in', label: 'Ethereum payment', status: 'done', detail: '0.05 ETH received', link: null },
          { key: 'swap1', label: 'Swap to Monero', status: 'done', detail: null, link: null },
          { key: 'wait', label: 'Wait 12 hours', status: 'active', detail: null, link: null },
        ],
      }),
    ];
    // It plays every moment from the payment on, then settles on the wait.
    await waitFor(() => text().includes('Holding 0.2231 XMR'), 'journey window', 25_000);
    expect(text()).toMatch(/for another 1[01] h/);
    expect(button('Release now')).toBeTruthy();
    expect(button('Change wait…')).toBeTruthy();
    serverTransfers = [];
    localStorage.removeItem('wc.sendOptions');
  }, 45_000);

  it('gives a one-time address of our own wallet when a coin button has a wait', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    serverTransfers = [];
    localStorage.setItem('wc.sendOptions', JSON.stringify({ route: 'direct', delayHours: 4, pieces: 2 }));
    await mount();
    await waitFor(() => text().includes('BTC · 4 h · 2 pieces'), 'coin button with its options');
    await click(button('Bitcoin'), 'Bitcoin');
    expect(onceBody).toEqual({ coin: 'BTC', delayHours: 4, pieces: 2, destinationId: 'coinbase-base' });
    await waitFor(() => text().includes('bc1qonetimeaddress'), 'one-time address');
    expect(text()).toContain('One-time address');
    expect(text()).toContain('4 h wait');
    expect(text()).toContain('2 pieces');
    // 2 pieces × 1.5 × $10.42 = $31.26 at least; with room to spare, $45.
    await waitFor(() => !!host.querySelector('.min-note'), 'minimum note');
    expect(host.querySelector('.min-note')!.textContent).toContain('Send ≥ $45');
    expect(host.querySelector('.min-note')!.textContent).toContain('the minimum is about $31.26');
    expect(host.querySelector('.min-note')!.textContent).toContain('below about $10.42 it waits for more');
    localStorage.removeItem('wc.sendOptions');
  });

  it('lists the pieces of a split payment in its transfer window', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    const piece = (n: number, over: object) => ({ id: `t_p${n}`, n, of: 3, coin: 'XMR' as const, amount: '0.3', stage: 'waiting' as const, releaseAt: null, usdt: null, payoutTxUrl: null, attention: null, waitingFor: null, ...over });
    serverTransfers = [
      privacyTransfer({
        state: 'pieces',
        stage: 'holding',
        monero: true,
        pieces: 3,
        received: '0.05',
        xmr: '0.9',
        unlockedAt: Date.now() - 3_600_000,
        nextPieceAt: Date.now() + 40 * 60_000,
        pieceList: [piece(1, { stage: 'done', usdt: '50', payoutTxUrl: 'https://etherscan.io/tx/0xp1' }), piece(2, { releaseAt: Date.now() + 40 * 60_000 }), piece(3, {})],
      }),
    ];
    await mount();
    await waitFor(() => text().includes('1 of 3 sent'), 'list status');
    expect(text()).toContain('×3');
    await click(host.querySelector('.listview tbody tr') ?? undefined, 'transfer row');
    await waitFor(() => !!host.querySelector('.pieces-list'), 'pieces list');
    const list = host.querySelector('.pieces-list')!.textContent!;
    expect(list).toContain('Sent: 50.00 USDC');
    expect(list).toMatch(/Goes in (39|40) min/);
    expect(list).toContain('A random 5 min–2 h after piece 2');
    expect(host.querySelector('.pieces-list a[href="https://etherscan.io/tx/0xp1"]')).toBeTruthy();
    serverTransfers = [];
  });

  it('plays the "How it works" demo end to end without touching the server', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    Object.assign(sounds, { ding: 0, swap: 0, send: 0, tada: 0, error: 0, vaultLock: 0, shuffle: 0, vaultOpen: 0 });
    await mount();
    await waitFor(() => !!button('How it works'), 'demo button');
    const before = calls.filter((c) => c.startsWith('POST')).length;
    await click(button('How it works'), 'How it works');
    // A picker: one button per flow.
    await waitFor(() => text().includes('Pretend coins'), 'demo picker');
    const pick = (label: string) => [...host.querySelectorAll('.win-picker button')].find((b) => b.textContent?.includes(label));
    expect(pick('Bitcoin') && pick('Monero') && pick('Privacy Enhanced')).toBeTruthy();
    await click(pick('Ethereum'), 'Ethereum');
    await waitFor(() => text().includes('Receive Ethereum (demo)'), 'demo receive window');
    expect(text()).toContain('Demo: not a real address');
    expect(text()).not.toMatch(/0x[0-9a-fA-F]{40}(?!.*7E57)/); // no real-looking deposit address
    await waitFor(() => text().includes('Payment detected'), 'demo payment', 9000);
    expect(sounds.ding).toBe(1);
    await waitFor(() => text().includes('Done!'), 'demo done', 25_000);
    expect(text()).toContain('126.84 USDC');
    expect(text()).toContain('Swap cost ≈ $1.37 (1.1%)'); // what it cost, at the end
    expect(sounds).toMatchObject({ ding: 1, swap: 1, send: 1, tada: 1, error: 0 });
    expect(calls.filter((c) => c.startsWith('POST')).length).toBe(before); // nothing was created
  }, 45_000);

  it('previews a payment to a permanent address: it lands, is forwarded, swapped and sent', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    serverTransfers = [];
    Object.assign(sounds, { ding: 0, swap: 0, send: 0, tada: 0, error: 0, vaultLock: 0, shuffle: 0, vaultOpen: 0 });
    await mount();
    await waitFor(() => !!button('How it works'), 'demo button');
    const before = calls.filter((c) => c.startsWith('POST')).length;
    await click(button('How it works'), 'How it works');
    await waitFor(() => text().includes('When you send to one of your permanent addresses'), 'demo picker');
    await click([...host.querySelectorAll('.win-picker button')].find((b) => b.textContent?.includes('You send BTC from your phone')), 'permanent: straight to USDT');
    // No address window: you send from your phone, and the transfer window opens when it lands.
    await waitFor(() => text().includes('Payment at "Phone → Coinbase"'), 'payment at the permanent address', 10_000);
    expect(host.querySelector('.journey-strip .stack-badge')).toBeTruthy();
    expect(host.querySelector('.journey-strip.is-five')).toBeNull();
    await waitFor(() => text().includes('Forwarding to FixedFloat'), 'forward', 10_000);
    await waitFor(() => text().includes('Done!'), 'route demo done', 20_000);
    expect(text()).toContain('124.03 USDC');
    expect(sounds).toMatchObject({ ding: 1, swap: 1, send: 1, tada: 1, error: 0, vaultLock: 0 });
    expect(calls.filter((c) => c.startsWith('POST')).length).toBe(before);
  }, 60_000);

  it('plays the Privacy Enhanced demo: swap to Monero, the vault, a time-lapse wait, swap to USDC', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    serverTransfers = [];
    Object.assign(sounds, { ding: 0, swap: 0, send: 0, tada: 0, error: 0, vaultLock: 0, shuffle: 0, vaultOpen: 0 });
    await mount();
    await waitFor(() => !!button('How it works'), 'demo button');
    const before = calls.filter((c) => c.startsWith('POST')).length;
    await click(button('How it works'), 'How it works');
    await waitFor(() => text().includes('Pretend coins'), 'demo picker');
    await click([...host.querySelectorAll('.win-picker button')].find((b) => b.textContent?.includes('Privacy Enhanced')), 'Privacy Enhanced');
    await waitFor(() => text().includes('Receive Bitcoin (demo)'), 'demo receive window');
    expect(text()).toContain('swapped to Monero first');
    await waitFor(() => text().includes('Payment received'), 'privacy demo payment', 10_000);
    expect(host.querySelector('.journey-strip.is-five')).toBeTruthy();
    await waitFor(() => !!host.querySelector('.vault3d.is-closed'), 'vault door shuts', 20_000);
    await waitFor(() => text().includes('Moving it within your wallet'), 'churn', 10_000);
    expect(host.querySelector('.churn-hop')).toBeTruthy();
    await waitFor(() => text().includes('Time-lapse'), 'time-lapse wait', 10_000);
    expect(text()).toMatch(/Holding 0\.2231 XMR for another/);
    expect(host.querySelector('.bomb-icon.is-ticking')?.textContent).toContain('≈ $120.85');
    expect(host.querySelector('.vault-ring.is-wait')).toBeTruthy();
    await waitFor(() => text().includes('Done!'), 'privacy demo done', 30_000);
    expect(text()).toContain('118.42 USDC');
    expect(text()).toContain('Swap cost ≈ $4.61 (3.7%)'); // fees only…
    expect(text()).toContain('Monero price moved −$3.07 while waiting'); // …the price move shown apart
    expect(sounds).toMatchObject({ ding: 1, swap: 2, send: 2, vaultLock: 1, shuffle: 1, vaultOpen: 1, tada: 1, error: 0, boom: 1 });
    await waitFor(() => !host.querySelector('.bomb-icon'), 'bomb gone once the money has landed', 3000);
    expect(calls.filter((c) => c.startsWith('POST')).length).toBe(before); // nothing was created
  }, 90_000);

  it('previews the animations on their own, a moment at a time, without touching the server', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    serverTransfers = [];
    await mount();
    await waitFor(() => !!button('How it works'), 'demo button');
    const before = calls.filter((c) => c.startsWith('POST')).length;
    await click(button('How it works'), 'How it works');
    await waitFor(() => text().includes('Just the animations'), 'demo picker');
    await click([...host.querySelectorAll('.win-picker button')].find((b) => b.textContent?.includes('Animations')), 'Animations');
    await waitFor(() => !!host.querySelector('.win-anim'), 'animations window');
    const moment = (label: string) => [...host.querySelectorAll('.anim-moments button')].find((b) => b.textContent === label);
    expect(host.querySelectorAll('.win-anim .courier').length).toBe(2); // back and front canvases
    await click(moment('Swapping'), 'Swapping');
    expect(moment('Swapping')!.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('.win-anim .station.is-working')).toBeTruthy();
    expect((host.querySelector('.anim-auto input') as HTMLInputElement).checked).toBe(false); // picking one stops auto-play
    await click([...host.querySelectorAll('.win-anim .anim-bar button')].find((b) => b.textContent?.includes('Privacy')), 'Privacy');
    await waitFor(() => !!host.querySelector('.win-anim .journey-strip.is-five'), 'five-station strip');
    await click(moment('Unlocking'), 'Unlocking');
    expect(host.querySelector('.win-anim .vault3d.is-closed')).toBeTruthy();
    // Smooth / Retro / Calm: one setting, shared with Themes and the Start menu.
    expect(host.querySelector('.anim-style [aria-checked="true"]')?.textContent).toBe('Retro'); // the default
    await click([...host.querySelectorAll('.anim-style button')].find((b) => b.textContent === 'Smooth'), 'Smooth');
    expect(document.documentElement.dataset.anim).toBe('smooth');
    await click([...host.querySelectorAll('.anim-style button')].find((b) => b.textContent === 'Retro'), 'Retro');
    expect(document.documentElement.dataset.anim).toBe('retro');
    expect(document.documentElement.dataset.motion).toBe('full');
    expect(localStorage.getItem('wc.retro')).toBe('1');
    await click([...host.querySelectorAll('.anim-style button')].find((b) => b.textContent === 'Calm'), 'Calm');
    expect(document.documentElement.dataset.motion).toBe('calm');
    await click([...host.querySelectorAll('.anim-style button')].find((b) => b.textContent === 'Smooth'), 'Smooth');
    expect(document.documentElement.dataset.anim).toBe('smooth');
    expect(document.documentElement.dataset.motion).toBe('full');
    expect(calls.filter((c) => c.startsWith('POST')).length).toBe(before);
  });

  const option = (label: string) => [...host.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(label));
  const desktopIcon = (label: string) => [...host.querySelectorAll('.desk-icon')].find((b) => b.textContent?.includes(label));

  it('changes the desktop background from the Themes dialog', async () => {
    status = { ...status, authed: true };
    localStorage.clear();
    await mount();
    await waitFor(() => !!desktopIcon('Themes'), 'themes icon');
    await click(desktopIcon('Themes'), 'Themes');
    await waitFor(() => text().includes('Display Properties'), 'display dialog');
    await click(button('Background'), 'Background tab');
    await click(option('Windows 95 Sky'), 'Windows 95 Sky');
    await click(button('OK'), 'OK');
    expect((host.querySelector('.desktop') as HTMLElement).dataset.wallpaper).toBe('clouds');
    expect(localStorage.getItem('wc.wallpaper')).toBe('clouds');
    expect(document.documentElement.dataset.theme).toBe('win98'); // the background alone doesn't change the theme
  });

  it('switches the whole look to Windows 11 and remembers it', async () => {
    status = { ...status, authed: true };
    localStorage.clear();
    await mount();
    await click(desktopIcon('Themes'), 'Themes');
    await waitFor(() => !!option('Windows 11'), 'theme list');
    await click(option('Windows 11'), 'Windows 11');
    expect(text()).toContain('Rounded glass windows');
    await click(button('OK'), 'OK');
    expect(document.documentElement.dataset.theme).toBe('win11');
    expect(document.documentElement.dataset.shell).toBe('win11');
    expect(localStorage.getItem('wc.theme')).toBe('win11');
    expect(localStorage.getItem('wc.wallpaper')).toBe('bloom11'); // a theme brings its own wallpaper
    await waitFor(() => text().includes('Personalization') || !text().includes('Display Properties'), 'dialog closed');
    // Windows 11 shell: icon-only Start button and the pinned Start menu.
    await click(host.querySelector('.start-btn') ?? undefined, 'Start');
    await waitFor(() => text().includes('Pinned'), 'Windows 11 Start menu');
    expect(host.querySelector('.s11-search')).toBeTruthy();
    localStorage.clear();
  });

  it('applies a theme the moment you click it, and Cancel puts the old one back', async () => {
    status = { ...status, authed: true };
    localStorage.clear();
    await mount();
    await click(desktopIcon('Themes'), 'Themes');
    await waitFor(() => !!option('Windows 10'), 'theme list');
    expect(button('Apply')).toBeUndefined(); // nothing to apply: it's instant
    await click(option('Windows 10'), 'Windows 10');
    expect(document.documentElement.dataset.theme).toBe('win10'); // no OK needed
    expect(localStorage.getItem('wc.theme')).toBe('win10');
    await click(option('Windows 95'), 'Windows 95');
    expect(document.documentElement.dataset.theme).toBe('win95');
    await click(button('Cancel'), 'Cancel');
    expect(document.documentElement.dataset.theme).toBe('win98');
    expect(localStorage.getItem('wc.theme')).toBe('win98');
    expect((host.querySelector('.desktop') as HTMLElement).dataset.wallpaper).toBe('teal');
    localStorage.clear();
  });

  it('has a dark mode for every theme: Light, Dark or Match device (the default)', async () => {
    status = { ...status, authed: true };
    localStorage.clear();
    await mount();
    expect(document.documentElement.dataset.mode).toBe('light'); // Match device, and the (fake) device is light
    await click(desktopIcon('Themes'), 'Themes');
    await waitFor(() => text().includes('Appearance'), 'appearance choice');
    expect(text()).toContain('light right now');
    const radio = (label: string) => [...host.querySelectorAll('.mode98 [role="radio"]')].find((b) => b.textContent === label);
    expect(radio('Match device')?.getAttribute('aria-checked')).toBe('true');
    await click(radio('Dark'), 'Dark');
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(localStorage.getItem('wc.mode')).toBe('dark');
    // Each theme keeps it.
    for (const t of ['Windows 95', 'Windows 10', 'Windows 11', 'Windows 98']) {
      await click(option(t), t);
      expect(document.documentElement.dataset.mode).toBe('dark');
    }
    await click(button('OK'), 'OK');
    expect(document.documentElement.dataset.theme).toBe('win98');
    expect(localStorage.getItem('wc.mode')).toBe('dark');
    localStorage.clear();
  });

  it('puts a long Privacy wait on the desktop as a countdown bomb with its dollar value, and it goes BOOM at zero', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    const waiting = (over: Partial<Transfer>) => privacyTransfer({ state: 'wait', stage: 'holding', received: '0.05', xmr: '0.2231', usdValue: 118.42, ...over });
    serverTransfers = [
      waiting({ id: 't_long', delayHours: 24, releaseAt: Date.now() + 5 * 3_600_000 + 7 * 60_000 }),
      waiting({ id: 't_soon', delayHours: 4, releaseAt: Date.now() + 1500, usdValue: 233.04 }),
      privacyTransfer({ id: 't_done', state: 'done', stage: 'done', delayHours: 24, usdt: '99.10' }),
      privacyTransfer({ id: 't_unpaid', delayHours: 24 }), // nothing paid in yet: no bomb
    ];
    Object.assign(sounds, { boom: 0 });
    await mount();
    await waitFor(() => host.querySelectorAll('.bomb-icon').length === 2, 'two bombs');
    const long = [...host.querySelectorAll('.bomb-icon')].find((b) => b.textContent?.includes('118.42')) as HTMLElement;
    expect(long.querySelector('.bomb-timer')?.textContent).toMatch(/^05:0[67]:\d\d$/);
    expect(long.textContent).toContain('→ Coinbase');
    expect(long.querySelector('.bomb-spark')).toBeTruthy(); // the fuse is lit

    // The short one runs out: BOOM, then a USDC coin while it swaps.
    await waitFor(() => !!host.querySelector('.bomb-icon.is-boom'), 'boom', 5000);
    expect(sounds.boom).toBe(1);
    const blown = host.querySelector('.bomb-icon.is-boom') as HTMLElement;
    expect(blown.textContent).toContain('00:00:00');
    expect(blown.textContent).toContain('Swapping…');
    expect(blown.textContent).toContain('≈ $233.04');

    // Clicking a bomb opens its transfer.
    await click(long, 'bomb');
    await waitFor(() => text().includes('Holding 0.2231 XMR'), 'transfer window');
    serverTransfers = [];
  }, 20_000);

  it('shows the server log and this browser’s errors in a Logs window', async () => {
    status = { ...status, authed: true };
    destinationsDown = true;
    serverOrders = [];
    serverTransfers = [];
    await mount();
    await waitFor(() => !!desktopIcon('Logs'), 'Logs icon');
    await click(desktopIcon('Logs'), 'Logs');
    await waitFor(() => text().includes('NEW → PENDING'), 'server log lines');
    expect(text()).toContain("couldn't check with FixedFloat: timeout×3"); // a repeat is one line with a count
    expect(text()).toMatch(/browser\s*GET \/api\/destinations → 404/); // what failed in this browser
    const seg = (label: string) => [...host.querySelectorAll('.win-logs .seg-btn')].find((b) => b.textContent === label);
    await click(seg('Errors'), 'Errors');
    expect(text()).not.toContain('NEW → PENDING');
    expect(text()).toContain('POST /api/orders → 502');
    // An error's stack opens with a click.
    await click(host.querySelector('.log-row.has-detail') ?? undefined, 'error row');
    expect(text()).toContain('at createOrder (orders.js:12)');
    await click(button('Close'), 'close');
    await waitFor(() => !host.querySelector('.win-logs'), 'Logs closed', 3000);
    destinationsDown = false;
  });

  it('pays USDC on Base to the built-in Coinbase destination, and lets you pick another saved one', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    serverTransfers = [];
    serverDestinations = [coinbaseBaseDest];
    localStorage.removeItem('wc.sendOptions');
    localStorage.removeItem('wc.destination');
    await mount();
    await waitFor(() => text().includes('Everything arrives as USDC in'), 'payout line');
    expect(text()).toContain('Coinbase (USDC on Base)');
    expect(text()).not.toContain('USDT');
    expect(host.querySelector('#dest-pick')).toBeNull(); // only one destination: nothing to pick
    expect(host.querySelector('.payout-line svg[aria-label="USDC"]')).toBeTruthy();
    expect(text()).toContain('Straight to USDC · no wait · 1 piece');
    act(() => root?.unmount());
    host.remove();

    // A saved destination appears in the menu; a coin button with a wait names it (never an address).
    serverDestinations = [coinbaseBaseDest, krakenDest];
    await mount();
    await waitFor(() => !!host.querySelector('#dest-pick'), 'destination menu');
    const menu = host.querySelector('#dest-pick') as HTMLSelectElement;
    expect([...menu.options].map((o) => o.textContent)).toEqual(['Coinbase (USDC on Base)', 'Kraken (USDC on Base)']);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(menu, 'd_kraken');
      menu.dispatchEvent(new Event('change', { bubbles: true }));
    });
    localStorage.setItem('wc.sendOptions', JSON.stringify({ route: 'direct', delayHours: 4, pieces: 1 }));
    act(() => window.dispatchEvent(new Event('wc:prefs')));
    await click(button('Bitcoin'), 'Bitcoin');
    expect(onceBody).toEqual({ coin: 'BTC', delayHours: 4, pieces: 1, destinationId: 'd_kraken' });
    await waitFor(() => text().includes('bc1qonetimeaddress'), 'one-time address');
    serverDestinations = [coinbaseBaseDest];
    localStorage.removeItem('wc.sendOptions');
    localStorage.removeItem('wc.destination');
  });

  it('saves a USDC-on-Base address in the Address Book, with the password', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    serverTransfers = [];
    serverDestinations = [coinbaseBaseDest];
    await mount();
    await waitFor(() => !!desktopIcon('Address Book'), 'Address Book icon');
    await click(desktopIcon('Address Book'), 'Address Book');
    await waitFor(() => !!host.querySelector('.win-book'), 'Address Book');
    expect(text()).toContain('USDC on Base');
    expect(text()).not.toContain('USDT');
    await click(button('Add…'), 'Add…');
    const inBook = (label: string) => [...host.querySelectorAll('.win-book button')].find((b) => b.textContent?.includes(label));
    expect(text()).toContain('USDC on Base deposit address');
    expect(inBook('USDT')).toBeUndefined(); // no asset to pick any more
    const inputs = [...host.querySelectorAll('.win-book input')] as HTMLInputElement[];
    await setInput(inputs[0], 'Kraken');
    await setInput(inputs[1], '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    await setInput(host.querySelector('.win-book input.pw-input') as HTMLInputElement, 'my password 123');
    await click(inBook('Save'), 'Save');
    expect(destinationBody).toEqual({ label: 'Kraken', address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', ccy: 'USDCBASE', password: 'my password 123' });
    await waitFor(() => [...host.querySelectorAll('.win-book .book-name')].some((e) => e.textContent === 'Kraken'), 'new destination listed');
    serverDestinations = [coinbaseBaseDest];
  });

  it('shows USDC on a finished transfer, with its Basescan link', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    serverTransfers = [
      privacyTransfer({
        id: 't_base',
        state: 'done',
        stage: 'done',
        received: '0.05',
        usdt: '99.10',
        payoutTxUrl: 'https://basescan.org/tx/0xbase',
        steps: [{ key: 'out', label: 'USDC to Coinbase (USDC on Base)', status: 'done', detail: '99.10 USDC', link: 'https://basescan.org/tx/0xbase' }],
      }),
    ];
    await mount();
    await waitFor(() => host.querySelectorAll('.listview tbody tr').length > 0, 'transfer row');
    await click(host.querySelector('.listview tbody tr') ?? undefined, 'transfer row');
    await waitFor(() => text().includes('Transfer complete'), 'transfer window', 20_000);
    await waitFor(() => text().includes('sent to Coinbase (USDC on Base)'), 'done line', 20_000);
    expect(text()).toContain('99.10 USDC');
    expect(text()).not.toContain('USDT');
    expect(host.querySelector('a[href="https://basescan.org/tx/0xbase"]')).toBeTruthy();
    serverTransfers = [];
  }, 45_000);

  it('still shows an older transfer that paid USDT as USDT, with its Etherscan link', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    serverTransfers = [
      privacyTransfer({
        id: 't_old',
        state: 'done',
        stage: 'done',
        payoutCcy: 'USDT',
        destinationId: 'coinbase',
        destinationLabel: 'Coinbase',
        destinationAddress: '0x7E577e577e577E577e577E577E577E577e577E57',
        received: '0.05',
        usdt: '88.20',
        payoutTxUrl: 'https://etherscan.io/tx/0xold',
        steps: [{ key: 'out', label: 'USDT to Coinbase', status: 'done', detail: '88.20 USDT', link: 'https://etherscan.io/tx/0xold' }],
      }),
    ];
    await mount();
    await waitFor(() => host.querySelectorAll('.listview tbody tr').length > 0, 'transfer row');
    await click(host.querySelector('.listview tbody tr') ?? undefined, 'transfer row');
    await waitFor(() => text().includes('sent to Coinbase.'), 'done line', 20_000);
    expect(text()).toContain('88.20 USDT');
    expect(host.querySelector('a[href="https://etherscan.io/tx/0xold"]')).toBeTruthy();
    serverTransfers = [];
  }, 45_000);

  it('always shows the version in the taskbar', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    serverTransfers = [];
    await mount();
    await waitFor(() => !!host.querySelector('.taskbar'), 'taskbar');
    expect(host.querySelector('.taskbar .tray-version')?.textContent).toBe(`v${APP_VERSION}`);
  });

  it('lists many recent transfers (not just the last twelve), in a box that scrolls', async () => {
    status = { ...status, authed: true };
    serverTransfers = [];
    serverOrders = Array.from({ length: 30 }, (_, i) => ({ ...baseOrder, id: `ORD${i}`, stage: 'done' as const, received: '0.001', usdt: '80.00', createdAt: Date.now() - i * 3_600_000 }));
    await mount();
    await waitFor(() => host.querySelectorAll('.listview tbody tr').length > 0, 'transfer list');
    expect(host.querySelectorAll('.listview tbody tr')).toHaveLength(30);
    serverOrders = [];
  });
});
