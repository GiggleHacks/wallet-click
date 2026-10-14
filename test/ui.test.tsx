// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Order } from '../web/src/types';
import { APP_VERSION } from '../web/src/version';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sounds = vi.hoisted(() => ({ ding: 0, swap: 0, send: 0, tada: 0, error: 0 }));
vi.mock('../web/src/lib/sound', () => {
  const count = (k: keyof typeof sounds) => () => void sounds[k]++;
  return {
    sfx: { tap() {}, open() {}, copy() {}, unlock() {}, ding: count('ding'), swap: count('swap'), send: count('send'), tada: count('tada'), error: count('error') },
    audioState: () => 'ready',
    primeAudio() {},
    setSoundTheme() {},
  };
});

const PAYOUT = '0x7E577e577e577E577e577E577E577E577e577E57';
const DEPOSIT = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const meta = {
  payout: { address: PAYOUT, label: 'Coinbase', ccy: 'USDT', network: 'Ethereum (ERC-20)' },
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
const calls: string[] = [];

function route(method: string, path: string, body: unknown): [number, unknown] {
  if (path === '/api/status') return [200, status];
  if (path === '/api/login') {
    loginBody = body;
    return [200, { ok: true }];
  }
  if (path === '/api/meta') return [200, meta];
  if (path === '/api/orders' && method === 'GET') return [200, { orders: serverOrders }];
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
    expect(text()).toContain('USDT');
    expect(text()).toContain('0x7E57…7E57');
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
    expect(text()).toContain('(1 of 2)');
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    expect(host.querySelector('[role="progressbar"]')).toBeTruthy();
    expect(sounds.ding).toBe(1);

    // It finishes between polls: every step still gets shown, in order.
    serverOrders = [{ ...serverOrders[0], stage: 'done', status: 'DONE', confirmations: 2, usdt: '208.31', usdtFinal: true, payoutTx: '0xout', payoutTxUrl: 'https://etherscan.io/tx/0xout' }];
    await waitFor(() => text().includes('to USDT…'), 'swapping step', 8000);
    await waitFor(() => text().includes('to Coinbase…'), 'sending step');
    await waitFor(() => text().includes('Done!'), 'done step');
    expect(text()).toContain('208.31 USDT');
    expect(sounds).toMatchObject({ ding: 1, swap: 1, send: 1, tada: 1, error: 0 });
    expect(host.querySelector('a[href="https://etherscan.io/tx/0xout"]')).toBeTruthy();
  });

  it('plays the "How it works" demo end to end without touching the server', async () => {
    status = { ...status, authed: true };
    serverOrders = [];
    Object.assign(sounds, { ding: 0, swap: 0, send: 0, tada: 0, error: 0 });
    await mount();
    await waitFor(() => !!button('How it works'), 'demo button');
    const before = calls.filter((c) => c.startsWith('POST')).length;
    await click(button('How it works'), 'How it works');
    await waitFor(() => text().includes('Receive Ethereum (demo)'), 'demo receive window');
    expect(text()).toContain('no money moves');
    expect(text()).not.toMatch(/0x[0-9a-fA-F]{40}(?!.*7E57)/); // no real-looking deposit address
    await waitFor(() => text().includes('Payment detected'), 'demo payment', 9000);
    expect(sounds.ding).toBe(1);
    await waitFor(() => text().includes('Done!'), 'demo done', 25_000);
    expect(text()).toContain('126.84 USDT');
    expect(sounds).toMatchObject({ ding: 1, swap: 1, send: 1, tada: 1, error: 0 });
    expect(calls.filter((c) => c.startsWith('POST')).length).toBe(before); // nothing was created
  }, 45_000);

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
});
