import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { addresses, type Route } from './addresses.js';
import { DECIMALS, fromBase, toBase } from './chain.js';
import { COINS, PAYOUTS, PRIVACY_DELAYS, config, type Coin } from './config.js';
import { destinations } from './destinations.js';
import { HttpError, UserError, friendlyError } from './errors.js';
import { FfError } from './fixedfloat.js';
import { LimitError, abandon, createOrder, flush as flushOrders, limits, openSwap, orderView, orders, pairBusy, type Expect, type OrderRecord, type OrderView } from './orders.js';
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
 * Every send is signed and saved to disk before it's broadcast, and after a crash the same transaction is
 * broadcast again (never a new one). Money only ever goes to a FixedFloat order the server just created and
 * checked, or to one of our own Monero subaddresses.
 */

export type TransferState = 'collect' | 'open1' | 'send1' | 'swap1' | 'xmr-in' | 'churn' | 'wait' | 'open2' | 'send2' | 'swap2' | 'done' | 'refunded';

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
  destination: { label: string; address: string };
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
  vault?: { index: number; address: string; amount: string | null; confirmations: number; unlockedAt: number | null };
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
  const finished = cache.transfers.filter((t) => t.state === 'done' || t.state === 'refunded');
  if (finished.length > KEEP_FINISHED) {
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED));
    cache.transfers = cache.transfers.filter((t) => !drop.has(t));
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
  /** Unfinished transfers plus the newest ones, newest first. */
  forBrowser(limit = 40): TransferRecord[] {
    const all = load().transfers;
    const live = all.filter((t) => t.state !== 'done' && t.state !== 'refunded');
    return [...new Set([...live, ...all.slice(-limit)])].sort((a, b) => b.createdAt - a.createdAt);
  },
  reset(): void {
    cache = null;
    dirty = false;
    busy = false;
    scanning = false;
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
const delayMs = (t: TransferRecord) => (config.privacyTestDelayMin !== null ? config.privacyTestDelayMin * M : (t.delayHours ?? 0) * H);
const newJitter = () => (config.privacyTestDelayMin !== null ? crypto.randomInt(0, 30 * S) : crypto.randomInt(0, 30 * M));
const refOf = (r: Route): RouteRef => ({ coin: r.coin, index: r.index, address: r.address });
const shortTx = (h: string) => `${h.slice(0, 8)}…`;

function advance(t: TransferRecord, state: TransferState, text: string, now: number): void {
  t.state = state;
  t.tries = 0;
  t.error = null;
  t.waitingFor = null;
  t.nextAt = now;
  t.log.push({ at: now, text });
  markDirty();
}

const later = (t: TransferRecord, now: number, ms: number, waitingFor: string | null = null) => {
  if (t.waitingFor !== waitingFor) markDirty();
  t.waitingFor = waitingFor;
  t.nextAt = now + ms;
};

function needAttention(t: TransferRecord, why: string, now: number): void {
  t.attention = why;
  t.nextAt = Number.MAX_SAFE_INTEGER;
  t.log.push({ at: now, text: `Needs you: ${why}` });
  markDirty();
}

/** Outpoints our own sends from this route spent (or are about to): a scan mustn't count them again. */
function spentBy(routeId: string, now: number): Set<string> {
  const out = new Set<string>();
  for (const t of load().transfers) {
    if (t.routeId === routeId && now - (t.forward?.createdAt ?? t.createdAt) < 30 * D) for (const i of [...(t.forward?.inputs ?? []), ...(t.forwardInputs ?? [])]) out.add(i);
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
  persist();
}

function needOrder(id: string | undefined, t: TransferRecord) {
  const o = id ? orders.get(id) : null;
  if (!o || o.transferId !== t.id) throw new UserError(`FixedFloat order ${id ?? '?'} for this transfer is missing.`);
  return o;
}

function finish(t: TransferRecord, v: OrderView, now: number): void {
  for (const s of [t.forward, t.churn, t.sweep]) if (s) s.raw = []; // long settled: the signed transactions aren't needed any more
  t.usdt = v.usdt;
  t.payoutTx = v.payoutTx;
  t.doneAt = now;
  advance(t, 'done', `${v.usdt ? `${v.usdt} USDT` : 'USDT'} sent to ${t.destination.label}`, now);
  t.nextAt = Number.MAX_SAFE_INTEGER;
}

function usdtExpect(t: TransferRecord): Expect {
  return { toCcy: 'USDT', toAddress: t.destination.address, label: t.destination.label };
}

/** Where Privacy XMR sits while waiting: the churn subaddress once it's been moved, the vault before that. */
const hold = (t: TransferRecord) => (t.churn?.broadcastAt ? { index: t.churn.index, address: t.churn.address } : { index: t.vault!.index, address: t.vault!.address });

// ---------------------------------------------------------------- steps

/** A payment landed at a permanent address: wait until it's confirmed and above FixedFloat's minimum. */
async function collect(t: TransferRecord, now: number): Promise<void> {
  const route = addresses.get(t.routeId)!;
  const w = hotWallet(route.coin);
  if (!w) return later(t, now, 5 * M, `the ${COINS[route.coin].name} hot wallet to be unlocked`);
  const exclude = spentBy(route.id, now);
  const s = await w.scan(refOf(route), exclude);
  const received = fmt(route.coin, s.seen);
  if (received !== t.received || s.confirmations !== t.inbound?.confirmations) markDirty();
  t.received = received;
  t.inbound = { txids: s.txids, confirmations: s.confirmations, required: s.required, spendable: fmt(route.coin, s.spendable) };
  if (s.seen === 0n) {
    // The payment vanished (dropped from the mempool) or was forwarded by an older transfer.
    if (now - t.createdAt > 2 * H) {
      load().transfers.splice(load().transfers.indexOf(t), 1);
      markDirty();
      return;
    }
    return later(t, now, M, 'the payment to show up again');
  }
  if (s.busy) return later(t, now, 30 * S, 'the previous forward from this address to confirm');
  if (s.spendable === 0n) return later(t, now, 30 * S, `confirmations (${s.confirmations} of ${s.required})`);

  const to = t.privacy ? 'XMR' : 'USDT';
  const lim = await limits(route.coin, to, { now, cached: true });
  const q = await w.quote(refOf(route), exclude);
  if (!q) return later(t, now, 30 * S, `confirmations (${s.confirmations} of ${s.required})`);
  const amount = Number(fmt(route.coin, q.amount));
  if (amount < lim.min * 1.01) {
    const usd = (v: number) => (lim.usdPerCoin ? ` (≈ $${(v * lim.usdPerCoin).toFixed(2)})` : '');
    return later(t, now, 2 * M, `more to arrive: FixedFloat's minimum is ${lim.min} ${route.coin}${usd(lim.min)}, ${amount} ${route.coin} so far${usd(amount)}`);
  }
  if (amount > lim.max) return needAttention(t, `${amount} ${route.coin} is above FixedFloat's maximum of ${lim.max} ${route.coin}.`, now);
  const blocker = pairBusy(route.coin, to, now);
  if (blocker) return later(t, now, M, `FixedFloat order ${blocker.id} (${route.coin} → ${to}) to finish first (FixedFloat's rules)`);
  advance(t, 'open1', `${fmt(route.coin, s.spendable)} ${route.coin} confirmed at "${route.label}"`, now);
}

/** Creates the FixedFloat order our wallet will pay, for exactly what it can send. */
async function open1(t: TransferRecord, now: number): Promise<void> {
  if (t.leg1) return advance(t, 'send1', 'FixedFloat order ready', now);
  const route = addresses.get(t.routeId)!;
  const w = hotWallet(route.coin);
  if (!w) return later(t, now, 5 * M, `the ${COINS[route.coin].name} hot wallet to be unlocked`);
  const to = t.privacy ? 'XMR' : 'USDT';
  const blocker = pairBusy(route.coin, to, now);
  if (blocker) return later(t, now, M, `FixedFloat order ${blocker.id} (${route.coin} → ${to}) to finish first (FixedFloat's rules)`);
  const exclude = spentBy(route.id, now);
  const q = await w.quote(refOf(route), exclude);
  if (!q) return advance(t, 'collect', 'Nothing to forward yet', now);
  const lim = await limits(route.coin, to, { now });
  const amount = floorDec(fmt(route.coin, q.amount), lim.precision);

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
  advance(t, 'send1', `FixedFloat order ${o.id}: ${amount} ${route.coin} → ${to === 'XMR' ? 'Monero' : `USDT for ${t.destination.label}`}`, now);
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
    const p = await w.prepare(refOf(route), o.depositAddress, BigInt(t.forwardAmount!), { inputs: t.forwardInputs, exclude: spentBy(route.id, now) });
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
  if (v.amount !== xmr.formatXmr(b.total) || v.confirmations !== confirmations) markDirty();
  v.amount = xmr.formatXmr(b.total);
  v.confirmations = confirmations;
  if (b.unlocked > 0n && b.unlocked >= b.total) {
    v.unlockedAt = now;
    t.releaseAt = now + delayMs(t) + t.jitterMs;
    return advance(t, 'churn', `${v.amount} XMR unlocked in the vault`, now);
  }
  later(t, now, 30 * S, `the Monero to unlock (${Math.min(confirmations, xmr.XMR_LOCK_BLOCKS)} of ${xmr.XMR_LOCK_BLOCKS} confirmations)`);
}

/** Moves the XMR once to a fresh subaddress of ours, so FixedFloat's own outputs never go straight back to it. */
async function churn(t: TransferRecord, now: number): Promise<void> {
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

/** Waits until the release time, and until the moved XMR has unlocked again. */
async function wait(t: TransferRecord, now: number): Promise<void> {
  if (t.releaseAt !== null && now < t.releaseAt) return later(t, now, Math.min(t.releaseAt - now, 5 * M), null);
  const h = hold(t);
  const b = await xmr.balance(h.index);
  if (b.unlocked > 0n && b.unlocked >= b.total) return advance(t, 'open2', 'Wait over', now);
  if (b.total === 0n) return later(t, now, M, 'the Monero to show up in the wallet');
  later(t, now, M, `the Monero to unlock (${b.blocksToUnlock} blocks left)`);
}

/** The FixedFloat order XMR → USDT, for exactly what the wallet can send. */
async function open2(t: TransferRecord, now: number): Promise<void> {
  if (t.leg2) return advance(t, 'send2', 'FixedFloat order ready', now);
  const blocker = pairBusy('XMR', 'USDT', now);
  if (blocker) return later(t, now, M, `FixedFloat order ${blocker.id} (XMR → USDT) to finish first (FixedFloat's rules)`);
  const h = hold(t);
  const b = await xmr.balance(h.index);
  if (b.unlocked === 0n || b.unlocked < b.total) return later(t, now, M, 'the Monero to unlock');
  // A sweep to ourselves, never relayed, tells the exact fee.
  const dry = await xmr.prepareSweep(h.index, h.address);
  const lim = await limits('XMR', 'USDT', { now });
  const amount = floorDec(xmr.formatXmr(dry.amount), lim.precision);
  const o = await openSwap({ from: 'XMR', amount: Number(amount), expect: usdtExpect(t), transferId: t.id, ownRefund: h.address, destinationId: t.destinationId }, now);
  t.leg2 = o.id;
  persist();
  advance(t, 'send2', `FixedFloat order ${o.id}: ${amount} XMR → USDT for ${t.destination.label}`, now);
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
    t.log.push({ at: now, text: `FixedFloat sent the XMR back (order ${o.id})` });
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
  open1,
  send1,
  swap1,
  'xmr-in': xmrIn,
  churn,
  wait,
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
  const inUse = new Set<number>();
  for (const t of all) {
    if (t.state === 'done' || t.state === 'refunded') continue;
    if (t.vault && !t.churn?.broadcastAt) inUse.add(t.vault.index);
    if (t.churn) inUse.add(t.churn.index);
  }
  for (const t of [...all]) {
    if (!t.privacy || now - t.createdAt > 30 * D) continue;
    const retired: { index: number; address: string }[] = [];
    if (t.vault && t.churn?.broadcastAt) retired.push(t.vault);
    if (t.churn && (t.state === 'done' || t.state === 'refunded')) retired.push(t.churn);
    for (const sub of retired) {
      if (inUse.has(sub.index)) continue;
      const b = await xmr.balance(sub.index).catch(() => null);
      if (!b || b.total < LEFTOVER) continue;
      const n = blank(t.coin, true, t.delayHours || PRIVACY_DELAYS[0], t.destinationId, t.destination, t.routeId, 'xmr-in', now);
      n.vault = { index: sub.index, address: sub.address, amount: xmr.formatXmr(b.total), confirmations: 0, unlockedAt: null };
      n.received = null;
      n.log.push({ at: now, text: `${xmr.formatXmr(b.total)} XMR found left behind by transfer ${t.id}` });
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

/** Looks at every permanent address that has no transfer collecting for it yet, and starts one when money lands. */
export async function scanRoutes(now = Date.now()): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    for (const route of addresses.list()) {
      if ((scanAt.get(route.id) ?? 0) > now) continue;
      scanAt.set(route.id, now + ROUTE_SCAN[route.coin]);
      // One payment at a time per address: the collecting transfer takes in everything that arrives meanwhile.
      if (load().transfers.some((t) => t.routeId === route.id && (t.state === 'collect' || t.state === 'open1' || t.state === 'send1'))) continue;
      const w = hotWallet(route.coin);
      if (!w) continue;
      try {
        const s = await w.scan(refOf(route), spentBy(route.id, now));
        if (s.busy || s.seen < DUST[route.coin]) continue;
        const t = blank(route.coin, route.mode === 'privacy', route.delayHours, route.destinationId, route.destination, route.id, 'collect', now);
        t.received = fmt(route.coin, s.seen);
        t.inbound = { txids: s.txids, confirmations: s.confirmations, required: s.required, spendable: fmt(route.coin, s.spendable) };
        t.log.push({ at: now, text: `Payment seen at "${route.label}": ${t.received} ${route.coin}` });
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
  destination: { label: string; address: string },
  routeId: string | null,
  state: TransferState,
  now: number,
): TransferRecord {
  return {
    id: `t_${crypto.randomBytes(6).toString('hex')}`,
    createdAt: now,
    coin,
    privacy,
    delayHours: privacy ? delayHours : null,
    jitterMs: privacy ? newJitter() : 0,
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
  if (!PRIVACY_DELAYS.includes(h as (typeof PRIVACY_DELAYS)[number])) throw new UserError(`Pick a delay of ${PRIVACY_DELAYS.join(', ')} hours.`);
};

/** Privacy Enhanced with a fresh address: BTC/ETH → XMR (our vault) → wait → USDT. */
export async function createPrivacyTransfer(coin: Coin, delayHours: number, destinationId?: string, now = Date.now()): Promise<TransferRecord> {
  if (coin === 'XMR') throw new UserError('Pick Bitcoin or Ethereum: Monero is already private.');
  if (!xmr.xmrConfigured()) throw new UserError('Privacy Enhanced needs the VPS Monero wallet (MONERO_RPC_URL).');
  checkDelay(delayHours);
  const dest = destinations.need(destinationId);
  const t = blank(coin, true, delayHours, dest.id, { label: dest.label, address: dest.address }, null, 'swap1', now);
  const v = await xmr.newSubaddress(`wallet-click ${t.id} vault`);
  t.vault = { index: v.index, address: v.address, amount: null, confirmations: 0, unlockedAt: null };
  const o = await createOrder(coin, { now, expect: { toCcy: 'XMR', toAddress: v.address, label: 'Monero vault' }, transferId: t.id });
  t.leg1 = o.id;
  t.log.push({ at: now, text: `Privacy Enhanced: FixedFloat order ${o.id} pays ${COINS[coin].name} → Monero, then USDT to ${dest.label} after ${delayHours} h` });
  load().transfers.push(t);
  persist();
  return t;
}

function need(id: string): TransferRecord {
  const t = transfers.get(id);
  if (!t) throw new HttpError(404, 'Transfer not found');
  return t;
}

/** Skips the rest of the Privacy Enhanced wait. */
export function releaseNow(id: string, now = Date.now()): TransferRecord {
  const t = need(id);
  if (!t.privacy || !['swap1', 'collect', 'open1', 'send1', 'xmr-in', 'churn', 'wait'].includes(t.state)) throw new UserError('There is no wait to skip.');
  t.delayHours = 0;
  if (t.releaseAt !== null) t.releaseAt = Math.min(t.releaseAt, now);
  t.jitterMs = 0;
  t.log.push({ at: now, text: 'Released early' });
  t.nextAt = now;
  persist();
  return t;
}

/** Changes the Privacy Enhanced wait (counted from when the Monero unlocked). */
export function changeDelay(id: string, delayHours: number, now = Date.now()): TransferRecord {
  const t = need(id);
  checkDelay(delayHours);
  if (!t.privacy || !['swap1', 'collect', 'open1', 'send1', 'xmr-in', 'churn', 'wait'].includes(t.state)) throw new UserError('This transfer is past its wait.');
  t.delayHours = delayHours;
  if (t.vault?.unlockedAt) t.releaseAt = t.vault.unlockedAt + delayMs(t) + t.jitterMs;
  t.log.push({ at: now, text: `Delay changed to ${delayHours} h` });
  t.nextAt = now;
  persist();
  return t;
}

/** Tries a stuck step again. */
export function retry(id: string, now = Date.now()): TransferRecord {
  const t = need(id);
  if (!t.attention && !t.error) throw new UserError('Nothing to retry.');
  t.attention = null;
  t.error = null;
  t.tries = 0;
  t.nextAt = now;
  t.log.push({ at: now, text: 'Retrying' });
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

export function startTransfers(log: FastifyBaseLogger): () => void {
  const timer = setInterval(() => {
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

const ORDER: TransferState[] = ['collect', 'open1', 'send1', 'swap1', 'xmr-in', 'churn', 'wait', 'open2', 'send2', 'swap2', 'done'];

/** The list of steps the transfer window shows, worked out from the state. */
function stepsOf(t: TransferRecord, leg1: OrderView | null, leg2: OrderView | null, route: Route | null, now: number): StepView[] {
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

  if (route) {
    steps.push({
      key: 'in',
      label: `Payment at "${route.label}"`,
      status: status('collect', 'collect'),
      detail: t.received ? `${t.received} ${t.coin}${t.state === 'collect' && t.inbound ? `, ${Math.min(t.inbound.confirmations, t.inbound.required)} of ${t.inbound.required} confirmations` : ''}` : null,
      link: t.inbound?.txids[0] && t.coin !== 'XMR' ? c.explorerTx(t.inbound.txids[0]) : null,
    });
    steps.push({
      key: 'forward',
      label: 'Forward to FixedFloat',
      status: status('open1', 'send1'),
      detail: t.forward ? `${t.forward.amount} ${t.coin} (network fee ${t.forward.fee})` : null,
      link: t.forward?.txids[0] ? c.explorerTx(t.forward.txids[0]) : null,
    });
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

  const swapTo = t.privacy ? 'Monero' : 'USDT';
  steps.push({
    key: 'swap1',
    label: `Swap to ${swapTo}`,
    status: t.state === 'swap1' && !route && !paidSeen ? 'pending' : t.state === 'swap1' && legStage === 'attention' ? 'failed' : status('swap1', 'swap1'),
    detail: leg1 ? `FixedFloat order ${leg1.id}${leg1.usdt && t.privacy ? `: ${leg1.usdt} XMR` : ''}` : null,
    link: null,
  });

  if (t.privacy) {
    const v = t.vault;
    steps.push({
      key: 'vault',
      label: 'Monero arrives and unlocks',
      status: status('xmr-in', 'xmr-in'),
      detail: v?.amount ? `${v.amount} XMR${t.state === 'xmr-in' ? `, ${Math.min(v.confirmations, xmr.XMR_LOCK_BLOCKS)} of ${xmr.XMR_LOCK_BLOCKS} confirmations` : ''}` : null,
      link: null,
    });
    steps.push({ key: 'churn', label: 'Move within your wallet', status: status('churn', 'churn'), detail: t.churn?.broadcastAt ? `${t.churn.amount} XMR` : null, link: null });
    const hours = t.delayHours ?? 0;
    const left = t.releaseAt !== null ? t.releaseAt - now : null;
    steps.push({
      key: 'wait',
      label: hours ? `Wait ${hours} hours` : 'Wait (released early)',
      status: status('wait', 'wait'),
      // The browser shows the release time in its own time zone.
      detail: t.releaseAt === null ? 'Starts once the Monero unlocks' : left !== null && left > 0 ? null : 'Over',
      link: null,
    });
    steps.push({
      key: 'swap2',
      label: 'Swap Monero to USDT',
      status: status('open2', 'swap2'),
      detail: leg2 ? `FixedFloat order ${leg2.id}${t.sweep ? `: ${t.sweep.amount} XMR` : ''}` : null,
      link: null,
    });
  }

  const last = t.privacy ? leg2 : leg1;
  steps.push({
    key: 'out',
    label: `USDT to ${t.destination.label}`,
    status: t.state === 'done' ? 'done' : last?.stage === 'sending' ? 'active' : 'pending',
    detail: t.usdt ? `${t.usdt} USDT` : null,
    link: t.payoutTx ? PAYOUTS.USDT.explorerTx(t.payoutTx) : null,
  });
  return steps;
}

/** Everything the UI needs about a transfer, and nothing that could move money (no tokens, no signed transactions). */
export function transferView(t: TransferRecord, now = Date.now()) {
  const leg1Rec = t.leg1 ? orders.get(t.leg1) : null;
  const leg2Rec = t.leg2 ? orders.get(t.leg2) : null;
  const leg1 = leg1Rec ? orderView(leg1Rec, now) : null;
  const leg2 = leg2Rec ? orderView(leg2Rec, now) : null;
  const route = addresses.get(t.routeId);

  // One word for the list, like an order's stage.
  let stage: 'waiting' | 'received' | 'swapping' | 'holding' | 'sending' | 'done' | 'refunded' | 'expired' | 'attention' = 'swapping';
  if (t.attention) stage = 'attention';
  else if (t.state === 'done') stage = 'done';
  else if (t.state === 'refunded') stage = 'refunded';
  else if (t.state === 'collect') stage = 'received';
  else if (t.state === 'swap1' && leg1 && !t.routeId) stage = leg1.stage === 'swapping' || leg1.stage === 'sending' ? 'swapping' : leg1.stage === 'done' ? 'swapping' : leg1.stage;
  else if (t.state === 'xmr-in' || t.state === 'churn' || t.state === 'wait') stage = 'holding';
  else if ((t.state === 'swap2' && leg2?.stage === 'sending') || (t.state === 'swap1' && !t.privacy && leg1?.stage === 'sending')) stage = 'sending';

  return {
    id: t.id,
    createdAt: t.createdAt,
    coin: t.coin,
    coinName: COINS[t.coin].name,
    privacy: t.privacy,
    delayHours: t.delayHours,
    routeId: t.routeId,
    routeLabel: route?.label ?? null,
    destinationId: t.destinationId,
    destinationLabel: t.destination.label,
    destinationAddress: t.destination.address,
    state: t.state,
    stage,
    received: t.received,
    usdt: t.usdt,
    payoutTxUrl: t.payoutTx ? PAYOUTS.USDT.explorerTx(t.payoutTx) : null,
    releaseAt: t.releaseAt,
    unlockedAt: t.vault?.unlockedAt ?? null,
    xmr: t.vault?.amount ?? null,
    steps: stepsOf(t, leg1, leg2, route, now),
    attention: t.attention,
    error: t.error,
    waitingFor: t.waitingFor,
    canRelease: t.privacy && ['swap1', 'collect', 'open1', 'send1', 'xmr-in', 'churn', 'wait'].includes(t.state) && (t.delayHours ?? 0) > 0,
    canChangeDelay: t.privacy && ['swap1', 'collect', 'open1', 'send1', 'xmr-in', 'churn', 'wait'].includes(t.state),
    canRetry: Boolean(t.attention || (t.error && t.tries >= 3)),
    leg1,
    leg2,
    log: t.log.slice(-30),
    updatedAt: now,
  };
}
export type TransferView = ReturnType<typeof transferView>;
