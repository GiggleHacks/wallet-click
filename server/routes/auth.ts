import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BusyError,
  COOKIE_NAME,
  DEVICE_COOKIE,
  DEVICE_MAX_AGE_SEC,
  clientKey,
  hasPassword,
  issueDevice,
  issueSession,
  lockState,
  renewSession,
  revokeSession,
  verifyDevice,
  verifyPassword,
  verifySession,
  type ThrottleOptions,
} from '../auth.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { VERSION } from '../version.js';
import { agentAuthorized } from './stash.js';

const PUBLIC_PATHS = new Set(['/api/status', '/api/login', '/api/logout']);

const secureCookie = (req: FastifyRequest) => config.cookieSecure === 'true' || (config.cookieSecure === 'auto' && req.protocol === 'https');

function setSessionCookie(req: FastifyRequest, reply: FastifyReply, { token, maxAgeSec }: { token: string; maxAgeSec: number | null }): void {
  // No maxAge = a browser-session cookie: it goes away when the browser closes.
  reply.setCookie(COOKIE_NAME, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookie(req), ...(maxAgeSec ? { maxAge: maxAgeSec } : {}) });
}

export function startSession(req: FastifyRequest, reply: FastifyReply, remember = false): void {
  setSessionCookie(req, reply, issueSession(remember));
  // "Remember this device": also mark the browser as known, so lockouts caused by strangers guessing
  // elsewhere never stop it from signing in.
  if (remember && !verifyDevice(req.cookies[DEVICE_COOKIE])) {
    reply.setCookie(DEVICE_COOKIE, issueDevice(), { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookie(req), maxAge: DEVICE_MAX_AGE_SEC });
  }
}

async function check(password: string, client: string, opts: ThrottleOptions) {
  try {
    return await verifyPassword(password, client, opts);
  } catch (e) {
    if (e instanceof BusyError) throw new HttpError(429, e.message);
    throw e;
  }
}

/** Re-checks the password of a user who is already signed in (e.g. before a refund). */
export async function requirePassword(password: string, req: FastifyRequest): Promise<void> {
  // Its own counter, and no global ceiling: the caller already has a session.
  const r = await check(password, `refund:${clientKey(req.ip)}`, { trusted: true });
  if (!r.ok) throw new HttpError(401, r.lockedUntil ? 'Too many attempts. Wait a bit.' : 'Wrong password');
}

export function registerAuth(app: FastifyInstance): void {
  // Every /api route except the ones above needs a valid session cookie. Decided by the route the
  // router matched: it decodes %-escapes, so checking the raw URL would let "/%61pi/orders" through.
  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url;
    if (!route || !route.startsWith('/api/')) return;
    // OpenClaw's routes take the agent token instead of a sign-in (and nothing else takes that token).
    if (route.startsWith('/api/agent/')) {
      if (!agentAuthorized(req)) return reply.code(401).send({ error: 'Locked' });
      return;
    }
    const token = req.cookies[COOKIE_NAME];
    if (!PUBLIC_PATHS.has(route) && !verifySession(token)) return reply.code(401).send({ error: 'Locked' });
    // Remembered devices quietly get a fresh sign-in about once a week, so they're never asked again.
    if (route !== '/api/logout') {
      const renewed = renewSession(token);
      if (renewed) setSessionCookie(req, reply, renewed);
    }
  });

  app.get('/api/status', async (req) => ({
    ready: hasPassword(),
    version: VERSION,
    authed: verifySession(req.cookies[COOKIE_NAME]),
    ...lockState(clientKey(req.ip), { trusted: verifyDevice(req.cookies[DEVICE_COOKIE]) }),
  }));

  app.post('/api/login', async (req, reply) => {
    if (!hasPassword()) throw new HttpError(409, 'No password is configured on the server (APP_PASSWORD).');
    const { password, remember } = z.object({ password: z.string().max(1024), remember: z.boolean().optional() }).parse(req.body);
    const r = await check(password, clientKey(req.ip), { trusted: verifyDevice(req.cookies[DEVICE_COOKIE]) });
    if (!r.ok) return reply.code(401).send({ error: r.lockedUntil ? 'Too many attempts' : 'Wrong password', ...r });
    startSession(req, reply, remember === true);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    revokeSession(req.cookies[COOKIE_NAME]);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
}
