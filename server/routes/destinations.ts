import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { destinations } from '../destinations.js';
import { requirePassword } from './auth.js';

/** Hooks other modules register so a destination in use can't be removed (permanent addresses). */
const usedByChecks: ((id: string) => string | null)[] = [];
export const onDestinationRemove = (check: (id: string) => string | null) => usedByChecks.push(check);
const usedBy = (id: string) => usedByChecks.map((c) => c(id)).find(Boolean) ?? null;

const list = () => ({ destinations: destinations.list() });

export function registerDestinations(app: FastifyInstance): void {
  app.get('/api/destinations', async () => list());

  // Adding a payout address needs the password again: a stolen session alone can't add one.
  app.post('/api/destinations', async (req) => {
    const body = z.object({ label: z.string().max(80), address: z.string().max(80), password: z.string().max(1024) }).parse(req.body);
    await requirePassword(body.password, req);
    destinations.add(body.label, body.address);
    return list();
  });

  app.post<{ Params: { id: string } }>('/api/destinations/:id/delete', async (req) => {
    const body = z.object({ password: z.string().max(1024) }).parse(req.body);
    await requirePassword(body.password, req);
    destinations.remove(req.params.id, usedBy);
    return list();
  });
}
