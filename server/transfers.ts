import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { addresses, type Route } from './addresses.js';
import { DECIMALS, fromBase, toBase } from './chain.js';
import { COINS, DELAYS, PAYOUTS, PIECE_MIN_FACTOR, PIECES_MAX, config, type Coin, type Stable } from './config.js';
import { destinations } from './destinations.js';
import { HttpError, UserError, friendlyError } from './errors.js';
import { FfError } from './fixedfloat.js';
import { logger } from './logs.js';
import { LimitError, abandon, costOf, createOrder, flush as flushOrders, limits, openSwap, orderView, orders, pairBusy, usdPrice, type Expect, type OrderRecord, type OrderView } from './orders.js';
import { readJson, writeJsonAtomic } from './store.js';
import { hotWallet, xmrWallet, type HotWallet, type RouteRef } from './wallets/index.js';
import * as xmr from './wallets/xmr.js';

/**
 * A transfer is one payment's whole journey, run step by step on a timer:
 *
 *   collect → open1 → send1 →  swap1  → done                                  (permanent address, direct)
 *                              swap1  → xmr-in → churn → wait → open2 → send2 → swap2 → done   (Privacy Enhanced)
 *
 * - collect/open1/send1: a payment landed at a permanent address. Once it's confirmed and above FixedFloat's
 *   minimum, a FixedFloat order is created for exactly that amount and our hot wallet pays it.
 * - swap1: FixedFloat swaps it (to USDT, or to XMR at a fresh "vault" subaddress of ours for Privacy Enhanced).
 *   A new-address Privacy transfer starts here: someone pays the order's address directly.
 * - xmr-in/churn/wait: the XMR arrives and unlocks, moves once to another subaddress of ours (so FixedFloat's own
 *   outputs don't go straight back to it), then waits the chosen delay plus a random jitter.
 * - open2/send2/swap2: a FixedFloat order XMR → USDT for what's there, paid by our wallet, then done.
 *
 * Waits and pieces (Send options):
 * - hold: a direct payment at a permanent (or one-time) address waits before it's forwarded; anything that arrives
 *   meanwhile joins it.
 * - A Monero payment with a wait or pieces takes the Monero path from xmr-in, its own subaddress as the vault.
 * - pieces > 1: the money is split, and every piece becomes a child transfer that goes on by itself, the next one a
 *   random 5 min–2 h after the one before has settled. The parent sits in `pieces` until they're all done.
 *     Monero: the churn is one transaction to a fresh subaddress per piece; each piece churns again on its own,
 *       at a random time, then waits, then wait → open2 → send2 → swap2.
 *     Bitcoin: `split` pays one transaction to a fresh change-chain address per piece; each piece then forwards
 *       from there (collect → open1 → send1 → swap1).
 *     Ethereum: no split transaction; each piece forwards its share straight from the address, one after another.
 *
 * Every send is signed and saved to disk before it's broadcast, and after a crash the same transaction is
 * broadcast again (never a new one). Money only ever goes to a FixedFloat order the server just created and
 * checked, to one of our own Monero subaddresses, or (a Bitcoin split) to our own change-chain addresses.
 */

export type TransferState =
  | 'collect'
  | 'hold'
  | 'split'
  | 'open1'
  | 'send1'
  | 'swap1'
  | 'xmr-in'
  | 'churn'
  | 'wait'
  | 'pieces'
  | 'open2'
  | 'send2'
  | 'swap2'
  | 'done'
  | 'refunded';

export interface Send {
  /** The FixedFloat order this pays (null for the churn). */
  orderId: string | null;
  to: string;
  amount: string;
  fee: string;
  txids: string[];
  /** The signed transactions: broadcast again after a crash, never rebuilt. Secret: never sent to the browser. */
  raw: string[];
  inputs?: string[];
  createdAt: number;
  broadcastAt: number | null;
}

export interface TransferRecord {
  id: string;
  createdAt: number;
  /** What was paid in. */
  coin: Coin;
  privacy: boolean;
  delayHours: number | null;
  /** Random extra wait (Privacy Enhanced), so the delay isn't an exact fingerprint. */
  jitterMs: number;
  destinationId: string;
  /** Where the USDT goes, as it was when the transfer started. */
  destination: { label: string; address: string; ccy?: Stable };
  /** The permanent address it came in through (null: a fresh FixedFloat address). */
  routeId: string | null;
  state: TransferState;
  /** What was paid in, as a decimal amount of `coin`. */
  received: string | null;
  inbound?: { txids: string[]; confirmations: number; required: number; spendable: string };
  /** Exact amount ordered from FixedFloat for the forward (base units), and the coins it's paid from (Bitcoin). */
  forwardAmount?: string;
  forwardInputs?: string[];
  forward?: Send;
  leg1?: string;
  /** seenAt: when the XMR first showed up in the wallet. */
  vault?: { index: number; address: string; amount: string | null; confirmations: number; unlockedAt: number | null; seenAt?: number | null };
  churn?: Send & { index: number; address: string };
  releaseAt: number | null;
  leg2?: string;
  sweep?: Send;
  usdt: string | null;
  payoutTx: string | null;
  doneAt: number | null;
  /** Stuck until the owner presses Retry. */
  attention: string | null;
  /** A temporary problem: it keeps retrying. */
  error: string | null;
  /** What it's waiting on right now, in words. */
  waitingFor: string | null;
  tries: number;
  nextAt: number;
  log: { at: number; text: string }[];

  /** The money waits in our Monero wallet (Privacy Enhanced, or a Monero payment with a wait or pieces). Old records: `privacy`. */
  monero?: boolean;
  /** How many pieces it goes out in (1 or missing: all at once). */
  pieces?: number;
  /** Direct wait: when the payment was confirmed (the wait counts from here). */
  heldAt?: number;
  /** The one transaction that split it into pieces (Monero or Bitcoin). */
  split?: Send & { outs: { index: number; address: string; amount: string }[] };

  /** A piece of a split payment: its parent, which one it is, and its random pause after the piece before. */
  parentId?: string;
  piece?: { n: number; of: number };
  gapMs?: number;
  /** The most this piece forwards (base units of `coin`): Ethereum pieces share one address. */
  pieceAmount?: string;
  /** The address a Bitcoin piece spends from (its own change-chain address). */
  source?: RouteRef;
  /** When a Monero piece moves within the wallet: some random time before its turn. */
  churnAt?: number;
  /** Done, sent back, or stuck: the next piece may go. */
  settledAt?: number;
}

interface TransfersFile {
  version: 1;
  transfers: TransferRecord[];
}

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const KEEP_FINISHED = 300;
const GIVE_UP_TRIES = 10;
/** An order our wallet hasn't paid within this long is dropped for a fresh one (FixedFloat expires them after 30). */
const PAY_WITHIN = 10 * M;

const file = () => path.join(config.dataDir, 'transfers.json');
let cache: TransfersFile | null = null;
let dirty = false;

function load(): TransfersFile {
  if (!cache) {
    cache = readJson<TransfersFile>(file()) ?? { version: 1, transfers: [] };
    for (const t of cache.transfers) t.nextAt = Math.min(t.nextAt, Date.now() + Math.random() * 10 * S); // look again soon after a restart
  }
  return cache;
}
const markDirty = () => (dirty = true);

export function flush(): void {
  if (!dirty || !cache) return;
  const finished = cache.transfers.filter((t) => !t.parentId && (t.state === 'done' || t.state === 'refunded'));
  if (finished.length > KEEP_FINISHED) {
    // A split payment goes together with its pieces.
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((t) => t.id));
    cache.transfers = cache.transfers.filter((t) => !drop.has(t.id) && !(t.parentId && drop.has(t.parentId)));
  }
  writeJsonAtomic(file(), cache, false);
  dirty = false;
}

/** Saves right now: before any broadcast, the signed transaction must be on disk. */
function persist(): void {
  dirty = true;
  flush();
}

export const transfers = {
  all: (): TransferRecord[] => load().transfers,
  get: (id: string): TransferRecord | null => load().transfers.find((t) => t.id === id) ?? null,
  /** Unfinished transfers plus the newest ones, newest first. Pieces are shown inside their parent. */
  forBrowser(limit = 40): TransferRecord[] {
    const all = load().transfers.filter((t) => !t.parentId);
    const live = all.filter((t) => t.state !== 'done' && t.state !== 'refunded');
    return [...new Set([...live, ...all.slice(-limit)])].sort((a, b) => b.createdAt - a.createdAt);
  },
  reset(): void {
    cache = null;
    dirty = false;
    busy = false;
    scanning = false;
    pricedAt = 0;
  },
};

// ---------------------------------------------------------------- helpers

