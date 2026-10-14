import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { readJson, writeJsonAtomic } from './store.js';

interface AuthFile {
  hash: string;
  salt: string;
  sessionSecret: string;
  updatedAt: string;
  /**
   * Ended sessions: id -> expiry, or [expiry, effectiveAt] when the end is delayed a moment (a renewed
   * session keeps working briefly so requests already in flight don't fail). Kept until expiry.
   */
  revoked?: Record<string, number | [number, number]>;
}

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT_OPTS: crypto.ScryptOptions = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** The app is reachable from the internet, so the password has to be long enough to resist guessing. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
export const COOKIE_NAME = 'wc_session';
/** Marks a browser that has signed in before; it skips the global (many-strangers) lockout. */
export const DEVICE_COOKIE = 'wc_device';
export const DEVICE_MAX_AGE_SEC = 365 * 86_400;

const authFile = () => path.join(config.dataDir, 'auth.json');
let cache: AuthFile | null = null;

function load(): AuthFile | null {
  cache ??= readJson<AuthFile>(authFile());
  return cache;
}

function save(): void {
  if (cache) writeJsonAtomic(authFile(), cache);
}

export const hasPassword = () => load() !== null;

export function passwordFormatError(password: unknown): string | null {
  if (typeof password !== 'string' || !password) return 'Enter a password';
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return 'That password is too long';
  return null;
}

export async function setPassword(password: string): Promise<void> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT_OPTS);
  cache = {
    hash: hash.toString('base64'),
    salt: salt.toString('base64'),
    // A new secret signs out every existing session and forgets every known device.
    sessionSecret: crypto.randomBytes(32).toString('base64'),
    updatedAt: new Date().toISOString(),
    revoked: {},
  };
  save();
}

// Each scrypt check takes ~32 MB and real CPU. Run them one at a time and turn away floods, so a
// burst of login attempts from the internet can't exhaust the server's memory.
const MAX_QUEUED_CHECKS = 8;
let queued = 0;
let gate: Promise<unknown> = Promise.resolve();

export class BusyError extends Error {}

async function passwordMatches(password: string): Promise<boolean> {
  const a = load();
  if (!a) return false;
  if (queued >= MAX_QUEUED_CHECKS) throw new BusyError('Too many sign-in attempts at once. Try again in a moment.');
  queued++;
  const run = gate.then(() => scrypt(password.normalize('NFKC'), Buffer.from(a.salt, 'base64'), 32, SCRYPT_OPTS));
  gate = run.catch(() => undefined);
  try {
    return crypto.timingSafeEqual(await run, Buffer.from(a.hash, 'base64'));
  } finally {
    queued--;
  }
}

/** Makes the stored password match APP_PASSWORD. Sessions are only rotated when it actually changed. */
export async function adoptPassword(password: string): Promise<void> {
  const formatError = passwordFormatError(password);
  if (formatError) throw new Error(`APP_PASSWORD: ${formatError}`);
  if (hasPassword() && (await passwordMatches(password))) return;
  await setPassword(password);
}

// ---------------------------------------------------------------- brute-force throttle

/**
 * Who is guessing. IPv6 users usually control a whole /64, so it counts as one client;
 * IPv4-mapped IPv6 addresses count as the IPv4 address.
 */
