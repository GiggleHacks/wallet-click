import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientKey } from '../auth.js';
import { config } from '../config.js';
import { HttpError, UserError } from '../errors.js';
import { logger } from '../logs.js';
import { ASSETS, ASSET_IDS, isAssetId, type AssetId } from '../stash/assets.js';
import { createAddress, createVia, entryView, getEntry, longTail, moveAll, refreshPrices, startMove, updateEntry, walletView } from '../stash/engine.js';
import { load, save } from '../stash/store.js';
import { requirePassword } from './auth.js';
import { onDestinationRemove } from './destinations.js';

const to = z.enum(['xmr', 'coinbase']);
const label = z.string().max(80).optional();

/** Names people (and OpenClaw) use for the held coins. */
const ALIASES: Record<string, AssetId> = {
  btc: 'BTC',
  bitcoin: 'BTC',
  ltc: 'LTC',
  litecoin: 'LTC',
  eth: 'ETH',
  ethereum: 'ETH',
  ether: 'ETH',
  base: 'ETH-BASE',
  'eth-base': 'ETH-BASE',
  ethbase: 'ETH-BASE',
  arbitrum: 'ETH-ARB',
  arb: 'ETH-ARB',
  'eth-arb': 'ETH-ARB',
  etharbitrum: 'ETH-ARB',
  optimism: 'ETH-OP',
  op: 'ETH-OP',
  'eth-op': 'ETH-OP',
  ethop: 'ETH-OP',
  pol: 'POL',
  matic: 'POL',
  polygon: 'POL',
  bnb: 'BNB',
  bsc: 'BNB',
  sol: 'SOL',
  solana: 'SOL',
  xmr: 'XMR',
  monero: 'XMR',
};

/** A held coin's id, or a long-tail FixedFloat code, from what someone typed ("solana", "ZEC", "usdt on tron"…). */
async function resolveCoin(q: string): Promise<{ asset: AssetId } | { code: string }> {
  const s = q.trim().toLowerCase().replace(/\s+on\s+/g, '-').replace(/\s+/g, '-');
  const up = q.trim().toUpperCase();
  if (isAssetId(up)) return { asset: up };
  if (ALIASES[s]) return { asset: ALIASES[s] };
  const held = ASSET_IDS.find((id) => ASSETS[id].ffCode === up);
  if (held) return { asset: held };
  const tail = await longTail();
  const hit = tail.find((c) => c.code === up) ?? tail.find((c) => c.name.toLowerCase() === q.trim().toLowerCase()) ?? tail.find((c) => `${c.coin}-${c.network}`.toLowerCase() === s);
  if (hit) return { code: hit.code };
  throw new UserError(`Don't know "${q}". Held here: ${ASSET_IDS.join(', ')}; anything else FixedFloat takes by its code (GET /api/agent/coins).`);
}

// ---------------------------------------------------------------- the agent token

const agentFails = new Map<string, { n: number; at: number }>();
const digest = (s: string) => crypto.createHash('sha256').update(s).digest();

/** "Authorization: Bearer <AGENT_TOKEN>", compared in constant time. A client that keeps guessing is turned away for a while. */
export function agentAuthorized(req: FastifyRequest): boolean {
  if (!config.agentToken) return false;
  const who = clientKey(req.ip);
  const f = agentFails.get(who);
  const t = Date.now();
  if (f && f.n >= 20 && t - f.at < 15 * 60_000) return false;
  const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ''));
  const ok = Boolean(m) && crypto.timingSafeEqual(digest(m![1]), digest(config.agentToken));
  if (ok) agentFails.delete(who);
  else agentFails.set(who, { n: (f && t - f.at < 15 * 60_000 ? f.n : 0) + 1, at: t });
  return ok;
}

/** Tests: forget failed tries. */
export const resetAgentFails = () => agentFails.clear();

/** What OpenClaw needs to hand an address over: no balances of other addresses, nothing secret. */
function agentAddress(v: ReturnType<typeof entryView>) {
  return {
    id: v.id,
    coin: v.symbol,
    name: v.name,
    network: v.network,
    address: v.address,
    memo: v.via?.tag ?? null,
    uri: v.uri,
    warning: v.warning,
    expiresAt: v.via?.expiresAt ?? null,
    landsIn: v.via ? 'Monero (swapped by FixedFloat on arrival)' : null,
    minimum: v.via?.min ? `${v.via.min} ${v.symbol}` : null,
    label: v.label,
  };
}

function agentEntry(v: ReturnType<typeof entryView>) {
  return {
    id: v.id,
    coin: v.symbol,
    network: v.network,
    label: v.label,
    state: v.state,
    amount: v.amount,
    held: v.heldSymbol,
    usd: v.usd,
    createdAt: new Date(v.createdAt).toISOString(),
    moves: v.moves.map((m) => ({ to: m.to, step: m.step, by: m.by, error: m.error, out: m.out })),
  };
}