const fmt = (coin: Coin, v: bigint) => fromBase(v, DECIMALS[coin]);
/** "0.123456789" floored to `places` decimals. */
const floorDec = (v: string, places: number) => {
  const [w, f = ''] = v.split('.');
  const frac = f.slice(0, places).replace(/0+$/, '');
  return frac ? `${w}.${frac}` : w;
};
const backoff = (tries: number) => Math.min(20 * S * 2 ** Math.max(0, tries - 1), 10 * M);
const testMode = () => config.privacyTestDelayMin !== null;
const delayMs = (t: TransferRecord) => (!t.delayHours ? 0 : testMode() ? config.privacyTestDelayMin! * M : t.delayHours * H);
const newJitter = () => (testMode() ? crypto.randomInt(0, 30 * S) : crypto.randomInt(0, 30 * M));
/** The pause before the next piece: log-uniform from 5 minutes to 2 hours, so short and long gaps are both common. */
const newGap = () => {
  const [lo, hi] = testMode() ? [5 * S, 30 * S] : [5 * M, 2 * H];
  return Math.round(lo * (hi / lo) ** (crypto.randomInt(0, 1_000_001) / 1_000_000));
};
const refOf = (r: Route): RouteRef => ({ coin: r.coin, index: r.index, address: r.address });
const shortTx = (h: string) => `${h.slice(0, 8)}…`;
/** What the destination is paid in (older records: USDT on Ethereum), its short name ("USDT", "USDC"), and its explorer. */
const ccyOf = (t: TransferRecord): Stable => t.destination.ccy ?? 'USDT';
const symOf = (t: TransferRecord) => PAYOUTS[ccyOf(t)].symbol;
const txUrl = (t: TransferRecord, hash: string) => PAYOUTS[ccyOf(t)].explorerTx(hash);
const finishedState = (t: TransferRecord) => t.state === 'done' || t.state === 'refunded';
/** Whether a transfer's money waits in our Monero wallet (rather than going straight on). */
const inMonero = (t: TransferRecord) => t.monero ?? t.privacy;
/** A Monero payment with a wait or pieces takes the Monero path too. */
const viaMonero = (coin: Coin, privacy: boolean, delayHours: number | null, pieces: number) => privacy || (coin === 'XMR' && (Boolean(delayHours) || pieces > 1));
const piecesOf = (t: TransferRecord) => Math.min(Math.max(t.pieces ?? 1, 1), PIECES_MAX);

/** Where a transfer's coins are spent from: a Bitcoin piece's own address, or the permanent address. */
function srcOf(t: TransferRecord): RouteRef {
  if (t.source) return t.source;
  return refOf(addresses.get(t.routeId)!);
}

/** The pieces of a split payment, in order. */
function childrenOf(t: TransferRecord): TransferRecord[] {
  return load()
    .transfers.filter((k) => k.parentId === t.id)
    .sort((a, b) => a.piece!.n - b.piece!.n);
}

/** When a piece may go: piece 1 at the parent's release time; each later one a random pause after the one before settled. */
function plannedRelease(t: TransferRecord): number {
  const parent = transfers.get(t.parentId!);
  const base = parent?.releaseAt ?? t.createdAt;
  const kids = parent ? childrenOf(parent) : [t];
  return base + kids.filter((k) => k.piece!.n <= t.piece!.n).reduce((s, k) => s + (k.gapMs ?? 0), 0);
}
function pieceRelease(t: TransferRecord): number | null {
  const planned = plannedRelease(t);
  if (t.piece!.n === 1) return planned;
  const parent = transfers.get(t.parentId!);
  const prev = parent ? childrenOf(parent).find((k) => k.piece!.n === t.piece!.n - 1) : null;
  if (!prev) return planned;
  if (!prev.settledAt) return null;
  return Math.max(planned, prev.settledAt + (t.gapMs ?? 0));
}

/**
 * Random, unequal shares of `total` (base units), each at least `min`: amounts that don't add up to anything round.
 * Fewer pieces when `total` can't give each one the minimum; one share means "don't split".
 */
export function planPieces(total: bigint, n: number, min: bigint): bigint[] {
  for (let k = Math.min(n, PIECES_MAX); k > 1; k--) {
    if (total < min * BigInt(k)) continue;
    const rest = total - min * BigInt(k);
    const weights = Array.from({ length: k }, () => BigInt(crypto.randomInt(1_000, 3_001)));
    const sum = weights.reduce((s, w) => s + w, 0n);
    const shares = weights.map((w) => min + (rest * w) / sum);
    shares[k - 1] += total - shares.reduce((s, v) => s + v, 0n); // the rounding goes to the last piece
    return shares;
  }
  return [total];
}

/** FixedFloat's minimum for a piece of `coin` → USDT, with room for the fees on the way and price moves (base units). */
async function pieceMin(coin: Coin, ccy: Stable, now: number): Promise<bigint> {
  const lim = await limits(coin, ccy, { now });
  return toBase((lim.min * PIECE_MIN_FACTOR).toFixed(8), DECIMALS[coin]) ?? 0n;
}

/** Adds to a transfer's own history, and to the server log. */
function note(t: TransferRecord, text: string, now: number, level: 'info' | 'warn' = 'info'): void {
  t.log.push({ at: now, text });
  logger[level](`[transfer ${t.id}] ${text}`);
}

function advance(t: TransferRecord, state: TransferState, text: string, now: number): void {
  t.state = state;
  t.tries = 0;
  t.error = null;
  t.waitingFor = null;
  t.nextAt = now;
  t.log.push({ at: now, text });
  logger.info(`[transfer ${t.id}] → ${state}: ${text}`);
  markDirty();
}

const later = (t: TransferRecord, now: number, ms: number, waitingFor: string | null = null) => {
  if (t.waitingFor !== waitingFor) {
    markDirty();
    if (waitingFor) logger.info(`[transfer ${t.id}] waiting for ${waitingFor}`);
  }
  t.waitingFor = waitingFor;
  t.nextAt = now + ms;
};

function needAttention(t: TransferRecord, why: string, now: number): void {
  t.attention = why;
  t.nextAt = Number.MAX_SAFE_INTEGER;
  if (t.parentId) t.settledAt ??= now; // a stuck piece doesn't hold up the next one
  note(t, `Needs you: ${why}`, now, 'warn');
  markDirty();
}

/** Outpoints our own sends from this route spent (or are about to): a scan mustn't count them again. */
function spentBy(routeId: string, now: number): Set<string> {
  const out = new Set<string>();
  for (const t of load().transfers) {
    if (t.routeId === routeId && now - (t.forward?.createdAt ?? t.createdAt) < 30 * D) {
      for (const i of [...(t.forward?.inputs ?? []), ...(t.forwardInputs ?? []), ...(t.split?.inputs ?? [])]) out.add(i);
    }
  }
  return out;
}

/** Before signing: is this order still fresh, unpaid and at a never-used address? Otherwise it's dropped for a new one. */
function stale(o: OrderRecord, now: number): string | null {
  if (o.abandoned) return 'was dropped';
  if (o.reusedAddress) return 'reuses an old deposit address';
  if (o.ff.status !== 'NEW') return `is already ${o.ff.status}`;
  if (now - o.createdAt > PAY_WITHIN) return 'is too old to pay now';
  return null;
}

/** Broadcasts a saved send. "Already known" counts as done: what matters is that the network has it. */
async function broadcast(w: HotWallet, send: Send, now: number): Promise<void> {
  if (send.broadcastAt) return;
  for (let i = 0; i < send.raw.length; i++) {
    try {
      await w.broadcast(send.raw[i]);
    } catch (e) {
      const seen = await w.status(send.txids[i]).catch(() => null);
      if (!seen) throw e;
    }
  }
  send.broadcastAt = now;
  logger.info(`hot wallet sent ${send.amount || 'everything'} (fee ${send.fee || '?'}) to ${send.to}${send.orderId ? ` for order ${send.orderId}` : ''}: ${send.txids.join(', ')}`);
  persist();
}

function needOrder(id: string | undefined, t: TransferRecord) {
  const o = id ? orders.get(id) : null;
  if (!o || o.transferId !== t.id) throw new UserError(`FixedFloat order ${id ?? '?'} for this transfer is missing.`);
  return o;
}

function finish(t: TransferRecord, v: OrderView, now: number): void {
  for (const s of [t.forward, t.churn, t.sweep, t.split]) if (s) s.raw = []; // long settled: the signed transactions aren't needed any more
  t.usdt = v.usdt;
  t.payoutTx = v.payoutTx;
  t.doneAt = now;
  t.settledAt ??= now;
  advance(t, 'done', `${v.usdt ? `${v.usdt} ${symOf(t)}` : symOf(t)} sent to ${t.destination.label}`, now);
  t.nextAt = Number.MAX_SAFE_INTEGER;
}

function usdtExpect(t: TransferRecord): Expect {
  return { toCcy: ccyOf(t), toAddress: t.destination.address, label: t.destination.label };
}

/** Where Privacy XMR sits while waiting: the churn subaddress once it's been moved, the vault before that. */
const hold = (t: TransferRecord) => (t.churn?.broadcastAt ? { index: t.churn.index, address: t.churn.address } : { index: t.vault!.index, address: t.vault!.address });

// ---------------------------------------------------------------- steps

/**
 * A payment landed at a permanent address (or a piece is ready at its own): wait until it's confirmed and above
 * FixedFloat's minimum, then until its wait is over; then forward it, or split it into pieces.
 */
