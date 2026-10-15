import crypto from 'node:crypto';
import path from 'node:path';
import { PRIVACY_DELAYS, config, type Coin } from './config.js';
import { destinations } from './destinations.js';
import { UserError } from './errors.js';
import { readJson, writeJsonAtomic } from './store.js';
import { hotWallet } from './wallets/index.js';
import * as xmr from './wallets/xmr.js';

/**
 * Permanent addresses ("routes"): an address you save in your phone wallet once. Whatever lands there is forwarded
 * to a fresh FixedFloat order and delivered to the route's destination. A route's address and destination never
 * change, so a saved address always lands in the same place; only its name and privacy delay can.
 */

export type RouteMode = 'direct' | 'privacy';

export interface Route {
  id: string;
  label: string;
  coin: Coin;
  /** direct: coin → USDT. privacy: coin → XMR → (delay) → USDT. */
  mode: RouteMode;
  destinationId: string;
  /** The destination as it was when the route was made (the payout address is fixed for life). */
  destination: { label: string; address: string };
  delayHours: number | null;
  /** HD index (BTC/ETH) or Monero subaddress index. */
  index: number;
  address: string;
  createdAt: number;
  /** Hidden from the list. Payments that still arrive are forwarded anyway. */
  archived: boolean;
}

interface RoutesFile {
  version: 1;
  /** Next HD index per coin (Monero subaddresses come from the wallet). */
  next: Partial<Record<Coin, number>>;
  routes: Route[];
}

const MAX = 60;
const file = () => path.join(config.dataDir, 'routes.json');
let cache: RoutesFile | null = null;

function load(): RoutesFile {
  cache ??= readJson<RoutesFile>(file()) ?? { version: 1, next: {}, routes: [] };
  return cache;
}
const save = () => writeJsonAtomic(file(), load());

/** BTC/ETH derive addresses from the seed; registered by the seed module once it's unlocked. */
let derive: ((coin: 'BTC' | 'ETH', index: number) => string) | null = null;
export function setDeriver(fn: typeof derive): void {
  derive = fn;
}

export const addresses = {
  list: (): Route[] => load().routes,
  get: (id: string | null | undefined): Route | null => (id ? (load().routes.find((r) => r.id === id) ?? null) : null),

  /** The name of a route that pays out to this destination (so it can't be removed), or null. */
  usedBy: (destinationId: string): string | null => load().routes.find((r) => r.destinationId === destinationId)?.label ?? null,

  async create(req: { coin: Coin; mode: RouteMode; delayHours?: number | null; destinationId?: string; label?: string }, now = Date.now()): Promise<Route> {
    const dest = destinations.need(req.destinationId);
    if (!hotWallet(req.coin)) {
      throw new UserError(
        req.coin === 'XMR'
          ? 'Permanent Monero addresses need the VPS Monero wallet (MONERO_RPC_URL).'
          : 'Permanent Bitcoin/Ethereum addresses need the hot wallet (WALLET_KEY and npm run wallet:init).',
      );
    }
    if (req.mode === 'privacy') {
      if (req.coin === 'XMR') throw new UserError('Monero is already private: a permanent Monero address goes straight to USDT.');
      if (!xmr.xmrConfigured()) throw new UserError('Privacy Enhanced needs the VPS Monero wallet (MONERO_RPC_URL).');
      if (!PRIVACY_DELAYS.includes(req.delayHours as (typeof PRIVACY_DELAYS)[number])) throw new UserError(`Pick a delay of ${PRIVACY_DELAYS.join(', ')} hours.`);
    }
    if (load().routes.length >= MAX) throw new UserError(`Up to ${MAX} permanent addresses.`);
    const id = `r_${crypto.randomBytes(5).toString('hex')}`;
    const kind = req.mode === 'privacy' ? 'Privacy' : 'to';
    const label = (req.label ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) || `${req.coin} ${kind} ${dest.label}`;

    let index: number;
    let address: string;
    if (req.coin === 'XMR') {
      ({ index, address } = await xmr.newSubaddress(`wallet-click ${id} ${label}`));
    } else {
      if (!derive) throw new UserError('The hot wallet is locked (WALLET_KEY).');
      index = load().next[req.coin] ?? 0;
      address = derive(req.coin, index);
      load().next[req.coin] = index + 1;
    }
    const route: Route = {
      id,
      label,
      coin: req.coin,
      mode: req.mode,
      destinationId: dest.id,
      destination: { label: dest.label, address: dest.address },
      delayHours: req.mode === 'privacy' ? (req.delayHours as number) : null,
      index,
      address,
      createdAt: now,
      archived: false,
    };
    load().routes.push(route);
    save();
    return route;
  },

  /** Only the name, the privacy delay and whether it's listed can change: never the address or destination. */
  update(id: string, patch: { label?: string; delayHours?: number; archived?: boolean }): Route {
    const r = addresses.get(id);
    if (!r) throw new UserError('That permanent address is gone.');
    if (patch.label !== undefined) {
      const label = patch.label.trim().replace(/\s+/g, ' ');
      if (!label || label.length > 40) throw new UserError('Give it a name of up to 40 characters.');
      r.label = label;
    }
    if (patch.delayHours !== undefined) {
      if (r.mode !== 'privacy') throw new UserError('Only Privacy Enhanced addresses have a delay.');
      if (!PRIVACY_DELAYS.includes(patch.delayHours as (typeof PRIVACY_DELAYS)[number])) throw new UserError(`Pick a delay of ${PRIVACY_DELAYS.join(', ')} hours.`);
      r.delayHours = patch.delayHours;
    }
    if (patch.archived !== undefined) r.archived = patch.archived;
    save();
    return r;
  },

  /** Drops the in-memory copy (tests). */
  reset(): void {
    cache = null;
  },
};
