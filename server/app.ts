import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { adoptPassword } from './auth.js';
import { config } from './config.js';
import { HttpError, UserError, friendlyError } from './errors.js';
import { FfError } from './fixedfloat.js';
import { logger, quiet } from './logs.js';
import { registerAuth } from './routes/auth.js';
import { registerDestinations } from './routes/destinations.js';
import { registerLogs } from './routes/logs.js';
import { registerOrders } from './routes/orders.js';
import { registerTransfers } from './routes/transfers.js';
import { registerSecurity } from './security.js';
import { setupHotWallets } from './wallets/setup.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  if (config.appPassword) await adoptPassword(config.appPassword);
  setupHotWallets();

  if (opts.logger === false) quiet();
  const app = Fastify({
    // One logger for everything: printed (docker logs) and kept for the Logs window.
    loggerInstance: logger as FastifyBaseLogger,
    // The browser asks for updates every two seconds; those would bury everything else. onResponse below logs the rest.
    logController: new LogController({ disableRequestLogging: true }),
    // One proxy hop (Tailscale serve/funnel) sits in front: trust only the address it adds, so a
    // client can't pick its own IP by sending X-Forwarded-For itself.
    trustProxy: (_address: string, hop: number) => hop < 1,
    bodyLimit: 16 * 1024,
    // Don't let slow or stuck clients hold connections open forever (creating an address can take
    // two FixedFloat calls, so leave room for that).
    requestTimeout: 60_000,
    connectionTimeout: 90_000,
  });
  app.removeContentTypeParser('text/plain'); // JSON only

  await app.register(cookie);
  registerSecurity(app);
  app.addHook('onResponse', async (req, reply) => {
    const s = reply.statusCode;
    if ((req.method === 'GET' || req.method === 'HEAD') && s < 500 && s !== 429) return;
    const line = `${req.method} ${req.url.split('?')[0]} → ${s} (${Math.round(reply.elapsedTime)} ms)`;
    if (s >= 500) req.log.error(line);
    else if (s >= 400) req.log.warn(line);
    else req.log.info(line);
  });
  registerAuth(app);
  registerOrders(app);
  registerDestinations(app);
  registerTransfers(app);
  registerLogs(app);

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (err instanceof UserError) return reply.code(400).send({ error: err.message });
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request' });
    if (err instanceof FfError) {
      req.log.warn({ code: err.code }, err.message);
      return reply.code(err.code === -1 ? 429 : err.code === -2 ? 503 : 502).send({ error: err.message });
    }
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(502).send({ error: friendlyError(err) });
  });

  const webDir = path.resolve('dist/web');
  if (fs.existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDir,
      setHeaders(reply, filePath) {
        reply.header('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  }
  return app;
}