async function collect(t: TransferRecord, now: number): Promise<void> {
  const route = addresses.get(t.routeId)!;
  const w = hotWallet(route.coin);
  if (!w) return later(t, now, 5 * M, `the ${COINS[route.coin].name} hot wallet to be unlocked`);
  const src = srcOf(t);
  const exclude = spentBy(route.id, now);
  const s = await w.scan(src, exclude);
  if (!t.parentId) {
    // A piece shows its own share; the address may hold the other pieces too (Ethereum).
    const received = fmt(route.coin, s.seen);
    if (received !== t.received || s.confirmations !== t.inbound?.confirmations) markDirty();
    t.received = received;
    t.inbound = { txids: s.txids, confirmations: s.confirmations, required: s.required, spendable: fmt(route.coin, s.spendable) };
  }
  if (s.seen === 0n) {
    // The payment vanished (dropped from the mempool) or was forwarded by an older transfer.
    if (now - t.createdAt > 2 * H) {
      if (t.parentId) return needAttention(t, `The coins of this piece are no longer at ${src.address}.`, now);
      load().transfers.splice(load().transfers.indexOf(t), 1);
      markDirty();
      return;
    }
    return later(t, now, M, 'the payment to show up again');
  }
  if (s.busy) return later(t, now, 30 * S, 'the previous forward from this address to confirm');
  if (s.spendable === 0n) return later(t, now, 30 * S, `confirmations (${s.confirmations} of ${s.required})`);

  if (t.parentId) {
    const at = pieceRelease(t);
    if (at === null) return later(t, now, M, `piece ${t.piece!.n - 1} to go first`);
    if (t.releaseAt !== at) {
      t.releaseAt = at;
      markDirty();
    }
    if (now < at) return later(t, now, Math.min(at - now, 5 * M), null);
  }

  const to = t.privacy ? 'XMR' : ccyOf(t);
  const lim = await limits(route.coin, to, { now, cached: true });
  const q = await w.quote(src, exclude);
  if (!q) return later(t, now, 30 * S, `confirmations (${s.confirmations} of ${s.required})`);
  const base = t.pieceAmount && BigInt(t.pieceAmount) < q.amount ? BigInt(t.pieceAmount) : q.amount;
  const amount = Number(fmt(route.coin, base));
  if (amount < lim.min * 1.01) {
    const usd = (v: number) => (lim.usdPerCoin ? ` (≈ $${(v * lim.usdPerCoin).toFixed(2)})` : '');
    if (t.parentId) return needAttention(t, `This piece (${amount} ${route.coin}) is below FixedFloat's minimum of ${lim.min} ${route.coin}${usd(lim.min)}.`, now);
    return later(t, now, 2 * M, `more to arrive: FixedFloat's minimum is ${lim.min} ${route.coin}${usd(lim.min)}, ${amount} ${route.coin} so far${usd(amount)}`);
  }
  if (amount > lim.max && piecesOf(t) === 1) return needAttention(t, `${amount} ${route.coin} is above FixedFloat's maximum of ${lim.max} ${route.coin}.`, now);
  const confirmed = `${fmt(route.coin, s.spendable)} ${route.coin} confirmed at "${route.label}"`;

  if (!t.parentId) {
    // Monero with a wait or pieces: its own subaddress is the vault, and the Monero path does the rest.
    if (inMonero(t) && route.coin === 'XMR') {
      t.vault = { index: route.index, address: route.address, amount: fmt('XMR', s.spendable), confirmations: s.confirmations, unlockedAt: null, seenAt: now };
      return advance(t, 'xmr-in', confirmed, now);
    }
    if (!inMonero(t)) {
      if (t.delayHours && !t.heldAt) {
        t.heldAt = now;
        t.releaseAt = now + delayMs(t) + t.jitterMs;
        return advance(t, 'hold', `${confirmed}; waiting ${t.delayHours} h before it goes on`, now);
      }
      if (t.releaseAt !== null && now < t.releaseAt) return advance(t, 'hold', 'Still waiting', now);
      if (piecesOf(t) > 1) {
        t.releaseAt ??= now;
        if (route.coin === 'BTC') return advance(t, 'split', `${confirmed}; splitting it into ${piecesOf(t)} pieces`, now);
        return ethPieces(t, route, q, now);
      }
    }
  }
  const blocker = pairBusy(route.coin, to, now);
  if (blocker) return later(t, now, M, `FixedFloat order ${blocker.id} (${route.coin} → ${to}) to finish first (FixedFloat's rules)`);
  advance(t, 'open1', t.parentId ? `Piece ${t.piece!.n} of ${t.piece!.of}: its turn` : confirmed, now);
}

/** A direct payment waits before it's forwarded (anything that arrives meanwhile joins it). */
async function holdStep(t: TransferRecord, now: number): Promise<void> {
  if (t.releaseAt !== null && now < t.releaseAt) return later(t, now, Math.min(t.releaseAt - now, 5 * M), null);
  advance(t, 'collect', 'Wait over', now);
}

/** Starts the pieces of a split payment, each a transfer of its own; the parent waits for them in `pieces`. */
function spawnPieces(t: TransferRecord, list: { amount: string; vault?: { index: number; address: string }; source?: RouteRef }[], start: TransferState, now: number): void {
  if (childrenOf(t).length) return;
  const of = list.length;
  list.forEach((p, i) => {
    const k = blank(t.coin, t.privacy, t.delayHours, t.destinationId, t.destination, t.routeId, start, now);
    k.monero = inMonero(t);
    k.parentId = t.id;
    k.piece = { n: i + 1, of };
    k.gapMs = i === 0 ? 0 : newGap();
    k.jitterMs = 0;
    if (p.vault) {
      k.vault = { index: p.vault.index, address: p.vault.address, amount: xmr.formatXmr(BigInt(p.amount)), confirmations: 0, unlockedAt: null };
    } else {
      k.pieceAmount = p.amount;
      k.received = fmt(t.coin, BigInt(p.amount));
      if (p.source) k.source = p.source;
    }
    note(k, `Piece ${i + 1} of ${of} of transfer ${t.id}`, now);
    load().transfers.push(k);
  });
  t.pieces = of;
  markDirty();
}

/** Ethereum pieces: no split transaction, each forwards its share straight from the address, one after another. */
async function ethPieces(t: TransferRecord, route: Route, q: { amount: bigint; fee: bigint }, now: number): Promise<void> {
  const want = piecesOf(t);
  // Every piece pays its own gas, so keep that back for all of them.
  const total = q.amount - BigInt(want - 1) * q.fee;
  const plan = total > 0n ? planPieces(total, want, await pieceMin(route.coin, ccyOf(t), now)) : [q.amount];
  if (plan.length < 2) {
    note(t, `Too little to split into ${want} pieces: it goes in one`, now);
    t.pieces = 1;
    markDirty();
    return;
  }
  if (plan.length < want) note(t, `Split into ${plan.length} pieces, not ${want}: each needs FixedFloat's minimum`, now);
  spawnPieces(t, plan.map((a) => ({ amount: a.toString() })), 'collect', now);
  advance(t, 'pieces', `Sending ${fmt(route.coin, total)} ETH in ${plan.length} pieces, one after another, at random times`, now);
}

/** Bitcoin: one transaction pays a fresh change-chain address of ours per piece; then each piece forwards by itself. */
async function splitStep(t: TransferRecord, now: number): Promise<void> {
  const route = addresses.get(t.routeId)!;
  const w = hotWallet(route.coin);
  if (!w?.quoteSplit || !w.prepareSplit) return later(t, now, 5 * M, `the ${COINS[route.coin].name} hot wallet to be unlocked`);
  if (!t.split) {
    let n = piecesOf(t);
    let q = await w.quoteSplit(refOf(route), n, spentBy(route.id, now));
    if (!q) return later(t, now, 30 * S, 'the coins to confirm');
    const min = await pieceMin(route.coin, ccyOf(t), now);
    let plan = planPieces(q.amount, n, min);
    if (plan.length < n && plan.length > 1) {
      n = plan.length;
      q = (await w.quoteSplit(refOf(route), n, spentBy(route.id, now)))!;
      plan = planPieces(q.amount, n, min);
    }
    if (plan.length < 2) {
      note(t, `Too little to split into ${piecesOf(t)} pieces: it goes in one`, now);
      t.pieces = 1;
      return advance(t, 'collect', 'Sending it in one piece', now);
    }
    if (plan.length < piecesOf(t)) note(t, `Split into ${plan.length} pieces, not ${piecesOf(t)}: each needs FixedFloat's minimum`, now);
    const outs = plan.map((a) => {
      const ref = addresses.internal('BTC');
      return { index: ref.index, address: ref.address, amount: a.toString() };
    });
    t.split = { orderId: null, to: 'pieces', amount: fmt('BTC', q.amount), fee: fmt('BTC', q.fee), txids: [], raw: [], inputs: q.inputs, createdAt: now, broadcastAt: null, outs };
    persist();
  }
  const own = (o: { index: number; address: string }): RouteRef => ({ coin: 'BTC', index: o.index, address: o.address, chain: 1 });
  if (!t.split.raw.length) {
    const p = await w.prepareSplit(
      refOf(route),
      t.split.outs.map((o) => ({ ref: own(o), amount: BigInt(o.amount) })),
      { inputs: t.split.inputs! },
    );
    Object.assign(t.split, { txids: p.txids, raw: p.raw, amount: fmt('BTC', p.amount), fee: fmt('BTC', p.fee) });
    persist(); // on disk before it goes out
  }
  await broadcast(w, t.split, now);
  // The pieces count on the split: make sure the network has it (and send the same one again if it was dropped).
  if (!(await w.status(t.split.txids[0]))) {
    if (now - t.split.broadcastAt! > 10 * M) {
      t.split.broadcastAt = null;
      markDirty();
    }
    return later(t, now, M, 'the split to reach the network');
  }
  spawnPieces(t, t.split.outs.map((o) => ({ amount: o.amount, source: own(o) })), 'collect', now);
  advance(t, 'pieces', `Split ${t.split.amount} BTC into ${t.split.outs.length} pieces (tx ${shortTx(t.split.txids[0])}, network fee ${t.split.fee})`, now);
}

