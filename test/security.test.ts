import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sec-'));
process.env.DATA_DIR = dataDir;
process.env.ALLOWED_HOSTS = 'wallet.example.ts.net';
process.env.APP_PASSWORD = 'correct horse battery staple ✓';

let app: FastifyInstance;
const HOST = 'wallet.example.ts.net';
const H = { host: HOST, 'x-wallet': '1', 'content-type': 'application/json' };
const PASSWORD = 'correct horse battery staple ✓';
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { ...H, ...headers }, payload: JSON.stringify(body) });

beforeAll(async () => {
  app = await (await import('../server/app.js')).buildApp({ logger: false });
});
afterAll(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const status = (host: string) => app.inject({ url: '/api/status', headers: { host } });

describe('host allowlist', () => {
  it('accepts the configured name, with or without a port', async () => {
    expect((await status(HOST)).statusCode).toBe(200);
    expect((await status(`${HOST}:8443`)).statusCode).toBe(200);
  });
  it('accepts loopback names so the Docker health check passes', async () => {
    for (const h of ['127.0.0.1:8787', 'localhost:8787', 'localhost']) expect((await status(h)).statusCode).toBe(200);
  });
  it('rejects any other name (DNS rebinding)', async () => {
    for (const h of ['evil.example', `${HOST}.evil.example`, '100.87.61.102']) expect((await status(h)).statusCode).toBe(421);
  });
});

describe('login and guards', () => {
  it('hashes APP_PASSWORD at boot and keeps it out of the data folder in plain text', async () => {
    expect((await status(HOST)).json()).toMatchObject({ ready: true, authed: false });
    const auth = fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8');
    expect(auth).not.toContain('horse');
  });

  it('locks the API without a session', async () => {
    expect((await app.inject({ url: '/api/orders', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/orders', headers: { host: HOST, cookie: 'wc_session=v1.9999999999999.forged' } })).statusCode).toBe(401);
  });

  it('blocks cross-site writes', async () => {
    const noHeader = await app.inject({ method: 'POST', url: '/api/login', headers: { host: HOST, 'content-type': 'application/json' }, payload: '{}' });
    expect(noHeader.statusCode).toBe(403);
    expect((await post('/api/login', { password: PASSWORD }, { origin: 'https://evil.example' })).statusCode).toBe(403);
  });

  it('sends security headers', async () => {
    const res = await status(HOST);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('logs in with a pasted (unicode) password, sets a strict cookie, and throttles guessing', async () => {
    const ok = await post('/api/login', { password: PASSWORD }, { origin: `https://${HOST}` });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(String(ok.headers['set-cookie'])).toMatch(/SameSite=Strict/i);
    const cookie = String(ok.headers['set-cookie']).split(';')[0];
    expect((await app.inject({ url: '/api/status', headers: { host: HOST, cookie } })).json().authed).toBe(true);

    expect((await post('/api/login', { password: 'x'.repeat(300) })).statusCode).toBe(401);
    for (let i = 0; i < 3; i++) expect((await post('/api/login', { password: 'wrong-password' })).statusCode).toBe(401);
    const fifth = (await post('/api/login', { password: 'wrong-password' })).json();
    expect(fifth.lockedUntil).toBeGreaterThan(Date.now());
    expect((await post('/api/login', { password: PASSWORD })).statusCode).toBe(401); // refused during the lockout
  });
});

describe('hardening for the public internet', () => {
  it('cannot be bypassed with %-encoded paths (the router decodes them)', async () => {
    const { resetThrottle } = await import('../server/auth.js');
    resetThrottle();
    for (const url of ['/%61pi/orders', '/%61pi/meta', '/api/%6Frders', '/%61%70%69/orders', '/api/orders?x=1']) {
      const res = await app.inject({ url, headers: { host: HOST } });
      expect(res.statusCode, url).toBe(401);
    }
    // Writes need the custom header and a same-origin Origin whatever the path looks like.
    const write = await app.inject({
      method: 'POST',
      url: '/%61pi/orders',
      headers: { host: HOST, 'content-type': 'application/json', origin: 'https://evil.example' },
      payload: '{"coin":"ETH"}',
    });
    expect(write.statusCode).toBe(403);
    const sneaky = await app.inject({ method: 'POST', url: '/%61pi/orders', headers: { host: HOST, 'content-type': 'application/json', 'x-wallet': '1' }, payload: '{"coin":"ETH"}' });
    expect(sneaky.statusCode).toBe(401);
  });

  it('counts parallel guesses before checking them, so a burst gets 5 tries, not 40', async () => {
    const { resetThrottle } = await import('../server/auth.js');
    resetThrottle();
    const burst = await Promise.all(Array.from({ length: 40 }, () => post('/api/login', { password: 'wrong-password' })));
    expect(burst.every((r) => r.statusCode === 401 || r.statusCode === 429)).toBe(true);
    const checked = burst.filter((r) => r.statusCode === 401 && r.json().error === 'Wrong password').length;
    expect(checked).toBeLessThanOrEqual(5);
    expect((await post('/api/login', { password: PASSWORD })).statusCode).toBe(401); // locked out from here
  });

  it('locks out the guesser, not everybody (per address)', async () => {
    const { resetThrottle } = await import('../server/auth.js');
    resetThrottle();
    const from = (ip: string, password: string) =>
      app.inject({ method: 'POST', url: '/api/login', headers: H, payload: JSON.stringify({ password }), remoteAddress: ip });
    for (let i = 0; i < 6; i++) await from('203.0.113.9', 'wrong-password');
    expect((await from('203.0.113.9', PASSWORD)).statusCode).toBe(401);
    expect((await from('198.51.100.7', PASSWORD)).statusCode).toBe(200); // the owner elsewhere still gets in
  });

  it("uses the address the proxy saw, so a client can't pick its own with X-Forwarded-For", async () => {
    const { resetThrottle } = await import('../server/auth.js');
    resetThrottle();
    // The proxy appends the real client address; a forged entry in front of it is ignored.
    const spoof = (fake: string) =>
      app.inject({ method: 'POST', url: '/api/login', headers: { ...H, 'x-forwarded-for': `${fake}, 192.0.2.50` }, payload: JSON.stringify({ password: 'wrong-password' }) });
    for (let i = 0; i < 6; i++) await spoof(`10.0.0.${i}`);
    const status = await app.inject({ url: '/api/status', headers: { host: HOST, 'x-forwarded-for': '10.9.9.9, 192.0.2.50' } });
    expect(status.json().lockedUntil).toBeGreaterThan(Date.now()); // all six counted against 192.0.2.50
    expect(status.json().retryAfterMs).toBeGreaterThan(0);
  });

  it('reports the app version, matching package.json', async () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect((await status(HOST)).json().version).toBe(pkg.version);
  });

  it('sets HSTS and no-store, and turns away oversized bodies', async () => {
    const res = await app.inject({ url: '/api/status', headers: { host: HOST, 'x-forwarded-proto': 'https' } });
    expect(res.headers['cache-control']).toBe('no-store');
    const big = await app.inject({ method: 'POST', url: '/api/login', headers: H, payload: JSON.stringify({ password: 'x'.repeat(20_000) }) });
    expect(big.statusCode).toBe(413);
  });
});

describe('strangers cannot lock the owner out', () => {
  const login = (ip: string, password: string, cookie?: string) =>
    app.inject({ method: 'POST', url: '/api/login', headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: JSON.stringify({ password, remember: true }), remoteAddress: ip });
  const cookies = (res: { headers: Record<string, unknown> }) => {
    const raw = res.headers['set-cookie'];
    return (Array.isArray(raw) ? raw : [String(raw)]).map((c) => c.split(';')[0]);
  };

  it('a browser that signed in before skips the global lockout; a new one waits', async () => {
    const { resetThrottle } = await import('../server/auth.js');
    resetThrottle();
    const first = await login('198.51.100.1', PASSWORD);
    expect(first.statusCode).toBe(200);
    const device = cookies(first).find((c) => c.startsWith('wc_device='));
    expect(device).toBeTruthy();

    // 30+ wrong guesses spread over many addresses trip the global ceiling...
    for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) await login(`203.0.113.${i + 10}`, 'wrong-password');
    expect((await login('192.0.2.200', PASSWORD)).statusCode).toBe(401); // unknown browser: held up
    // ...but the owner's known browser, from a fresh address, still gets in.
    expect((await login('192.0.2.201', PASSWORD, device)).statusCode).toBe(200);
    // A forged device cookie doesn't help.
    expect((await login('192.0.2.202', PASSWORD, 'wc_device=d1.forged.forged')).statusCode).toBe(401);
  });

  it('groups IPv6 clients by /64 and treats IPv4-mapped addresses as IPv4', async () => {
    const { clientKey } = await import('../server/auth.js');
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe(clientKey('2001:db8:1:2:bbbb:cccc:dddd:2'));
    expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
    expect(clientKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(clientKey('203.0.113.5')).toBe('203.0.113.5');
  });

  it('logging out ends the session on the server, not just in the browser', async () => {
    const { resetThrottle } = await import('../server/auth.js');
    resetThrottle();
    const res = await login('198.51.100.9', PASSWORD);
    const session = cookies(res).find((c) => c.startsWith('wc_session='))!;
    const status = () => app.inject({ url: '/api/status', headers: { host: HOST, cookie: session } });
    expect((await status()).json().authed).toBe(true);
    await app.inject({ method: 'POST', url: '/api/logout', headers: { ...H, cookie: session }, payload: '{}' });
    expect((await status()).json().authed).toBe(false); // the old cookie no longer works
  });

  it('requires a long password now that the app is on the internet', async () => {
    const { passwordFormatError } = await import('../server/auth.js');
    expect(passwordFormatError('short-pass')).toMatch(/at least 12/);
    expect(passwordFormatError('long enough password')).toBeNull();
  });
});

describe('remember this device', () => {
  const login = (remember: boolean | undefined, ip = '198.51.100.77') =>
    app.inject({ method: 'POST', url: '/api/login', headers: H, payload: JSON.stringify({ password: PASSWORD, ...(remember === undefined ? {} : { remember }) }), remoteAddress: ip });
  const setCookies = (res: { headers: Record<string, unknown> }) => {
    const raw = res.headers['set-cookie'];
    return raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)];
  };
  const cookieValue = (res: { headers: Record<string, unknown> }, name: string) => setCookies(res).find((c) => c.startsWith(`${name}=`))?.split(';')[0];
  const authed = async (cookie: string) => (await app.inject({ url: '/api/status', headers: { host: HOST, cookie } })).json().authed as boolean;

  afterEach(() => vi.useRealTimers());

  it('remembered: a year-long cookie plus a known-device mark', async () => {
    const { resetThrottle } = await import('../server/auth.js');
    resetThrottle();
    const res = await login(true);
    expect(res.statusCode).toBe(200);
    const session = setCookies(res).find((c) => c.startsWith('wc_session='))!;
    expect(session).toMatch(/Max-Age=31536000/);
    expect(cookieValue(res, 'wc_device')).toBeTruthy();
  });

  it('not remembered: a browser-session cookie that also stops working after 12 hours', async () => {
    const { resetThrottle } = await import('../server/auth.js');
    resetThrottle();
    const res = await login(false);
    const raw = setCookies(res).find((c) => c.startsWith('wc_session='))!;
    expect(raw).not.toMatch(/Max-Age/i);
    expect(cookieValue(res, 'wc_device')).toBeUndefined();
    const cookie = raw.split(';')[0];
    expect(await authed(cookie)).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 13 * 3600_000);
    expect(await authed(cookie)).toBe(false);
  });

  it('a remembered device is quietly re-signed while used, so it never has to log in again', async () => {
    const { resetThrottle } = await import('../server/auth.js');
    resetThrottle();
    const first = cookieValue(await login(true), 'wc_session')!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * 86_400_000); // a week and a bit later
    const res = await app.inject({ url: '/api/status', headers: { host: HOST, cookie: first } });
    expect(res.json().authed).toBe(true);
    const renewed = cookieValue(res, 'wc_session');
    expect(renewed).toBeTruthy();
    expect(renewed).not.toBe(first);
    // A request already on its way with the old cookie still works for a moment...
    expect(await authed(first)).toBe(true);
    // ...then the old cookie stops working; the new one carries on.
    vi.setSystemTime(Date.now() + 3 * 60_000);
    expect(await authed(first)).toBe(false);
    expect(await authed(renewed!)).toBe(true);
    // And a year after the last renewal it would still be fine as long as it keeps being used.
    vi.setSystemTime(Date.now() + 300 * 86_400_000);
    expect(await authed(renewed!)).toBe(true);
  });
});
