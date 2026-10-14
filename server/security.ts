import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from './config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Guards that matter even behind a password or Tailscale. Your browser can reach this server,
 * so a malicious website could otherwise try to drive the API through it.
 *  - Host allowlist (optional): blocks DNS-rebinding.
 *  - Writes need the custom X-Wallet header (which forces a CORS preflight we never approve)
 *    and a same-origin Origin header.
 */
/** True for API routes, judged by the route the router matched (decoded), not the raw URL. */
export function isApiRoute(req: FastifyRequest): boolean {
  const route = req.routeOptions?.url;
  return route ? route.startsWith('/api/') : req.url.split('?')[0].toLowerCase().includes('api');
}

export function registerSecurity(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (config.allowedHosts.length) {
      const bare = host.replace(/:\d+$/, '');
      // Loopback names are always fine (Docker's health check uses them); a rebinding attack needs the attacker's own name.
      const loopback = bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]';
      if (!loopback && !config.allowedHosts.includes(host) && !config.allowedHosts.includes(bare)) {
        return reply.code(421).send({ error: 'Unknown host' });
      }
    }
    // Every write, whatever its path: the router decodes %-escapes, so "/%61pi/..." would reach /api routes.
    if (!SAFE_METHODS.has(req.method)) {
      if (req.headers['x-wallet'] !== '1') return reply.code(403).send({ error: 'Missing request header' });
      const origin = req.headers.origin;
      if (origin) {
        let originHost = '';
        try {
          originHost = new URL(origin).host.toLowerCase();
        } catch {
          /* malformed origin -> rejected below */
        }
        if (originHost !== host) return reply.code(403).send({ error: 'Cross-origin request blocked' });
      }
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', CSP);
    if (isApiRoute(req)) reply.header('Cache-Control', 'no-store');
    if (config.cookieSecure === 'true' || req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });
}