/** A split payment waits for its pieces; it's done when they all are. */
async function piecesStep(t: TransferRecord, now: number): Promise<void> {
  const kids = childrenOf(t);
  if (!kids.length) return needAttention(t, 'Its pieces are missing.', now);
  const sent = kids.filter((k) => k.state === 'done');
  if (kids.every(finishedState)) {
    if (!sent.length) {
      advance(t, 'refunded', 'Every piece was sent back', now);
      t.nextAt = Number.MAX_SAFE_INTEGER;
      return;
    }
    for (const s of [t.forward, t.churn, t.sweep, t.split]) if (s) s.raw = [];
    t.usdt = String(Math.round(sent.reduce((s, k) => s + Number(k.usdt ?? 0), 0) * 1e6) / 1e6);
    t.payoutTx = sent[sent.length - 1].payoutTx;
    t.doneAt = now;
    advance(t, 'done', `${t.usdt} ${symOf(t)} sent to ${t.destination.label} in ${sent.length} piece${sent.length === 1 ? '' : 's'}`, now);
    t.nextAt = Number.MAX_SAFE_INTEGER;
    return;
  }
  const stuck = kids.find((k) => k.attention);
  later(t, now, 20 * S, stuck ? `you: piece ${stuck.piece!.n} needs a look` : `${sent.length} of ${kids.length} pieces sent`);
}

/** Creates the FixedFloat order our wallet will pay, for exactly what it can send. */
async function open1(t: TransferRecord, now: number): Promise<void> {
  if (t.leg1) return advance(t, 'send1', 'FixedFloat order ready', now);
  const route = addresses.get(t.routeId)!;
  const w = hotWallet(route.coin);
  if (!w) return later(t, now, 5 * M, `the ${COINS[route.coin].name} hot wallet to be unlocked`);
  const to = t.privacy ? 'XMR' : ccyOf(t);
  const blocker = pairBusy(route.coin, to, now);
  if (blocker) return later(t, now, M, `FixedFloat order ${blocker.id} (${route.coin} → ${to}) to finish first (FixedFloat's rules)`);
  const exclude = spentBy(route.id, now);
  const q = await w.quote(srcOf(t), exclude);
  if (!q) return advance(t, 'collect', 'Nothing to forward yet', now);
  const lim = await limits(route.coin, to, { now });
  // An Ethereum piece forwards its own share; the rest of the address belongs to the other pieces.
  const base = t.pieceAmount && BigInt(t.pieceAmount) < q.amount ? BigInt(t.pieceAmount) : q.amount;
  const amount = floorDec(fmt(route.coin, base), lim.precision);

  let expect = usdtExpect(t);
  if (t.privacy) {
    if (!t.vault) {
      const v = await xmr.newSubaddress(`wallet-click ${t.id} vault`);
      t.vault = { index: v.index, address: v.address, amount: null, confirmations: 0, unlockedAt: null };
      persist();
    }
    expect = { toCcy: 'XMR', toAddress: t.vault.address, label: 'Monero vault' };
  }
  const o = await openSwap({ from: route.coin, amount: Number(amount), expect, transferId: t.id, ownRefund: route.address, destinationId: t.destinationId }, now);
  t.leg1 = o.id;
  t.forwardAmount = toBase(amount, DECIMALS[route.coin])!.toString();
  t.forwardInputs = q.inputs;
  persist();
  advance(t, 'send1', `FixedFloat order ${o.id}: ${amount} ${route.coin} → ${to === 'XMR' ? 'Monero' : `${symOf(t)} for ${t.destination.label}`}`, now);
}

/** Our hot wallet pays the order: signed, saved, then broadcast. */
async function send1(t: TransferRecord, now: number): Promise<void> {
  const route = addresses.get(t.routeId)!;
  const w = hotWallet(route.coin);
  if (!w) return later(t, now, 5 * M, `the ${COINS[route.coin].name} hot wallet to be unlocked`);
  const o = needOrder(t.leg1, t);
  if (o.ownRefund !== route.address) throw new UserError('Refusing to pay an order that would refund somewhere else.');
  if (!t.forward) {
    const why = stale(o, now);
    if (why) {
      abandon(o);
      t.leg1 = undefined;
      t.forwardAmount = undefined;
      t.forwardInputs = undefined;
      return advance(t, 'open1', `FixedFloat order ${o.id} ${why}; making a new one`, now);
    }
    const p = await w.prepare(srcOf(t), o.depositAddress, BigInt(t.forwardAmount!), { inputs: t.forwardInputs, exclude: spentBy(route.id, now) });
    // Monero sweeps everything unlocked: if more has unlocked since the order was made, order again for the real amount.
    if (p.amount > (BigInt(t.forwardAmount!) * 101n) / 100n + 10n ** 8n) {
      abandon(o);
      t.leg1 = undefined;
      t.forwardAmount = undefined;
      return advance(t, 'open1', `More arrived meanwhile (${fmt(route.coin, p.amount)} ${route.coin}); making a new order`, now);
    }
    t.forward = { orderId: o.id, to: o.depositAddress, amount: fmt(route.coin, p.amount), fee: fmt(route.coin, p.fee), txids: p.txids, raw: p.raw, inputs: p.inputs, createdAt: now, broadcastAt: null };
    persist(); // on disk before it goes out
  }
  await broadcast(w, t.forward, now);
  o.nextPollAt = now; // ask FixedFloat straight away
  advance(t, 'swap1', `Sent ${t.forward.amount} ${route.coin} to FixedFloat (tx ${shortTx(t.forward.txids[0])})`, now);
}

/** FixedFloat does the first (or only) swap. */
async function swap1(t: TransferRecord, now: number): Promise<void> {
  const o = needOrder(t.leg1, t);
  const v = orderView(o, now);
  if (!t.routeId && v.received !== t.received) {
    t.received = v.received;
    markDirty();
  }
  if (v.stage === 'done') {
    if (!t.privacy) return finish(t, v, now);
    t.vault!.amount = v.usdt; // XMR, as FixedFloat reports it
    return advance(t, 'xmr-in', `Swapped to ${v.usdt ?? ''} XMR (FixedFloat order ${o.id})`, now);
  }
  if (v.stage === 'refunded' && v.refundTx) {
    advance(t, 'refunded', `FixedFloat sent the payment back${v.refundTo ? ` to ${v.refundTo}` : ''}`, now);
    t.nextAt = Number.MAX_SAFE_INTEGER;
    t.settledAt ??= now;
    return;
  }
  // FixedFloat's own questions (below the minimum, above the maximum) are answered on the order itself.
  const why = v.stage === 'attention' ? `a decision on FixedFloat order ${o.id}` : null;
  later(t, now, 8 * S, why);
}

/** The XMR arrives at the vault subaddress and unlocks (10 blocks); then the delay starts. */
async function xmrIn(t: TransferRecord, now: number): Promise<void> {
  const v = t.vault!;
  const b = await xmr.balance(v.index);
  if (b.total === 0n) return later(t, now, 30 * S, 'the Monero from FixedFloat to show up in the wallet');
  const rows = await xmr.incoming(v.index);
  const fresh = rows.filter((r) => r.pool || r.confirmations < xmr.XMR_LOCK_BLOCKS);
  const confirmations = fresh.length ? Math.min(...fresh.map((r) => r.confirmations)) : xmr.XMR_LOCK_BLOCKS;
  if (v.amount !== xmr.formatXmr(b.total) || v.confirmations !== confirmations || !v.seenAt) markDirty();
  v.amount = xmr.formatXmr(b.total);
  v.confirmations = confirmations;
  v.seenAt ??= now;
  if (b.unlocked > 0n && b.unlocked >= b.total) {
    v.unlockedAt = now;
    // A piece's turn comes from its parent's wait and the pieces before it.
    t.releaseAt = t.parentId ? pieceRelease(t) : now + delayMs(t) + t.jitterMs;
    return advance(t, 'churn', `${v.amount} XMR unlocked${t.piece ? ` (piece ${t.piece.n} of ${t.piece.of})` : ' in the vault'}`, now);
  }
  later(t, now, 30 * S, `the Monero to unlock (${Math.min(confirmations, xmr.XMR_LOCK_BLOCKS)} of ${xmr.XMR_LOCK_BLOCKS} confirmations)`);
}

/**
 * Moves the XMR once to a fresh subaddress of ours, so FixedFloat's own outputs never go straight back to it.
 * With pieces, this move is the split instead; each piece then moves once more by itself, at a random time before
 * its turn, so FixedFloat can't tie the pieces together through the one split transaction in their rings.
 */