export function registerStash(app: FastifyInstance): void {
  // A destination a move is paying out to stays in the address book until it's done.
  onDestinationRemove((id) => {
    const busy = load().entries.find((e) => e.moves.some((m) => m.destinationId === id && m.step !== 'done' && m.step !== 'failed'));
    return busy ? `A Wallet move${busy.label ? ` ("${busy.label}")` : ''}` : load().settings.destinationId === id ? "The Wallet's default for Send to Coinbase" : null;
  });

  app.get('/api/stash', async () => {
    refreshPrices();
    return walletView();
  });

  app.get('/api/stash/coins', async () => ({ coins: await longTail() }));

  app.post('/api/stash', async (req) => {
    const body = z.object({ asset: z.string().max(20).optional(), code: z.string().max(20).optional(), label }).parse(req.body);
    if (body.asset) {
      if (!isAssetId(body.asset)) throw new UserError('Unknown coin.');
      return entryView(await createAddress(body.asset, { label: body.label, by: 'you' }));
    }
    if (!body.code || !/^[A-Z0-9]{2,16}$/.test(body.code)) throw new UserError('Pick a coin.');
    return entryView(await createVia(body.code, { label: body.label, by: 'you' }));
  });

  app.post<{ Params: { id: string } }>('/api/stash/:id', async (req) => {
    const body = z.object({ label, archived: z.boolean().optional() }).parse(req.body);
    return entryView(updateEntry(req.params.id, body));
  });

  // Moving money needs the password again: a stolen session alone can't.
  app.post<{ Params: { id: string } }>('/api/stash/:id/move', async (req) => {
    const body = z.object({ to, destinationId: z.string().max(40).optional(), password: z.string().max(1024) }).parse(req.body);
    await requirePassword(body.password, req);
    return entryView(await startMove(req.params.id, body.to, { destinationId: body.destinationId, by: 'you' }));
  });

  app.post('/api/stash/move-all', async (req) => {
    const body = z.object({ to, destinationId: z.string().max(40).optional(), password: z.string().max(1024) }).parse(req.body);
    await requirePassword(body.password, req);
    return moveAll(body.to, { destinationId: body.destinationId, by: 'you' });
  });

  app.post('/api/stash/settings', async (req) => {
    const body = z
      .object({
        onArrival: z.enum(['hold', 'xmr', 'coinbase']).optional(),
        destinationId: z.string().max(40).optional(),
        hidden: z.array(z.string().max(20)).max(20).optional(),
        pings: z.boolean().optional(),
        password: z.string().max(1024).optional(),
      })
      .parse(req.body);
    const s = load().settings;
    // Turning on automatic swaps moves money without a click later, so it asks for the password.
    if (body.onArrival && body.onArrival !== 'hold' && body.onArrival !== s.onArrival) await requirePassword(body.password ?? '', req);
    if (body.destinationId) {
      const { destinations } = await import('../destinations.js');
      destinations.need(body.destinationId);
      s.destinationId = body.destinationId;
    }
    if (body.onArrival) s.onArrival = body.onArrival;
    if (body.hidden) s.hidden = body.hidden.filter(isAssetId);
    if (body.pings !== undefined) s.pings = body.pings;
    save();
    return walletView();
  });

  // ---------------------------------------------------------------- OpenClaw (AGENT_TOKEN)

  app.get('/api/agent/coins', async () => ({
    held: ASSET_IDS.map((id) => ({ id, name: ASSETS[id].name, network: ASSETS[id].network })),
    other: (await longTail().catch(() => [])).map((c) => ({ code: c.code, name: c.name, network: c.network, memo: c.tag })),
  }));

  app.get('/api/agent/wallet', async () => {
    refreshPrices();
    const w = walletView();
    return { totalUsd: w.totalUsd, entries: w.entries.slice(0, 50).map(agentEntry), destinations: w.destinations };
  });

  app.get<{ Params: { id: string } }>('/api/agent/wallet/:id', async (req) => {
    const e = getEntry(req.params.id);
    if (!e) throw new HttpError(404, 'No such address.');
    const v = entryView(e);
    return { ...agentEntry(v), ...agentAddress(v) };
  });

  // Always a fresh address: OpenClaw never gets an old one to hand out again.
  app.post('/api/agent/address', async (req) => {
    const body = z.object({ coin: z.string().min(1).max(40), label }).parse(req.body);
    const c = await resolveCoin(body.coin);
    const e = 'asset' in c ? await createAddress(c.asset, { label: body.label, by: 'openclaw' }) : await createVia(c.code, { label: body.label, by: 'openclaw' });
    return agentAddress(entryView(e));
  });

  app.post('/api/agent/move', async (req) => {
    const body = z.object({ id: z.string().max(40), to, destinationId: z.string().max(40).optional() }).parse(req.body);
    const e = await startMove(body.id, body.to, { destinationId: body.destinationId, by: 'openclaw' });
    logger.info(`[wallet ${e.id}] OpenClaw started a move to ${body.to}`);
    return agentEntry(entryView(e));
  });
}
