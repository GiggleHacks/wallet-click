import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logLines } from '../logs.js';

export function registerLogs(app: FastifyInstance): void {
  // The server's recent log for the Logs window (signed-in only, like every /api route). `after` = the last id it has.
  app.get<{ Querystring: { after?: string } }>('/api/logs', async (req) => {
    const after = z.coerce.number().int().min(0).default(0).parse(req.query.after);
    return logLines(after);
  });
}