async function churn(t: TransferRecord, now: number): Promise<void> {
  if (!t.parentId && piecesOf(t) > 1 && !t.churn) return splitMonero(t, now);
  if (t.parentId && !t.churn) {
    if (t.churnAt === undefined) {
      const latest = plannedRelease(t) - 30 * M;
      t.churnAt = latest > now ? now + crypto.randomInt(0, Math.min(latest - now, 2 ** 47)) : now;
      markDirty();
    }
    if (now < t.churnAt) return later(t, now, Math.min(t.churnAt - now, 5 * M), null);
  }
  if (!t.churn) {
    const c = await xmr.newSubaddress(`wallet-click ${t.id} churn`);
    t.churn = { index: c.index, address: c.address, orderId: null, to: c.address, amount: '', fee: '', txids: [], raw: [], createdAt: now, broadcastAt: null };
    persist();
  }
  if (!t.churn.raw.length) {
    const p = await xmr.prepareSweep(t.vault!.index, t.churn.address);
    Object.assign(t.churn, { txids: p.txids, raw: p.metadata, amount: xmr.formatXmr(p.amount), fee: xmr.formatXmr(p.fee) });
    persist();
  }
  await broadcast(xmrWallet, t.churn, now);
  advance(t, 'wait', `Moved ${t.churn.amount} XMR within the wallet (tx ${shortTx(t.churn.txids[0])})`, now);
}

/** Monero pieces: one transaction from the vault to a fresh subaddress per piece, the fee taken out of the pieces. */
async function splitMonero(t: TransferRecord, now: number): Promise<void> {
  const v = t.vault!;
  const b = await xmr.balance(v.index);
  if (!t.split?.raw.length) {
    if (b.unlocked === 0n || b.unlocked < b.total) return later(t, now, M, 'the Monero to unlock');
    const planned = t.split?.outs.reduce((s, o) => s + BigInt(o.amount), 0n);
    if (planned !== b.unlocked) {
      // First time, or more Monero arrived before it was signed: plan the pieces for what's there now.
      const want = t.split?.outs.length ?? piecesOf(t);
      const plan = planPieces(b.unlocked, want, await pieceMin('XMR', ccyOf(t), now));
      if (plan.length < 2) {
        note(t, `Too little to split into ${want} pieces: it goes in one`, now);
        t.pieces = 1;
        t.split = undefined;
        markDirty();
        return churn(t, now);
      }
      if (plan.length < piecesOf(t)) note(t, `Split into ${plan.length} pieces, not ${piecesOf(t)}: each needs FixedFloat's minimum`, now);
      const outs = t.split?.outs.slice(0, plan.length) ?? [];
      while (outs.length < plan.length) {
        const s = await xmr.newSubaddress(`wallet-click ${t.id} piece ${outs.length + 1}`);
        outs.push({ index: s.index, address: s.address, amount: '' });
      }
      outs.forEach((o, i) => (o.amount = plan[i].toString()));
      t.split = { orderId: null, to: 'pieces', amount: '', fee: '', txids: [], raw: [], createdAt: now, broadcastAt: null, outs };
      persist();
    }
    const p = await xmr.prepareSplit(v.index, t.split!.outs.map((o) => ({ address: o.address, amount: BigInt(o.amount) })));
    t.split!.outs.forEach((o, i) => (o.amount = p.amounts[i].toString())); // what each piece gets, after its share of the fee
    Object.assign(t.split!, { txids: p.txids, raw: p.metadata, amount: xmr.formatXmr(p.amount), fee: xmr.formatXmr(p.fee) });
    persist(); // on disk before it goes out
  }
  const split = t.split!;
  await broadcast(xmrWallet, split, now);
  spawnPieces(t, split.outs.map((o) => ({ amount: o.amount, vault: { index: o.index, address: o.address } })), 'xmr-in', now);
  advance(t, 'pieces', `Split ${split.amount} XMR into ${split.outs.length} pieces within the wallet (tx ${shortTx(split.txids[0])})`, now);
}

/** Waits until the release time, and until the moved XMR has unlocked again. */
async function wait(t: TransferRecord, now: number): Promise<void> {
  if (t.parentId) {
    const at = pieceRelease(t);
    if (at === null) return later(t, now, M, `piece ${t.piece!.n - 1} to go first`);
    if (t.releaseAt !== at) {
      t.releaseAt = at;
      markDirty();
    }
  }
  if (t.releaseAt !== null && now < t.releaseAt) return later(t, now, Math.min(t.releaseAt - now, 5 * M), null);
  const h = hold(t);
  const b = await xmr.balance(h.index);
  if (b.unlocked > 0n && b.unlocked >= b.total) return advance(t, 'open2', 'Wait over', now);
  if (b.total === 0n) return later(t, now, M, 'the Monero to show up in the wallet');
  later(t, now, M, `the Monero to unlock (${b.blocksToUnlock} blocks left)`);
}

/** The FixedFloat order XMR → USDT (or USDC), for exactly what the wallet can send. */
async function open2(t: TransferRecord, now: number): Promise<void> {
  if (t.leg2) return advance(t, 'send2', 'FixedFloat order ready', now);
  const blocker = pairBusy('XMR', ccyOf(t), now);
  if (blocker) return later(t, now, M, `FixedFloat order ${blocker.id} (XMR → ${ccyOf(t)}) to finish first (FixedFloat's rules)`);
  const h = hold(t);
  const b = await xmr.balance(h.index);
  if (b.unlocked === 0n || b.unlocked < b.total) return later(t, now, M, 'the Monero to unlock');
  // A sweep to ourselves, never relayed, tells the exact fee.
  const dry = await xmr.prepareSweep(h.index, h.address);
  const lim = await limits('XMR', ccyOf(t), { now });
  const amount = floorDec(xmr.formatXmr(dry.amount), lim.precision);
  const o = await openSwap({ from: 'XMR', amount: Number(amount), expect: usdtExpect(t), transferId: t.id, ownRefund: h.address, destinationId: t.destinationId }, now);
  t.leg2 = o.id;
  persist();
  advance(t, 'send2', `FixedFloat order ${o.id}: ${amount} XMR → ${symOf(t)} for ${t.destination.label}`, now);
}

async function send2(t: TransferRecord, now: number): Promise<void> {
  const o = needOrder(t.leg2, t);
  const h = hold(t);
  if (o.ownRefund !== h.address) throw new UserError('Refusing to pay an order that would refund somewhere else.');
  if (!t.sweep) {
    const why = stale(o, now);
    if (why) {
      abandon(o);
      t.leg2 = undefined;
      return advance(t, 'open2', `FixedFloat order ${o.id} ${why}; making a new one`, now);
    }
    const p = await xmr.prepareSweep(h.index, o.depositAddress);
    const ordered = toBase(String(o.ff.from.amount ?? '0'), xmr.XMR_DECIMALS) ?? 0n;
    if (p.amount > (ordered * 101n) / 100n + 10n ** 8n) {
      abandon(o);
      t.leg2 = undefined;
      return advance(t, 'open2', `More Monero arrived meanwhile (${xmr.formatXmr(p.amount)} XMR); making a new order`, now);
    }
    t.sweep = { orderId: o.id, to: o.depositAddress, amount: xmr.formatXmr(p.amount), fee: xmr.formatXmr(p.fee), txids: p.txids, raw: p.metadata, createdAt: now, broadcastAt: null };
    persist();
  }
  await broadcast(xmrWallet, t.sweep, now);
  o.nextPollAt = now;
  advance(t, 'swap2', `Sent ${t.sweep.amount} XMR to FixedFloat (tx ${shortTx(t.sweep.txids[0])})`, now);
}

async function swap2(t: TransferRecord, now: number): Promise<void> {
  const o = needOrder(t.leg2, t);
  const v = orderView(o, now);
  if (v.stage === 'done') return finish(t, v, now);
  if (v.stage === 'refunded') {
    // It came back to our own subaddress: swap it again when the owner says so.
    note(t, `FixedFloat sent the XMR back (order ${o.id})`, now);
    t.leg2 = undefined;
    t.sweep = undefined;
    t.state = 'wait';
    t.releaseAt = now;
    return needAttention(t, `FixedFloat sent the Monero back to your wallet (order ${o.id}). Press Retry to swap it again once it has unlocked.`, now);
  }
  later(t, now, 8 * S, v.stage === 'attention' ? `a decision on FixedFloat order ${o.id}` : null);
}

const STEPS: Partial<Record<TransferState, (t: TransferRecord, now: number) => Promise<void>>> = {
  collect,
  hold: holdStep,
  split: splitStep,
  open1,
  send1,
  swap1,
  'xmr-in': xmrIn,
  churn,
  wait,
  pieces: piecesStep,
  open2,
  send2,
  swap2,
};

/** Runs one step; failures retry with backoff, and a step that keeps failing asks the owner. */
export async function stepTransfer(t: TransferRecord, now = Date.now()): Promise<void> {
  const fn = STEPS[t.state];
  if (!fn || t.attention) return;
  try {
    await fn(t, now);
  } catch (e) {
    const why = friendlyError(e);
    if (e instanceof LimitError) return needAttention(t, why, now);
    t.tries++;
    t.error = why;
    t.nextAt = now + backoff(t.tries);
    markDirty();
    logger.warn({ err: e }, `[transfer ${t.id}] ${t.state} failed (try ${t.tries}), retrying in ${Math.round(backoff(t.tries) / S)} s`);
    // FixedFloat itself refusing (bad address, pair disabled…) won't fix itself; neither will a step failing for an hour.
    const final = e instanceof FfError && e.code > 0 && (t.state === 'open1' || t.state === 'open2');
    if (final || t.tries >= GIVE_UP_TRIES) needAttention(t, why, now);
  }
}

// ---------------------------------------------------------------- Monero left behind

/** Less than this left at a retired subaddress isn't worth a transfer. */
const LEFTOVER = 5_000_000_000n; // 0.005 XMR
let rescuedAt = 0;

