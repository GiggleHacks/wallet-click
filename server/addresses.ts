import crypto from 'node:crypto';
import path from 'node:path';
import { DELAYS, PIECES_MAX, config, type Coin, type Stable } from './config.js';
import { destinations } from './destinations.js';
import { UserError } from './errors.js';
import { readJson, writeJsonAtomic } from './store.js';
import { hotWallet, type RouteRef } from './wallets/index.js';
import * as xmr from './wallets/xmr.js';

/**
 * Permanent addresses ("routes"): an address you save in your phone wallet once. Whatever lands there is forwarded
 * to a fresh FixedFloat order and delivered to the route's destination. A route's address and destination never
 * change, so a saved address always lands in the same place; only its name, wait and pieces can.
 *
 * A one-time route is the same thing behind a coin button with a wait or pieces turned on: not listed, and watched
 * for 30 days.
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
  destination: { label: string; address: string; ccy?: Stable };
  /** Hours a payment waits before it goes on (Privacy Enhanced: in Monero). */
  delayHours: number | null;
  /** How many pieces each payment goes out in (1: all at once). */
  pieces?: number;
  /** Made by a coin button for one payment: not listed, and no longer watched after `expiresAt`. */
  oneTime?: boolean;
  expiresAt?: number;
  /** HD index (BTC/ETH) or Monero subaddress index. */
  index: number;
  address: string;
  createdAt: number;
  /** Hidden from the list. Payments that still arrive are forwarded anyway. */
  archived: boolean;
}

interface RoutesFile {
  version: 1;
  /** Next HD index per coin, and per Bitcoin change chain ("BTC:1"). Monero subaddresses come from the wallet. */
  next: Record<string, number>;
  routes: Route[];
}

const MAX = 60;
/** One-time addresses being watched at once, at most; and how many a minute can be made. */
const ONE_TIME_MAX = 200;
const ONE_TIME_PER_MINUTE = 3;
const ONE_TIME_DAYS = 30;
const recentOneTime: number[] = [];
const file = () => path.join(config.dataDir, 'routes.json');
let cache: RoutesFile | null = null;

function load(): RoutesFile {
  cache ??= readJson<RoutesFile>(file()) ?? { version: 1, next: {}, routes: [] };
  return cache;
}
const save = () => writeJsonAtomic(file(), load());

/** BTC/ETH derive addresses from the seed; registered by the seed module once it's unlocked. */
let derive: ((coin: 'BTC' | 'ETH', index: number, chain?: 0 | 1) => string) | null = null;
export function setDeriver(fn: typeof derive): void {
  derive = fn;
}

const checkDelay = (h: unknown) => {
  if (!DELAYS.includes(h as (typeof DELAYS)[number])) throw new UserError(`Pick a wait of ${DELAYS.join(', ')} hours.`);
};
const checkPieces = (n: unknown) => {
  if (!(Number.isInteger(n) && (n as number) >= 1 && (n as number) <= PIECES_MAX)) throw new UserError(`Pick 1 to ${PIECES_MAX} pieces.`);
};
const watched = (r: Route, now: number) => !r.expiresAt || now < r.expiresAt;

export const addresses = {
  /** Every route still being watched (one-time ones included). */
  list: (now = Date.now()): Route[] => load().routes.filter((r) => watched(r, now)),
  /** The permanent addresses the owner made (My Addresses). */
  saved: (): Route[] => load().routes.filter((r) => !r.oneTime),
  get: (id: string | null | undefined): Route | null => (id ? (load().routes.find((r) => r.id === id) ?? null) : null),

  /** The name of a route that pays out to this destination (so it can't be removed), or null. */
  usedBy: (destinationId: string, now = Date.now()): string | null => addresses.list(now).find((r) => r.destinationId === destinationId)?.label ?? null,

  /** A fresh Bitcoin address of ours on the change chain (m/84'/0'/0'/1/i), for one piece of a split. */
  internal(coin: 'BTC'): RouteRef {
    if (!derive) throw new UserError('The hot wallet is locked (WALLET_KEY).');
    const key = `${coin}:1`;
    const index = load().next[key] ?? 0;
    const address = derive(coin, index, 1);
    load().next[key] = index + 1;
    save(); // on disk before anything is paid to it: an index is never handed out twice
    return { coin, index, address, chain: 1 };
  },

  async create(
    req: { coin: Coin; mode: RouteMode; delayHours?: number | null; pieces?: number; destinationId?: string; label?: string; oneTime?: boolean },
    now = Date.now(),
  ): Promise<Route> {
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
      checkDelay(req.delayHours);
    } else if (req.delayHours !== undefined && req.delayHours !== null) checkDelay(req.delayHours);
    const pieces = req.pieces ?? 1;
    checkPieces(pieces);
    if (req.oneTime) {
      while (recentOneTime.length && now - recentOneTime[0] > 60_000) recentOneTime.shift();
      if (recentOneTime.length >= ONE_TIME_PER_MINUTE) throw new UserError('Easy there: three new addresses a minute at most. Try again in a few seconds.');
      if (addresses.list(now).filter((r) => r.oneTime).length >= ONE_TIME_MAX) throw new UserError(`Up to ${ONE_TIME_MAX} one-time addresses at once.`);
      recentOneTime.push(now);
    } else if (addresses.saved().length >= MAX) throw new UserError(`Up to ${MAX} permanent addresses.`);
    const id = `r_${crypto.randomBytes(5).toString('hex')}`;
    const kind = req.mode === 'privacy' ? 'Privacy' : 'to';
    const label = req.oneTime ? `One-time ${req.coin} address` : (req.label ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) || `${req.coin} ${kind} ${dest.label}`;

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
      destination: { label: dest.label, address: dest.address, ccy: dest.ccy },
      delayHours: req.delayHours ?? 0,
      pieces,
      index,
      address,
      createdAt: now,
      archived: Boolean(req.oneTime),
      ...(req.oneTime ? { oneTime: true, expiresAt: now + ONE_TIME_DAYS * 24 * 3_600_000 } : {}),
    };
    load().routes.push(route);
    save();
    return route;
  },

  /** Only the name, the wait, the pieces and whether it's listed can change: never the address or destination. */
  update(id: string, patch: { label?: string; delayHours?: number; pieces?: number; archived?: boolean }): Route {
    const r = addresses.get(id);
    if (!r) throw new UserError('That permanent address is gone.');
    if (patch.label !== undefined) {
      const label = patch.label.trim().replace(/\s+/g, ' ');
      if (!label || label.length > 40) throw new UserError('Give it a name of up to 40 characters.');
      r.label = label;
    }
    if (patch.delayHours !== undefined) {
      checkDelay(patch.delayHours);
      r.delayHours = patch.delayHours;
    }
    if (patch.pieces !== undefined) {
      checkPieces(patch.pieces);
      r.pieces = patch.pieces;
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