export function clientKey(ip: string): string {
  const bare = ip.replace(/%.*$/, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) return mapped[1];
  if (!bare.includes(':')) return bare;
  const [head, tail] = bare.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

// Per client: 5 free tries, then lockouts of 30s, 1m, 2m, 4m ... capped at 1h. A global ceiling (many
// failures from many clients) slows distributed guessing; browsers that have signed in before (the
// device cookie) and already-signed-in users (refunds) aren't held up by it, so strangers can't lock
// the owner out.
const FREE_TRIES = 5;
const GLOBAL_WINDOW_MS = 10 * 60_000;
const GLOBAL_MAX_FAILURES = 30;
const MAX_TRACKED = 5000;

interface Strikes {
  failures: number;
  lockedUntil: number;
  last: number;
}
const strikes = new Map<string, Strikes>();
let globalFailures: number[] = [];

function globalLockUntil(now: number): number {
  globalFailures = globalFailures.filter((t) => now - t < GLOBAL_WINDOW_MS);
  return globalFailures.length >= GLOBAL_MAX_FAILURES ? globalFailures[0] + GLOBAL_WINDOW_MS : 0;
}

export interface ThrottleOptions {
  /** Skip the global ceiling: a known device, or a user who already has a session. */
  trusted?: boolean;
}

export function lockState(client: string, { trusted = false }: ThrottleOptions = {}) {
  const now = Date.now();
  const s = strikes.get(client);
  const own = s && s.lockedUntil > now ? s.lockedUntil : 0;
  const lockedUntil = Math.max(own, trusted ? 0 : globalLockUntil(now));
  // retryAfterMs is relative, so a browser with a wrong clock still counts down correctly.
  return { lockedUntil, retryAfterMs: lockedUntil ? lockedUntil - now : 0, triesLeft: Math.max(0, FREE_TRIES - (s?.failures ?? 0)) };
}

/** Test helper: forget all failed attempts. */
export function resetThrottle(): void {
  strikes.clear();
  globalFailures = [];
}

export type PasswordCheck = { ok: true } | { ok: false; lockedUntil: number; retryAfterMs: number; triesLeft: number };

export async function verifyPassword(password: string, client = 'local', opts: ThrottleOptions = {}): Promise<PasswordCheck> {
  const before = lockState(client, opts);
  if (before.lockedUntil) return { ok: false, ...before };

  // Count the attempt *before* the slow check: otherwise a burst of parallel guesses would all pass
  // the lock test above and get checked. A correct password then wipes the slate clean.
  const now = Date.now();
  if (strikes.size >= MAX_TRACKED) {
    for (const [k, v] of strikes) if (now - v.last > 24 * 60 * 60_000 && v.lockedUntil < now) strikes.delete(k);
  }
  const s = strikes.get(client) ?? { failures: 0, lockedUntil: 0, last: now };
  s.failures++;
  s.last = now;
  if (s.failures >= FREE_TRIES) s.lockedUntil = now + Math.min(30_000 * 2 ** (s.failures - FREE_TRIES), 60 * 60_000);
  strikes.set(client, s);
  globalFailures.push(now);

  let ok = false;
  try {
    ok = password.length <= MAX_PASSWORD_LENGTH && (await passwordMatches(password));
  } catch (e) {
    // Turned away before checking (server busy): that wasn't a guess, so don't count it.
    s.failures = Math.max(0, s.failures - 1);
    if (s.failures < FREE_TRIES) s.lockedUntil = 0;
    globalFailures.splice(globalFailures.lastIndexOf(now), 1);
    throw e;
  }
  if (ok) {
    strikes.delete(client);
    globalFailures.splice(globalFailures.lastIndexOf(now), 1);
    return { ok: true };
  }
  return { ok: false, ...lockState(client, opts) };
}

// ---------------------------------------------------------------- sessions and known devices

function sign(payload: string): Buffer {
  const a = load();
  if (!a) throw new Error('Password not set');
  return crypto.createHmac('sha256', Buffer.from(a.sessionSecret, 'base64')).update(payload).digest();
}

function signedOk(payload: string, mac: string): boolean {
  const expected = sign(payload);
  const given = Buffer.from(mac, 'base64url');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Session token: "v3.<id>.<expiry>.<r|s>.<hmac>", r = remembered device (long-lived, renewed while
 * used), s = this browser session only. Survives restarts; ended by logout (by id) or a password change.
 */
export interface IssuedSession {
  token: string;
  /** Cookie lifetime; null = a browser-session cookie that goes when the browser closes. */
  maxAgeSec: number | null;
}

export function issueSession(remember: boolean): IssuedSession {
  const lifetimeSec = remember ? Math.round(config.rememberDays * 86_400) : Math.round(config.sessionHours * 3600);
  const payload = `v3.${crypto.randomBytes(12).toString('base64url')}.${Date.now() + lifetimeSec * 1000}.${remember ? 'r' : 's'}`;
  return { token: `${payload}.${sign(payload).toString('base64url')}`, maxAgeSec: remember ? lifetimeSec : null };
}

interface ParsedSession {
  id: string;
  expiry: number;
  remember: boolean;
}

function parseSession(token: string | undefined): ParsedSession | null {
  if (!token || !hasPassword()) return null;
  const parts = token.split('.');
  let parsed: ParsedSession;
  if (parts[0] === 'v3' && parts.length === 5) {
    const [, id, expiry, kind, mac] = parts;
    if (!id || !expiry || (kind !== 'r' && kind !== 's') || !signedOk(`v3.${id}.${expiry}.${kind}`, mac)) return null;
    parsed = { id, expiry: Number(expiry), remember: kind === 'r' };
  } else if (parts[0] === 'v2' && parts.length === 4) {
    // Sessions issued before "remember this device" existed: valid until they expire, not renewed.
    const [, id, expiry, mac] = parts;
    if (!id || !expiry || !signedOk(`v2.${id}.${expiry}`, mac)) return null;
    parsed = { id, expiry: Number(expiry), remember: false };
  } else {
    return null;
  }
  return parsed.expiry > Date.now() ? parsed : null;
}

function isRevoked(id: string): boolean {
  const entry = load()?.revoked?.[id];
  if (entry === undefined) return false;
  const effectiveAt = Array.isArray(entry) ? entry[1] : 0;
  return Date.now() >= effectiveAt;
}

export function verifySession(token: string | undefined): boolean {
  const s = parseSession(token);
  return Boolean(s && !isRevoked(s.id));
}

function addRevoked(s: ParsedSession, graceMs: number): void {
  const a = load();
  if (!a) return;
  const now = Date.now();
  const expiryOf = (e: number | [number, number]) => (Array.isArray(e) ? e[0] : e);
  const revoked = Object.fromEntries(Object.entries(a.revoked ?? {}).filter(([, e]) => expiryOf(e) > now));
  revoked[s.id] = graceMs > 0 ? [s.expiry, now + graceMs] : s.expiry;
  a.revoked = revoked;
  save();
}

/** Ends this one session for good (the cookie alone could otherwise be replayed until it expires). */
export function revokeSession(token: string | undefined): void {
  const s = parseSession(token);
  if (s) addRevoked(s, 0);
}

/** Remembered devices are re-signed about once a week while used, so they never have to sign in again. */
const RENEW_AFTER_MS = 7 * 86_400_000;

/**
 * A fresh token if this remembered session is due for renewal, else null. The old token keeps working
 * for two minutes (requests already on their way), then stops: a copied old cookie dies with it.
 */
export function renewSession(token: string | undefined): IssuedSession | null {
  const s = parseSession(token);
  // Already renewed (and still in its 2-minute handover) or ended: nothing to do.
  if (!s || !s.remember || load()?.revoked?.[s.id] !== undefined) return null;
  const lifetimeMs = config.rememberDays * 86_400_000;
  if (s.expiry - Date.now() > lifetimeMs - RENEW_AFTER_MS) return null;
  addRevoked(s, 2 * 60_000);
  return issueSession(true);
}

export function issueDevice(): string {
  const payload = `d1.${crypto.randomBytes(12).toString('base64url')}`;
  return `${payload}.${sign(payload).toString('base64url')}`;
}

export function verifyDevice(token: string | undefined): boolean {
  if (!token || !hasPassword()) return false;
  const [version, id, mac] = token.split('.');
  return version === 'd1' && Boolean(id) && Boolean(mac) && signedOk(`d1.${id}`, mac);
}