/**
 * Monero that lands at a subaddress a transfer has already moved on from (FixedFloat paying a Privacy address a
 * second time, a split payout, a late refund) would otherwise sit there unnoticed. It becomes a new Privacy
 * transfer from that subaddress, with the same wait and destination.
 */
export async function rescueLeftovers(now = Date.now()): Promise<void> {
  if (!xmr.xmrConfigured() || now - rescuedAt < 10 * M) return;
  rescuedAt = now;
  const all = load().transfers;
  const moved = (t: TransferRecord) => Boolean(t.churn?.broadcastAt || t.split?.broadcastAt);
  // A permanent Monero address is never "left behind": the route scan looks after it.
  const inUse = new Set<number>(addresses.list(now).filter((r) => r.coin === 'XMR').map((r) => r.index));
  for (const t of all) {
    if (finishedState(t)) continue;
    if (t.vault && !moved(t)) inUse.add(t.vault.index);
    if (t.churn) inUse.add(t.churn.index);
  }
  for (const t of [...all]) {
    if (!t.vault || now - t.createdAt > 30 * D) continue;
    const retired: { index: number; address: string }[] = [];
    if (moved(t)) retired.push(t.vault);
    if (t.churn && finishedState(t)) retired.push(t.churn);
    for (const sub of retired) {
      if (inUse.has(sub.index)) continue;
      const b = await xmr.balance(sub.index).catch(() => null);
      if (!b || b.total < LEFTOVER) continue;
      const n = blank(t.coin, t.privacy, t.delayHours ?? DELAYS[1], t.destinationId, t.destination, t.routeId, 'xmr-in', now);
      n.monero = true;
      n.vault = { index: sub.index, address: sub.address, amount: xmr.formatXmr(b.total), confirmations: 0, unlockedAt: null };
      n.received = null;
      note(n, `${xmr.formatXmr(b.total)} XMR found left behind by transfer ${t.id}`, now);
      all.push(n);
      inUse.add(sub.index);
      markDirty();
    }
  }
  flush();
}

// ---------------------------------------------------------------- permanent addresses: spotting payments

const ROUTE_SCAN: Record<Coin, number> = { BTC: 30 * S, ETH: 20 * S, XMR: 30 * S };
/** Less than this at a permanent address is dust (gas leftovers): not worth a transfer. */
const DUST: Record<Coin, bigint> = { BTC: 2_000n, ETH: 300_000_000_000_000n, XMR: 100_000_000n };
const scanAt = new Map<string, number>();
let scanning = false;

/** Whether a transfer still counts on the coins sitting at its permanent address (so a scan mustn't start another). */
function usesAddress(t: TransferRecord, route: Route): boolean {
  if (finishedState(t) || t.source) return false;
  if (!t.parentId && ['collect', 'hold', 'split', 'open1', 'send1'].includes(t.state)) return true;
  // Ethereum pieces forward their shares straight from the address, one after another.
  if (t.parentId && route.coin === 'ETH') return true;
  // A Monero payment with a wait, until it has moved off the address.
  return route.coin === 'XMR' && t.vault?.index === route.index && !t.parentId && !(t.churn?.broadcastAt || t.split?.broadcastAt);
}

/** Looks at every permanent address that has no transfer collecting for it yet, and starts one when money lands. */
export async function scanRoutes(now = Date.now()): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    for (const route of addresses.list(now)) {
      if ((scanAt.get(route.id) ?? 0) > now) continue;
      scanAt.set(route.id, now + ROUTE_SCAN[route.coin]);
      // One payment at a time per address: the collecting transfer takes in everything that arrives meanwhile.
      if (load().transfers.some((t) => t.routeId === route.id && usesAddress(t, route))) continue;
      const w = hotWallet(route.coin);
      if (!w) continue;
      try {
        const s = await w.scan(refOf(route), spentBy(route.id, now));
        if (s.busy || s.seen < DUST[route.coin]) continue;
        const privacy = route.mode === 'privacy';
        const pieces = route.pieces ?? 1;
        const t = blank(route.coin, privacy, route.delayHours, route.destinationId, route.destination, route.id, 'collect', now);
        t.pieces = pieces;
        t.monero = viaMonero(route.coin, privacy, route.delayHours, pieces);
        t.received = fmt(route.coin, s.seen);
        t.inbound = { txids: s.txids, confirmations: s.confirmations, required: s.required, spendable: fmt(route.coin, s.spendable) };
        note(t, `Payment seen at "${route.label}": ${t.received} ${route.coin}`, now);
        load().transfers.push(t);
        markDirty();
      } catch {
        scanAt.set(route.id, now + 3 * ROUTE_SCAN[route.coin]); // endpoint hiccup: look again a bit later
      }
    }
  } finally {
    scanning = false;
    flush();
  }
}

function blank(
  coin: Coin,
  privacy: boolean,
  delayHours: number | null,
  destinationId: string,
  destination: { label: string; address: string; ccy?: Stable },
  routeId: string | null,
  state: TransferState,
  now: number,
): TransferRecord {
  return {
    id: `t_${crypto.randomBytes(6).toString('hex')}`,
    createdAt: now,
    coin,
    privacy,
    monero: privacy,
    delayHours: delayHours ?? null,
    jitterMs: newJitter(),
    destinationId,
    destination,
    routeId,
    state,
    received: null,
    releaseAt: null,
    usdt: null,
    payoutTx: null,
    doneAt: null,
    attention: null,
    error: null,
    waitingFor: null,
    tries: 0,
    nextAt: now,
    log: [],
  };
}

// ---------------------------------------------------------------- the owner's actions

const checkDelay = (h: number) => {
  if (!DELAYS.includes(h as (typeof DELAYS)[number])) throw new UserError(`Pick a wait of ${DELAYS.join(', ')} hours.`);
};
const checkPieces = (n: number) => {
  if (!(Number.isInteger(n) && n >= 1 && n <= PIECES_MAX)) throw new UserError(`Pick 1 to ${PIECES_MAX} pieces.`);
};

/** Privacy Enhanced with a fresh address: BTC/ETH → XMR (our vault) → wait → USDT, in one piece or several. */
export async function createPrivacyTransfer(coin: Coin, delayHours: number, destinationId?: string, now = Date.now(), pieces = 1): Promise<TransferRecord> {
  if (coin === 'XMR') throw new UserError('Pick Bitcoin or Ethereum: Monero is already private.');
  if (!xmr.xmrConfigured()) throw new UserError('Privacy Enhanced needs the VPS Monero wallet (MONERO_RPC_URL).');
  checkDelay(delayHours);
  checkPieces(pieces);
  const dest = destinations.need(destinationId);
  const t = blank(coin, true, delayHours, dest.id, { label: dest.label, address: dest.address, ccy: dest.ccy }, null, 'swap1', now);
  t.pieces = pieces;
  const v = await xmr.newSubaddress(`wallet-click ${t.id} vault`);
  t.vault = { index: v.index, address: v.address, amount: null, confirmations: 0, unlockedAt: null };
  const o = await createOrder(coin, { now, expect: { toCcy: 'XMR', toAddress: v.address, label: 'Monero vault' }, transferId: t.id });
  t.leg1 = o.id;
  const split = pieces > 1 ? ` in ${pieces} pieces` : '';
  note(t, `Privacy Enhanced: FixedFloat order ${o.id} pays ${COINS[coin].name} → Monero, then ${PAYOUTS[dest.ccy].symbol} to ${dest.label} after ${delayHours} h${split}`, now);
  load().transfers.push(t);
  persist();
  return t;
}

function need(id: string): TransferRecord {
  const t = transfers.get(id);
  if (!t) throw new HttpError(404, 'Transfer not found');
  return t;
}

/** States where the money hasn't gone on yet, so its wait can still be changed. */
const BEFORE_RELEASE: TransferState[] = ['swap1', 'collect', 'open1', 'send1', 'xmr-in', 'churn', 'wait'];

/** Whether a transfer is still before its wait is over: the wait can be changed (pieces: until the first one goes). */
function waitable(t: TransferRecord): boolean {
  if (t.parentId) return false;
  if (t.state === 'pieces') return childrenOf(t).every((k) => !k.leg1 && !k.leg2 && ['collect', 'xmr-in', 'churn', 'wait'].includes(k.state) && !(k.releaseAt && k.releaseAt <= Date.now()));
  if (inMonero(t)) return BEFORE_RELEASE.includes(t.state);
  return t.state === 'hold' || (t.state === 'collect' && t.releaseAt === null);
}

/** Skips the rest of the wait. Pieces still keep their random gaps. */
export function releaseNow(id: string, now = Date.now()): TransferRecord {
  const t = need(id);
  if (!waitable(t) || !t.delayHours) throw new UserError('There is no wait to skip.');
  t.delayHours = 0;
  if (t.releaseAt !== null) t.releaseAt = Math.min(t.releaseAt, now);
  t.jitterMs = 0;
  note(t, 'Released early', now);
  t.nextAt = now;
  for (const k of childrenOf(t)) k.nextAt = now;
  persist();
  return t;
}

/** Changes the wait (Monero: counted from when it unlocked; direct: from when the payment was confirmed). */
export function changeDelay(id: string, delayHours: number, now = Date.now()): TransferRecord {
  const t = need(id);
  checkDelay(delayHours);
  if (!waitable(t)) throw new UserError('This transfer is past its wait.');
  t.delayHours = delayHours;
  const from = inMonero(t) ? t.vault?.unlockedAt : t.heldAt;
  if (from) t.releaseAt = from + delayMs(t) + t.jitterMs;
  note(t, `Wait changed to ${delayHours} h`, now);
  t.nextAt = now;
  for (const k of childrenOf(t)) k.nextAt = now;
  persist();
  return t;
}

/** Tries a stuck step again (a split payment: its stuck pieces). */
export function retry(id: string, now = Date.now()): TransferRecord {
  const t = need(id);
  const stuck = [t, ...childrenOf(t)].filter((k) => k.attention || k.error);
  if (!stuck.length) throw new UserError('Nothing to retry.');
  for (const k of stuck) {
    k.attention = null;
    k.error = null;
    k.tries = 0;
    k.nextAt = now;
    note(k, 'Retrying', now);
  }
  persist();
  return t;
}

// ---------------------------------------------------------------- the loop

let busy = false;
/** One pass over the transfers that are due. */
export async function stepDue(now = Date.now()): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const due = load()
      .transfers.filter((t) => !t.attention && t.nextAt <= now && STEPS[t.state])
      .sort((a, b) => a.nextAt - b.nextAt)
      .slice(0, 6);
    for (const t of due) await stepTransfer(t, Date.now());
  } finally {
    busy = false;
    flush();
    flushOrders();
  }
}

// ---------------------------------------------------------------- dollar values

/** States where the transfer's money sits in our Monero vault. */
const IN_VAULT: TransferState[] = ['xmr-in', 'churn', 'wait', 'open2', 'send2', 'swap2'];
const held = (t: TransferRecord): { coin: Coin; amount: string | null } =>
  t.vault?.amount && IN_VAULT.includes(t.state) ? { coin: 'XMR', amount: t.vault.amount } : { coin: t.coin, amount: t.received };

/** Roughly what a transfer is worth in US dollars right now: the USDT it paid, the Monero it holds, or what came in. */
function usdValue(t: TransferRecord, now: number): number | null {
  if (t.state === 'done' && t.usdt) return Number(t.usdt);
  const kids = t.state === 'pieces' ? childrenOf(t) : [];
  if (kids.length) {
    const values = kids.map((k) => usdValue(k, now));
    return values.some((v) => v === null) ? null : Math.round(values.reduce<number>((s, v) => s + v!, 0) * 100) / 100;
  }
  const { coin, amount } = held(t);
  const n = Number(amount);
  const price = usdPrice(coin, now);
  return price && n > 0 ? Math.round(n * price * 100) / 100 : null;
}

/**
 * What a finished transfer cost: FixedFloat's cut on each swap plus every network fee on the way (our forwards,
 * the split, the Monero moves), as dollars and a share of what came in. When the money waited in Monero, `drift` is
 * how much the Monero price moved meanwhile: not a cost, so it's kept apart. A split payment counts all its pieces.
 */
function transferCost(t: TransferRecord) {
  if (t.state !== 'done' || !t.usdt || t.parentId) return null;
  const out = Number(t.usdt);
  const leg1 = t.leg1 ? orders.get(t.leg1) : null;
  const kids = childrenOf(t).filter((k) => k.state === 'done');
  if (!inMonero(t)) {
    // The price when the (first) forward was swapped.
    const first = leg1 ?? (kids[0]?.leg1 ? orders.get(kids[0].leg1) : null);
    const inUsd = Number(t.received) * (first?.prices?.from ?? NaN);
    return costOf(inUsd, inUsd - out);
  }
  // Each part that was swapped from Monero to USDT: the transfer itself, or its pieces.
  const parts = (kids.length ? kids : [t]).map((k) => ({ xmr: Number(k.vault?.amount), p2: k.leg2 ? orders.get(k.leg2)?.prices : undefined }));
  if (parts.some((p) => !p.p2 || !(p.xmr > 0))) return null;
  const atSwap = parts.reduce((s, p) => s + p.xmr * p.p2!.from, 0);
  if (!t.received) return costOf(atSwap, atSwap - out); // Monero found left behind: it started in the vault
  const p1 = leg1?.prices;
  if (t.leg1 && !p1) return null;
  // Paid in Monero: there was no first swap, so its price is the one at the (first) swap to USDT.
  const inPrice = p1 ? p1.from : parts[0].p2!.from;
  const xmrPrice = p1 ? p1.to : parts[0].p2!.from;
  const inUsd = Number(t.received) * inPrice;
  const drift = parts.reduce((s, p) => s + p.xmr * (p.p2!.from - xmrPrice), 0);
  const c = costOf(inUsd, inUsd - out + drift);
  return c && { ...c, drift: Math.round(drift * 100) / 100 };
}

let pricedAt = 0;
/** Keeps prices fresh for the transfers still in progress (the desktop shows their dollar value). Every few minutes at most. */
export async function refreshPrices(now = Date.now()): Promise<void> {
  if (now - pricedAt < 5 * M) return;
  pricedAt = now;
  const coins = new Set(load().transfers.filter((t) => t.state !== 'done' && t.state !== 'refunded' && (t.received || t.vault?.amount)).map((t) => held(t).coin));
  for (const coin of coins) await limits(coin, 'USDCBASE', { now, cached: true }).catch(() => {});
}

export function startTransfers(log: FastifyBaseLogger): () => void {
  const timer = setInterval(() => {
    refreshPrices().catch(() => {});
    scanRoutes().catch((e) => log.warn({ err: e }, 'route scan failed'));
    rescueLeftovers().catch((e) => log.warn({ err: e }, 'leftover check failed'));
    stepDue().catch((e) => log.warn({ err: e }, 'transfer step failed'));
  }, 2 * S);
  timer.unref();
  return () => clearInterval(timer);
}

export function stopTransfers(): void {
  flush();
}

// ---------------------------------------------------------------- what the browser sees

export type StepStatus = 'done' | 'active' | 'pending' | 'failed';
export interface StepView {
  key: string;
  label: string;
  status: StepStatus;
  detail: string | null;
  link: string | null;
}

const ORDER: TransferState[] = ['collect', 'hold', 'split', 'open1', 'send1', 'swap1', 'xmr-in', 'churn', 'wait', 'pieces', 'open2', 'send2', 'swap2', 'done'];

/** The list of steps the transfer window shows, worked out from the state. */
function stepsOf(t: TransferRecord, leg1: OrderView | null, leg2: OrderView | null, route: Route | null, kids: TransferRecord[], now: number): StepView[] {
  const at = ORDER.indexOf(t.state);
  const status = (from: TransferState, to: TransferState): StepStatus => {
    if (t.state === 'done') return 'done';
    const a = ORDER.indexOf(from);
    const b = ORDER.indexOf(to);
    if (at > b) return 'done';
    if (at >= a) return t.attention ? 'failed' : 'active';
    return 'pending';
  };
  const c = COINS[t.coin];
  const steps: StepView[] = [];
  const legStage = leg1?.stage;
  const paidSeen = leg1 && ['received', 'swapping', 'sending', 'done'].includes(legStage ?? '');
  const monero = inMonero(t);
  const n = kids.length || piecesOf(t);
  const split = n > 1;
  const sent = kids.filter((k) => k.state === 'done');
  const goneOut = kids.some((k) => Boolean(k.leg1 || k.leg2) || finishedState(k));
  const piecesStatus = (): StepStatus => {
    if (t.state === 'done') return 'done';
    if (t.state !== 'pieces' || (monero && !goneOut)) return 'pending';
    return kids.some((k) => k.attention) ? 'failed' : 'active';
  };
  const hours = t.delayHours ?? 0;
  const left = t.releaseAt !== null ? t.releaseAt - now : null;
  // The browser shows the release time in its own time zone.
  const waitDetail = (before: string) => (t.releaseAt === null ? before : left !== null && left > 0 ? null : 'Over');
  const waitLabel = hours ? `Wait ${hours} hours` : 'Wait (released early)';

  if (route) {
    steps.push({
      key: 'in',
      label: route.oneTime ? `${c.name} payment` : `Payment at "${route.label}"`,
      status: status('collect', 'collect'),
      detail: t.received ? `${t.received} ${t.coin}${t.state === 'collect' && t.inbound ? `, ${Math.min(t.inbound.confirmations, t.inbound.required)} of ${t.inbound.required} confirmations` : ''}` : null,
      link: t.inbound?.txids[0] && t.coin !== 'XMR' ? c.explorerTx(t.inbound.txids[0]) : null,
    });
    if (!monero && (hours || t.heldAt)) {
      steps.push({
        key: 'wait',
        label: waitLabel,
        status: t.state === 'hold' ? 'active' : t.heldAt && left !== null && left <= 0 ? 'done' : status('hold', 'hold'),
        detail: waitDetail('Starts once the payment is confirmed'),
        link: null,
      });
    }
    if (!monero && split) {
      if (t.coin === 'BTC') {
        steps.push({
          key: 'split',
          label: `Split into ${n} pieces`,
          status: status('split', 'split'),
          detail: t.split?.broadcastAt ? `${t.split.amount} BTC (network fee ${t.split.fee})` : null,
          link: t.split?.txids[0] ? c.explorerTx(t.split.txids[0]) : null,
        });
      }
      steps.push({
        key: 'pieces',
        label: `Forward ${n} pieces to FixedFloat, at random times`,
        status: piecesStatus(),
        detail: kids.length ? `${sent.length} of ${kids.length} sent` : null,
        link: null,
      });
    } else if (!monero || t.privacy) {
      steps.push({
        key: 'forward',
        label: 'Forward to FixedFloat',
        status: status('open1', 'send1'),
        detail: t.forward ? `${t.forward.amount} ${t.coin} (network fee ${t.forward.fee})` : null,
        link: t.forward?.txids[0] ? c.explorerTx(t.forward.txids[0]) : null,
      });
    }
  } else {
    const paid = t.received ? `${t.received} ${t.coin} received` : null;
    steps.push({
      key: 'in',
      label: `${c.name} payment`,
      status: t.state !== 'swap1' || paidSeen ? 'done' : legStage === 'expired' ? 'pending' : 'active',
      detail: paid ?? (legStage === 'expired' ? 'Address expired without a payment' : 'Waiting for the payment'),
      link: leg1?.depositTxUrl ?? null,
    });
  }

  if (t.privacy || (!monero && !split)) {
    const swapTo = t.privacy ? 'Monero' : symOf(t);
    steps.push({
      key: 'swap1',
      label: `Swap to ${swapTo}`,
      status: t.state === 'swap1' && !route && !paidSeen ? 'pending' : t.state === 'swap1' && legStage === 'attention' ? 'failed' : status('swap1', 'swap1'),
      detail: leg1 ? `FixedFloat order ${leg1.id}${leg1.usdt && t.privacy ? `: ${leg1.usdt} XMR` : ''}` : null,
      link: null,
    });
  }

  if (monero) {
    const v = t.vault;
    if (t.privacy) {
      steps.push({
        key: 'vault',
        label: 'Monero arrives and unlocks',
        status: status('xmr-in', 'xmr-in'),
        detail: v?.amount ? `${v.amount} XMR${t.state === 'xmr-in' ? `, ${Math.min(v.confirmations, xmr.XMR_LOCK_BLOCKS)} of ${xmr.XMR_LOCK_BLOCKS} confirmations` : ''}` : null,
        link: null,
      });
    }
    if (split) {
      steps.push({ key: 'split', label: `Split into ${n} pieces within your wallet`, status: status('churn', 'churn'), detail: t.split?.broadcastAt ? `${t.split.amount} XMR` : null, link: null });
    } else {
      steps.push({ key: 'churn', label: 'Move within your wallet', status: status('churn', 'churn'), detail: t.churn?.broadcastAt ? `${t.churn.amount} XMR` : null, link: null });
    }
    steps.push({
      key: 'wait',
      label: waitLabel,
      status: t.state === 'pieces' ? (goneOut ? 'done' : 'active') : status('wait', 'wait'),
      detail: waitDetail('Starts once the Monero unlocks'),
      link: null,
    });
    if (split) {
      steps.push({ key: 'pieces', label: `Swap ${n} pieces to ${symOf(t)}, at random times`, status: piecesStatus(), detail: kids.length ? `${sent.length} of ${kids.length} sent` : null, link: null });
    } else {
      steps.push({
        key: 'swap2',
        label: `Swap Monero to ${symOf(t)}`,
        status: status('open2', 'swap2'),
        detail: leg2 ? `FixedFloat order ${leg2.id}${t.sweep ? `: ${t.sweep.amount} XMR` : ''}` : null,
        link: null,
      });
    }
  }

  const last = monero ? leg2 : leg1;
  const soFar = sent.reduce((s, k) => s + Number(k.usdt ?? 0), 0);
  steps.push({
    key: 'out',
    label: `${symOf(t)} to ${t.destination.label}`,
    status: t.state === 'done' ? 'done' : split ? (sent.length ? 'active' : 'pending') : last?.stage === 'sending' ? 'active' : 'pending',
    detail: t.usdt ? `${t.usdt} ${symOf(t)}` : split && sent.length ? `${Math.round(soFar * 100) / 100} ${symOf(t)} so far` : null,
    link: t.payoutTx ? txUrl(t, t.payoutTx) : null,
  });
  return steps;
}

/** One piece of a split payment, as its parent's window lists it. */
function pieceView(k: TransferRecord, now: number) {
  const id = k.leg2 ?? k.leg1;
  const rec = id ? orders.get(id) : null;
  const leg = rec ? orderView(rec, now) : null;
  const monero = inMonero(k);
  let stage: 'waiting' | 'sending' | 'done' | 'refunded' | 'attention' = 'waiting';
  if (k.attention) stage = 'attention';
  else if (k.state === 'done') stage = 'done';
  else if (k.state === 'refunded') stage = 'refunded';
  else if (leg) stage = 'sending';
  return {
    id: k.id,
    n: k.piece!.n,
    of: k.piece!.of,
    coin: (monero ? 'XMR' : k.coin) as Coin,
    amount: monero ? (k.vault?.amount ?? null) : k.received,
    stage,
    releaseAt: k.releaseAt,
    usdt: k.usdt,
    payoutTxUrl: k.payoutTx ? txUrl(k, k.payoutTx) : null,
    attention: k.attention,
    waitingFor: k.waitingFor,
  };
}

/** Everything the UI needs about a transfer, and nothing that could move money (no tokens, no signed transactions). */
export function transferView(t: TransferRecord, now = Date.now()) {
  const leg1Rec = t.leg1 ? orders.get(t.leg1) : null;
  const leg2Rec = t.leg2 ? orders.get(t.leg2) : null;
  const leg1 = leg1Rec ? orderView(leg1Rec, now) : null;
  const leg2 = leg2Rec ? orderView(leg2Rec, now) : null;
  const route = addresses.get(t.routeId);
  const kids = childrenOf(t);
  const pieceList = kids.map((k) => pieceView(k, now));
  const stuck = kids.find((k) => k.attention);
  const attention = t.attention ?? (stuck ? `Piece ${stuck.piece!.n} of ${stuck.piece!.of}: ${stuck.attention}` : null);
  const upcoming = pieceList.filter((p) => p.stage === 'waiting' && p.releaseAt !== null).map((p) => p.releaseAt!);

  // One word for the list, like an order's stage.
  let stage: 'waiting' | 'received' | 'swapping' | 'holding' | 'sending' | 'done' | 'refunded' | 'expired' | 'attention' = 'swapping';
  if (attention) stage = 'attention';
  else if (t.state === 'done') stage = 'done';
  else if (t.state === 'refunded') stage = 'refunded';
  else if (t.state === 'collect') stage = 'received';
  else if (t.state === 'swap1' && leg1 && !t.routeId) stage = leg1.stage === 'swapping' || leg1.stage === 'sending' ? 'swapping' : leg1.stage === 'done' ? 'swapping' : leg1.stage;
  else if (t.state === 'pieces') stage = pieceList.some((p) => p.stage === 'sending') ? 'sending' : 'holding';
  else if (['xmr-in', 'churn', 'wait', 'hold', 'split'].includes(t.state)) stage = 'holding';
  else if ((t.state === 'swap2' && leg2?.stage === 'sending') || (t.state === 'swap1' && !t.privacy && leg1?.stage === 'sending')) stage = 'sending';

  return {
    id: t.id,
    createdAt: t.createdAt,
    coin: t.coin,
    coinName: COINS[t.coin].name,
    privacy: t.privacy,
    /** The money waits in Monero (Privacy Enhanced, or a Monero payment with a wait or pieces). */
    monero: inMonero(t),
    delayHours: t.delayHours,
    pieces: kids.length || piecesOf(t),
    routeId: t.routeId,
    routeLabel: route?.oneTime ? null : (route?.label ?? null),
    oneTime: Boolean(route?.oneTime),
    destinationId: t.destinationId,
    destinationLabel: t.destination.label,
    destinationAddress: t.destination.address,
    state: t.state,
    stage,
    received: t.received,
    usdt: t.usdt,
    payoutTxUrl: t.payoutTx ? txUrl(t, t.payoutTx) : null,
    /** What the destination is paid in: FixedFloat's code ('USDT' or 'USDCBASE'). */
    payoutCcy: ccyOf(t),
    releaseAt: t.releaseAt,
    heldAt: t.heldAt ?? null,
    unlockedAt: t.vault?.unlockedAt ?? null,
    /** When the next piece goes (roughly: it also waits for the one before to finish). */
    nextPieceAt: upcoming.length ? Math.min(...upcoming) : null,
    pieceList,
    released: t.log.some((l) => l.text === 'Released early'),
    xmr: t.vault?.amount ?? null,
    /** The XMR has reached our vault subaddress (it then unlocks over 10 blocks). */
    xmrArrived: Boolean(t.vault?.seenAt) || ['churn', 'wait', 'pieces', 'open2', 'send2', 'swap2', 'done'].includes(t.state),
    xmrConfirmations: t.vault?.confirmations ?? 0,
    usdValue: usdValue(t, now),
    cost: transferCost(t),
    steps: stepsOf(t, leg1, leg2, route, kids, now),
    attention,
    error: t.error,
    waitingFor: t.waitingFor,
    canRelease: waitable(t) && (t.delayHours ?? 0) > 0,
    canChangeDelay: waitable(t),
    canRetry: Boolean(attention || (t.error && t.tries >= 3)),
    leg1,
    leg2,
    log: t.log.slice(-30),
    updatedAt: now,
  };
}
export type TransferView = ReturnType<typeof transferView>;
