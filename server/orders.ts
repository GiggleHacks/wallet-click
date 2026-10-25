import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { ChainUnavailable, depositTotal, findSender, formatBase } from './chain.js';
import { COINS, PAYOUTS, config, isChecksumAddress, isStable, type Coin, type PayoutCcy } from './config.js';
import { destinations } from './destinations.js';
import { HttpError, UserError, friendlyError } from './errors.js';
import { FfError, budgetLeft, ff, type FfOrder } from './fixedfloat.js';
import { logger } from './logs.js';
import { noteOrderMoney } from './notify.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * One FixedFloat float order per click (or per step of a transfer). FixedFloat hands out a fresh deposit
 * address per order, swaps whatever arrives and pays it out to an address only the server sets: USDT to a
 * saved destination (Coinbase by default), or XMR to one of our own Monero subaddresses.
 */

export type Stage = 'waiting' | 'received' | 'swapping' | 'sending' | 'done' | 'refunded' | 'expired' | 'attention';

/** Our answer to a FixedFloat EMERGENCY ("continue at market rate" or "refund"), for one deposit. */
export interface Answer {
  /** The deposit transaction this answer is about; a new deposit gets a fresh answer. */
  forTx: string | null;
  tries: number;
  nextAt: number;
  sentAt: number | null;
  error: string | null;
}

export interface RefundAnswer extends Answer {
  /** Where the refund goes. */
  to: string | null;
  /** 'sender' = worked out automatically, 'manual' = typed by the owner, 'own' = back to our own wallet. */
  source: 'sender' | 'manual' | 'own' | null;
  /** Automatic refund isn't possible for this payment: the owner has to give an address. */
  gaveUp: boolean;
  /** Automatic refund keeps failing for now: show the owner the form too (retries continue). */
  handOff?: boolean;
}

export interface OrderRecord {
  id: string;
  /** FixedFloat access token. It can request refunds to any address, so it never leaves the server. */
  token: string;
  coin: Coin;
  depositAddress: string;
  createdAt: number;
  min: string;
  max?: string;
  minUsd: number | null;
  /** True if FixedFloat ever handed out this deposit address before (it shouldn't). */
  reusedAddress: boolean;
  /** Latest FixedFloat snapshot, without the token. */
  ff: FfOrder;
  polledAt: number;
  nextPollAt: number;
  pollError: string | null;
  /** Automatic "continue the exchange" answers (late or odd-sized payments). */
  auto: Answer;
  /** Refunds of payments FixedFloat can't swap. */
  autoRefund?: RefundAnswer;
  /** The payment as we spotted it on-chain ourselves, before FixedFloat reports it. */
  seen?: { at: number; amount: string };
  /** What the address had already received when we started watching (base units), so only new money counts. */
  chainBase?: string;
  /** When to look at the deposit address on-chain again (runtime only). */
  chainNextAt?: number;
  /** What FixedFloat must pay out ('USDT' on Ethereum, 'USDCBASE' or 'XMR'), where to, and the name shown for it. Checked at creation. */
  toCcy: PayoutCcy;
  toAddress: string;
  toLabel: string;
  destinationId?: string;
  /** Set when this order is one step of a transfer (Privacy Enhanced or a permanent address). */
  transferId?: string;
  /** Our own wallet pays this order: a refund goes straight back to this address of ours. */
  ownRefund?: string;
  /** Our wallet never paid this order and never will (it went stale first, or a crash orphaned it). */
  abandoned?: boolean;
  /** Dollar prices of the coin in and the coin out when FixedFloat started the exchange: what the swap cost is worked out from. */
  prices?: { from: number; to: number; at: number };
}

interface OrdersFile {
  version: 1;
  orders: OrderRecord[];
}

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const STOPPED = Number.MAX_SAFE_INTEGER;
/** How long an address is watched for late payments. */
export const WATCH_DAYS = 30;
/** Finished orders beyond this many are pruned (oldest first); unfinished ones never are. */
const KEEP_FINISHED = 300;

const ordersFile = () => path.join(config.dataDir, 'orders.json');
let cache: OrdersFile | null = null;
let dirty = false;

function load(): OrdersFile {
  if (!cache) {
    cache = readJson<OrdersFile>(ordersFile()) ?? { version: 1, orders: [] };
    const now = Date.now();
    for (const r of cache.orders) {
      r.auto = { ...r.auto, forTx: r.auto?.forTx ?? null }; // older records predate forTx
      // Older records predate destinations: they all paid USDT to Coinbase.
      r.toCcy ??= 'USDT';
      r.toAddress ??= r.ff.to?.address ?? config.payout.address;
      r.toLabel ??= config.payout.label;
      // Poll times are runtime state: after a restart, look at everything again soon (spread out),
      // including orders an older version had stopped watching too early.
      if (r.nextPollAt !== STOPPED || nextPollDelay(r, now) !== null) r.nextPollAt = Math.min(r.nextPollAt, now + Math.random() * 20 * S);
    }
  }
  return cache;
}

const markDirty = () => (dirty = true);

function isFinished(r: OrderRecord, now: number): boolean {
  const s = r.ff.status;
  if (s === 'DONE') return true;
  if ((s === 'NEW' || s === 'EXPIRED') && !r.seen && now - r.createdAt > WATCH_DAYS * D) return true;
  return now - r.createdAt > 3 * WATCH_DAYS * D;
}

/** Writes orders.json if anything changed. Unfinished orders (and their tokens) are never pruned. */
export function flush(): void {
  if (!dirty || !cache) return;
  const now = Date.now();
  const finished = cache.orders.filter((r) => isFinished(r, now));
  if (finished.length > KEEP_FINISHED) {
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED));
    cache.orders = cache.orders.filter((r) => !drop.has(r));
  }
  writeJsonAtomic(ordersFile(), cache, false);
  dirty = false;
}

export const orders = {
  all: (): OrderRecord[] => load().orders,
  get: (id: string): OrderRecord | null => load().orders.find((o) => o.id === id) ?? null,
  /** Every unfinished order plus the newest ones, newest first: what the browser gets. Steps of a transfer are shown with the transfer. */
  forBrowser(limit = 40): OrderRecord[] {
    const all = load().orders.filter((r) => !r.transferId);
    const now = Date.now();
    const recent = all.slice(-limit);
    const live = all.filter((r) => (!isFinished(r, now) && r.ff.status !== 'NEW' && r.ff.status !== 'EXPIRED') || seenCounts(r, now));
    return [...new Set([...live, ...recent])].sort((a, b) => b.createdAt - a.createdAt);
  },
  /** Drops the in-memory cache and the create throttle (tests). */
  reset(): void {
    cache = null;
    dirty = false;
    recentCreates.length = 0;
    inFlight.clear();
    limitCache.clear();
    priceTriedAt.clear();
  },
};

// ---------------------------------------------------------------- status logic

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

/**
 * What to do about an EMERGENCY:
 *  - continue: late or odd-sized payments, swap at market rate;
 *  - refund:   below FixedFloat's minimum, so it can't be swapped: send it back to the payer;
 *  - attention: anything else, including payments above the maximum (large: a human decides).
 */
export function emergencyAction(o: FfOrder): 'continue' | 'refund' | 'attention' | null {
  if (o.status !== 'EMERGENCY') return null;
  const em = o.emergency;
  if (em?.choice && em.choice !== 'NONE') return null; // already answered
  const flags = em?.status ?? [];
  if (flags.includes('LIMIT')) return flags.includes('LESS') && !flags.includes('MORE') ? 'refund' : 'attention';
  if (flags.some((f) => f === 'EXPIRED' || f === 'LESS' || f === 'MORE') || truthy(em?.repeat)) return 'continue';
  return 'attention';
}

export function stageOf(o: FfOrder): Stage {
  switch (o.status) {
    case 'NEW':
      return 'waiting';
    case 'PENDING':
      return 'received';
    case 'EXCHANGE':
      return 'swapping';
    case 'WITHDRAW':
      return 'sending';
    case 'DONE':
      return o.back?.tx?.id && !o.to.tx?.id ? 'refunded' : 'done';
    case 'EXPIRED':
      return 'expired';
    case 'EMERGENCY':
      if (o.emergency?.choice === 'EXCHANGE') return 'swapping';
      if (o.emergency?.choice === 'REFUND') return 'refunded';
      return emergencyAction(o) === 'continue' ? 'received' : 'attention';
    default:
      return 'attention';
  }
}

const depositTx = (r: OrderRecord) => r.ff.from.tx?.id ?? null;
const SEEN_TRUST = 60 * M;

/** Our own on-chain sighting counts until FixedFloat catches up, or for an hour (a dropped transaction shouldn't ring forever). */
const seenCounts = (r: OrderRecord, now: number) => Boolean(r.seen) && now - r.seen!.at < SEEN_TRUST;

/** How soon to ask FixedFloat again, or null to stop watching. */
export function nextPollDelay(r: OrderRecord, now: number): number | null {
  const age = now - r.createdAt;
  const status = r.ff.status;
  if (status === 'EMERGENCY') {
    if (age > 3 * WATCH_DAYS * D) return null;
    if (age > WATCH_DAYS * D) return 30 * M;
    const action = emergencyAction(r.ff);
    return action === 'continue' || (action === 'refund' && !r.autoRefund?.gaveUp) ? 8 * S : M;
  }
  if (status === 'PENDING' || status === 'EXCHANGE' || status === 'WITHDRAW') return 8 * S;
  if (age > WATCH_DAYS * D) return null;
  // We just saw money arrive on-chain: keep asking FixedFloat until it notices.
  if ((status === 'NEW' || status === 'EXPIRED') && seenCounts(r, now)) return 5 * S;
  // Reused addresses aren't watched on-chain, so ask FixedFloat more often.
  if ((status === 'NEW' || status === 'EXPIRED') && r.reusedAddress && age >= 2 * H) return 2 * M;
  if (status === 'NEW') return age < 2 * H ? 12 * S : 30 * M;
  if (status === 'DONE') return 30 * M; // a second payment to the same address reopens the order
  return 30 * M; // EXPIRED: the on-chain watch spots late payments and triggers an immediate check
}

function stripToken(o: FfOrder): FfOrder {
  const { token: _token, ...rest } = o;
  return rest;
}

// ---------------------------------------------------------------- answering emergencies

/** Orders with a FixedFloat emergency answer in flight: one answer at a time per order. */
const inFlight = new Set<string>();
const backoff = (tries: number) => Math.min(30 * S * 2 ** Math.max(0, tries - 1), 10 * M);
const freshAnswer = (forTx: string | null): Answer => ({ forTx, tries: 0, nextAt: 0, sentAt: null, error: null });

function withChoice(r: OrderRecord, choice: 'EXCHANGE' | 'REFUND'): FfOrder {
  return { ...r.ff, emergency: { status: r.ff.emergency?.status ?? [], repeat: r.ff.emergency?.repeat ?? null, choice } };
}

async function maybeContinue(r: OrderRecord, now: number): Promise<void> {
  if (emergencyAction(r.ff) !== 'continue' || inFlight.has(r.id)) return;
  const tx = depositTx(r);
  if (r.auto.forTx !== tx) r.auto = freshAnswer(tx); // a new deposit: start over
  if (r.auto.sentAt && now - r.auto.sentAt < 2 * M) return; // give FixedFloat time to apply the last answer
  if (now < r.auto.nextAt) return;
  inFlight.add(r.id);
  r.auto.tries++;
  markDirty();
  try {
    await ff.emergency(r.id, r.token, 'EXCHANGE');
    r.auto = { forTx: tx, tries: 0, nextAt: 0, sentAt: Date.now(), error: null };
    r.ff = withChoice(r, 'EXCHANGE');
    logger.info(`[order ${r.id}] FixedFloat flagged the payment (${(r.ff.emergency?.status ?? []).join(', ') || 'emergency'}): told it to continue the swap`);
  } catch (e) {
    // Keep trying (with backoff) for as long as the emergency lasts: a swap shouldn't stall for good.
    r.auto.error = friendlyError(e);
    r.auto.nextAt = Date.now() + backoff(r.auto.tries);
    logger.warn(`[order ${r.id}] couldn't tell FixedFloat to continue (try ${r.auto.tries}): ${r.auto.error}`);
  } finally {
    inFlight.delete(r.id);
  }
}

export const ADDRESS_FORMATS: Record<Coin, (a: string) => boolean> = {
  BTC: (a) => /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a),
  ETH: (a) => /^0x[0-9a-fA-F]{40}$/.test(a) && (a === a.toLowerCase() || a.slice(2) === a.slice(2).toUpperCase() || isChecksumAddress(a)),
  // Standard (4…) and subaddresses (8…) are 95 characters, integrated addresses (4…) 106.
  XMR: (a) => /^[48][1-9A-HJ-NP-Za-km-z]{94}$|^4[1-9A-HJ-NP-Za-km-z]{105}$/.test(a),
};

const UNSAFE_SENDER =
  "It didn't come straight from one ordinary wallet (an exchange, a smart wallet or several senders), so it can't safely go back automatically. Enter an address below.";

/** Sends a below-minimum payment back to the wallet it came from, when that can be known safely. */
async function maybeRefund(r: OrderRecord, now: number): Promise<void> {
  if (emergencyAction(r.ff) !== 'refund' || inFlight.has(r.id)) return;
  const tx = depositTx(r);
  const amount = r.ff.from.tx?.amount;
  if (!r.autoRefund || r.autoRefund.forTx !== tx) r.autoRefund = { ...freshAnswer(tx), to: null, source: null, gaveUp: false };
  const a = r.autoRefund;
  if (a.gaveUp || (a.sentAt && now - a.sentAt < 2 * M) || now < a.nextAt) return;
  if (!tx || amount === null || amount === undefined) {
    Object.assign(a, { gaveUp: true, error: "FixedFloat didn't say which transaction paid, so it can't go back automatically. Enter an address below." });
    logger.warn(`[order ${r.id}] below the minimum, needs a refund address: ${a.error}`);
    markDirty();
    return;
  }
  if (!a.to && r.ownRefund) Object.assign(a, { to: r.ownRefund, source: 'own' }); // our own wallet paid: it goes back there
  if (!a.to && r.coin === 'XMR') {
    Object.assign(a, { gaveUp: true, error: "Monero doesn't show who paid, so it can't go back automatically. Enter a Monero address below." });
    logger.warn(`[order ${r.id}] below the minimum, needs a refund address: ${a.error}`);
    markDirty();
    return;
  }
  inFlight.add(r.id);
  a.tries++;
  markDirty();
  try {
    if (!a.to) {
      const sender = await findSender(r.coin, tx, r.depositAddress, String(amount));
      if (!sender || !ADDRESS_FORMATS[r.coin](sender)) {
        Object.assign(a, { gaveUp: true, error: UNSAFE_SENDER });
        logger.warn(`[order ${r.id}] below the minimum, and the sender isn't one plain wallet: needs a refund address`);
        return;
      }
      Object.assign(a, { to: sender, source: 'sender' });
    }
    // Re-check: the owner may have answered by hand while we were looking the sender up.
    if (emergencyAction(r.ff) !== 'refund' || r.autoRefund !== a) return;
    await ff.emergency(r.id, r.token, 'REFUND', a.to!);
    Object.assign(a, { tries: 0, nextAt: 0, sentAt: Date.now(), error: null });
    r.ff = withChoice(r, 'REFUND');
    logger.info(`[order ${r.id}] below the minimum: refund of ${amount} ${r.coin} requested to ${a.to} (${a.source})`);
  } catch (e) {
    if (e instanceof FfError && e.code > 0) {
      // FixedFloat itself said no (e.g. it rejects the address): retrying won't change that.
      Object.assign(a, { gaveUp: true, error: `FixedFloat refused the automatic refund (${e.message.replace(/^FixedFloat: /, '')}). Enter an address below.` });
      logger.warn(`[order ${r.id}] ${a.error}`);
      return;
    }
    // Temporary trouble (FixedFloat or a public endpoint): retry with backoff. After a few tries,
    // also show the owner the manual form, so they aren't stuck waiting.
    const why = e instanceof ChainUnavailable ? `couldn't check who paid (${e.message})` : friendlyError(e);
    a.error = a.tries >= 3 ? `Automatic refund hasn't worked yet: ${why}. It keeps trying, or enter an address below.` : `Retrying the automatic refund: ${why}`;
    a.handOff = a.tries >= 3;
    a.nextAt = Date.now() + backoff(a.tries);
    logger.warn(`[order ${r.id}] automatic refund failed (try ${a.tries}): ${why}`);
  } finally {
    inFlight.delete(r.id);
  }
}

/** The owner's own refund address (password-checked by the route). */
export async function refundOrder(r: OrderRecord, address: string): Promise<void> {
  if (r.ff.status !== 'EMERGENCY' || (r.ff.emergency?.choice && r.ff.emergency.choice !== 'NONE')) throw new UserError("This transfer doesn't need a refund.");
  if (inFlight.has(r.id) || (r.autoRefund?.sentAt && Date.now() - r.autoRefund.sentAt < 2 * M)) throw new UserError('A refund is already being sent. Give it a moment.');
  if (!ADDRESS_FORMATS[r.coin](address)) throw new UserError(`That doesn't look like a ${COINS[r.coin].name} address.`);
  inFlight.add(r.id);
  try {
    await ff.emergency(r.id, r.token, 'REFUND', address);
  } finally {
    inFlight.delete(r.id);
  }
  r.autoRefund = { forTx: depositTx(r), tries: 0, nextAt: 0, sentAt: Date.now(), error: null, to: address, source: 'manual', gaveUp: true };
  logger.info(`[order ${r.id}] refund requested to ${address} (entered by hand)`);
  r.ff = withChoice(r, 'REFUND');
  r.nextPollAt = Date.now() + 5 * S;
  markDirty();
  flush();
}

// ---------------------------------------------------------------- polling

export async function pollOrder(r: OrderRecord, now = Date.now()): Promise<void> {
  const before = JSON.stringify([r.ff, r.pollError]);
  const [wasStatus, wasError] = [r.ff.status, r.pollError];
  const had = { from: Boolean(r.ff.from.tx?.id), to: Boolean(r.ff.to.tx?.id), refund: Boolean(r.ff.back?.tx?.id) };
  try {
    r.ff = stripToken(await ff.order(r.id, r.token));
    r.pollError = null;
  } catch (e) {
    r.pollError = friendlyError(e);
  }
  if (JSON.stringify([r.ff, r.pollError]) !== before) markDirty();
  if (r.ff.status !== wasStatus) {
    const got = r.ff.from.tx?.amount ? `, received ${r.ff.from.tx.amount} ${r.coin}` : '';
    const sent = r.ff.to.tx?.amount ? `, paid out ${r.ff.to.tx.amount} ${r.toCcy}` : '';
    logger.info(`[order ${r.id}] FixedFloat: ${wasStatus} → ${r.ff.status}${got}${sent}`);
  }
  if (r.pollError && r.pollError !== wasError) logger.warn(`[order ${r.id}] couldn't check with FixedFloat: ${r.pollError}`);
  if (!r.pollError) noteMoney(r, now, { hadFrom: had.from, hadTo: had.to, hadRefund: had.refund });
  r.polledAt = now;
  await maybeContinue(r, now);
  await maybeRefund(r, now);
  await notePrices(r, now);
  const delay = nextPollDelay(r, now);
  r.nextPollAt = delay === null ? STOPPED : now + delay;
}

/** A Telegram ping for money that just came in or went out on this order (only the changes since the last look). */
function noteMoney(r: OrderRecord, now: number, p: { seenNew?: boolean; hadFrom: boolean; hadTo: boolean; hadRefund: boolean }): void {
  const o = r.ff;
  noteOrderMoney({
    id: r.id,
    coin: r.coin,
    depositAddress: r.depositAddress,
    ownRefund: r.ownRefund,
    toCcy: r.toCcy,
    toAddress: r.toAddress,
    toLabel: r.toLabel,
    seen: r.seen,
    seenNew: p.seenNew,
    fromTxId: o.from.tx?.id ?? null,
    fromAmount: o.from.tx?.amount ? String(o.from.tx.amount) : null,
    toTxId: o.to.tx?.id ?? null,
    toAmount: o.to.tx?.amount ? String(o.to.tx.amount) : null,
    hadFrom: p.hadFrom,
    hadTo: p.hadTo,
    hadRefund: p.hadRefund,
    refundTxId: o.back?.tx?.id ?? null,
    refundAmount: o.back?.tx?.amount ? String(o.back.tx.amount) : null,
    refundTo: o.back?.address ? String(o.back.address) : null,
    at: now,
  });
}

const CHAIN_FRESH = 4 * S;
const CHAIN_LATE = 5 * M;
let watching = false;

/**
 * Looks at deposit addresses on-chain so a payment rings the moment it's broadcast: every few seconds
 * for new addresses, every few minutes for older ones (late payments). Only money that arrives after
 * we start watching counts, and reused addresses are left to FixedFloat.
 */
export async function watchChain(now = Date.now()): Promise<void> {
  if (watching) return;
  watching = true;
  try {
    const due = load()
      .orders.filter((r) => {
        if (r.coin === 'XMR' || r.seen || r.reusedAddress || (r.chainNextAt ?? 0) > now) return false;
        if (r.ff.status === 'NEW') return now - r.createdAt < WATCH_DAYS * D;
        return r.ff.status === 'EXPIRED' && now - r.createdAt < WATCH_DAYS * D;
      })
      .sort((a, b) => b.createdAt - a.createdAt) // the address you just made is the one about to be paid
      .slice(0, 6);
    await Promise.all(
      due.map(async (r) => {
        const fresh = r.ff.status === 'NEW' && now - r.createdAt < 2 * H;
        r.chainNextAt = now + (fresh ? CHAIN_FRESH : CHAIN_LATE);
        try {
          const total = await depositTotal(r.coin, r.depositAddress);
          if (r.chainBase === undefined) {
            r.chainBase = total.toString(); // whatever was there before doesn't count
            markDirty();
            return;
          }
          const base = BigInt(r.chainBase);
          if (total < base) {
            r.chainBase = total.toString(); // money left the address (FixedFloat swept it): new baseline
            markDirty();
            return;
          }
          const added = total - base;
          if (added <= 0n) return;
          r.seen = { at: now, amount: formatBase(r.coin, added) };
          logger.info(`[order ${r.id}] payment spotted on-chain: ${r.seen.amount} ${r.coin}`);
          noteMoney(r, now, { seenNew: true, hadFrom: true, hadTo: true, hadRefund: true });
          r.nextPollAt = now; // and ask FixedFloat straight away
          markDirty();
        } catch {
          r.chainNextAt = now + 3 * (fresh ? CHAIN_FRESH : CHAIN_LATE); // endpoint hiccup: FixedFloat polling still covers it
        }
      }),
    );
  } finally {
    watching = false;
    flush();
  }
}

let busy = false;
/** One pass over the orders that are due. Keeps enough API budget free for a new address. */
export async function pollDue(now = Date.now()): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const due = load()
      .orders.filter((o) => o.nextPollAt <= now)
      .sort((a, b) => a.nextPollAt - b.nextPollAt)
      .slice(0, 8);
    for (const r of due) {
      if (budgetLeft() < 60) break;
      await pollOrder(r);
    }
  } finally {
    busy = false;
    flush();
  }
}

export function startPoller(log: FastifyBaseLogger): () => void {
  const timer = setInterval(() => {
    watchChain().catch((e) => log.warn({ err: e }, 'chain watch failed'));
    pollDue().catch((e) => log.warn({ err: e }, 'order poll failed'));
  }, 2 * S);
  timer.unref();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------- what a swap cost

const EXCHANGED = new Set(['EXCHANGE', 'WITHDRAW', 'DONE']);
const priceTriedAt = new Map<string, number>();

/** A float order's rate is set when FixedFloat starts the exchange: note both coins' dollar prices then (USDT and USDC = $1). */
async function notePrices(r: OrderRecord, now: number): Promise<void> {
  if (r.prices || !EXCHANGED.has(r.ff.status) || now - (priceTriedAt.get(r.id) ?? 0) < M) return;
  priceTriedAt.set(r.id, now);
  const usd = async (c: Coin | PayoutCcy) => (isStable(c) ? 1 : (usdPrice(c, now, 5 * M) ?? (await limits(c, 'USDT', { now, cached: true })).usdPerCoin));
  try {
    const [from, to] = [await usd(r.coin), await usd(r.toCcy)];
    if (!from || !to) return;
    r.prices = { from, to, at: now };
    markDirty();
  } catch {
    // No price just now: try again in a minute (the cost only shows once there is one).
  }
}

const cents = (v: number) => Math.round(v * 100) / 100;

/** What a swap cost (FixedFloat's cut plus network fees), in dollars and as a share of what went in. */
export function costOf(inUsd: number, usd: number): { usd: number; pct: number; inUsd: number } | null {
  if (!(inUsd > 0) || !Number.isFinite(usd)) return null;
  return { usd: cents(usd), pct: Math.round((usd / inUsd) * 1000) / 10, inUsd: cents(inUsd) };
}

// ---------------------------------------------------------------- creating

const PRICE_ERRORS: Record<string, (from: string, to: string) => string> = {
  MAINTENANCE_FROM: (c) => `FixedFloat has ${c} deposits paused for maintenance. Try again later.`,
  OFFLINE_FROM: (c) => `FixedFloat isn't accepting ${c} right now. Try again later.`,
  RESERVE_FROM: (c) => `FixedFloat can't take ${c} right now (reserves). Try again later.`,
  MAINTENANCE_TO: (_, t) => `FixedFloat has ${t} payouts paused for maintenance. Try again later.`,
  OFFLINE_TO: (_, t) => `FixedFloat isn't paying out ${t} right now. Try again later.`,
  RESERVE_TO: (_, t) => `FixedFloat is short on ${t} right now. Try again later.`,
};

/** What an order must pay out, and where. */
export interface Expect {
  toCcy: PayoutCcy;
  toAddress: string;
  /** How the owner knows this address ("Coinbase", "Monero vault"). */
  label: string;
}

const COINBASE_EXPECT = (): Expect => ({ toCcy: config.payoutBase.ccy, toAddress: config.payoutBase.address, label: config.payoutBase.label });

/** Refuses any order that doesn't pay exactly what we asked for: the right coin in, the right payout, to exactly our address. */
export function checkCreated(o: FfOrder, coin: Coin, expect: Expect = COINBASE_EXPECT()): void {
  const problems: string[] = [];
  const want = PAYOUTS[expect.toCcy];
  if (!o.token) problems.push('it came without an access token');
  if (!o.from?.address) problems.push('it has no deposit address');
  if (o.from?.code !== COINS[coin].code) problems.push(`it expects ${o.from?.code} instead of ${COINS[coin].code}`);
  // FixedFloat codes name the network too ("USDT" is ERC-20; Tron is "USDTTRC"; "USDCBASE" is Base), so the code is the main check.
  if (o.to?.code !== expect.toCcy || (isStable(expect.toCcy) && o.to?.network && o.to.network !== want.network)) {
    problems.push(`it pays out ${o.to?.code} on ${o.to?.network} instead of ${want.label}`);
  }
  const paidTo = String(o.to?.address ?? '');
  const same = isStable(expect.toCcy) ? paidTo.toLowerCase() === expect.toAddress.toLowerCase() : paidTo === expect.toAddress;
  if (!same) problems.push(`its payout address is not your ${expect.label} address`);
  if (o.type !== 'float') problems.push('it is not a float-rate order');
  if (problems.length) throw new Error(`Refusing FixedFloat order ${o.id ?? ''}: ${problems.join('; ')}.`);
}

const recentCreates: number[] = [];
export const CREATES_PER_MINUTE = 3;

const ceilTo = (x: number, decimals: number) => Math.ceil(x * 10 ** decimals - 1e-9) / 10 ** decimals;

export interface Limits {
  min: number;
  max: number;
  /** USD value of one coin. */
  usdPerCoin: number | null;
  /** Roughly how much comes out per coin in (FixedFloat's fee included). */
  outPerCoin: number | null;
  precision: number;
}

const limitCache = new Map<string, { at: number; limits: Limits }>();
const LIMITS_FRESH = 2 * M;
const PRICE_FRESH = 30 * M;

/** A coin's US dollar price from FixedFloat's latest quote for it (any pair, up to half an hour old), or null. */
export function usdPrice(coin: Coin, now = Date.now(), maxAge = PRICE_FRESH): number | null {
  let best: { at: number; usd: number } | null = null;
  for (const [key, v] of limitCache) {
    if (!key.startsWith(`${coin}>`) || !v.limits.usdPerCoin || now - v.at > maxAge) continue;
    if (!best || v.at > best.at) best = { at: v.at, usd: v.limits.usdPerCoin };
  }
  return best?.usd ?? null;
}

/**
 * FixedFloat's current limits and rate for a pair. Throws a UserError if the pair is paused. `cached` allows an
 * answer up to two minutes old (estimates, waiting for a minimum); anything that creates an order asks afresh.
 */
export async function limits(from: Coin, to: PayoutCcy, opts: { now?: number; cached?: boolean } = {}): Promise<Limits> {
  const now = opts.now ?? Date.now();
  const key = `${from}>${to}`;
  const hit = limitCache.get(key);
  if (opts.cached && hit && now - hit.at < LIMITS_FRESH) return hit.limits;
  // LIMIT_* errors only describe the probe amount, so they don't matter here.
  const price = await ff.price(COINS[from].code, to, COINS[from].probeAmount);
  const blocking = (price.errors ?? []).filter((e) => !e.startsWith('LIMIT_'));
  if (blocking.length) {
    throw new UserError(PRICE_ERRORS[blocking[0]]?.(COINS[from].name, PAYOUTS[to].label) ?? `FixedFloat can't do this swap right now (${blocking.join(', ')}).`);
  }
  const min = Number(price.from.min);
  const max = Number(price.from.max);
  if (!(min > 0) || !(max > min)) throw new UserError('FixedFloat did not return usable limits. Try again shortly.');
  const per = (v: unknown) => {
    const n = Number(v) / Number(price.from.amount);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const result: Limits = { min, max, usdPerCoin: per(price.from.usd), outPerCoin: per(price.to.amount), precision: Math.min(price.from.precision ?? 8, 8) };
  limitCache.set(key, { at: now, limits: result });
  return result;
}

function newRecord(created: FfOrder, coin: Coin, expect: Expect, lim: Limits, now: number, extra: Partial<OrderRecord>): OrderRecord {
  const depositAddress = created.from.address;
  return {
    id: created.id,
    token: created.token!,
    coin,
    depositAddress,
    createdAt: now,
    min: String(lim.min),
    max: String(lim.max),
    minUsd: lim.usdPerCoin ? Math.round(lim.min * lim.usdPerCoin * 100) / 100 : null,
    reusedAddress: load().orders.some((o) => o.depositAddress.toLowerCase() === depositAddress.toLowerCase()),
    ff: stripToken(created),
    polledAt: now,
    nextPollAt: now + 10 * S,
    pollError: null,
    auto: freshAnswer(null),
    toCcy: expect.toCcy,
    toAddress: expect.toAddress,
    toLabel: expect.label,
    ...extra,
  };
}

/**
 * A fresh address for someone to pay (the coin buttons, and the first swap of a new-address Privacy transfer).
 * Float orders swap whatever actually arrives; the order amount is only nominal. Odd amounts and late
 * payments come back as EMERGENCY, which the poller answers with "continue".
 */
export async function createOrder(
  coin: Coin,
  opts: { now?: number; destinationId?: string; expect?: Expect; transferId?: string } = {},
): Promise<OrderRecord> {
  const now = opts.now ?? Date.now();
  while (recentCreates.length && now - recentCreates[0] > M) recentCreates.shift();
  if (recentCreates.length >= CREATES_PER_MINUTE) throw new HttpError(429, 'Easy there: three new addresses a minute at most. Try again in a few seconds.');

  const dest = opts.expect ? null : destinations.need(opts.destinationId);
  const expect: Expect = opts.expect ?? { toCcy: dest!.ccy, toAddress: dest!.address, label: dest!.label };
  const lim = await limits(coin, expect.toCcy, { now });
  const nominal = ceilTo(Math.min(lim.min * 3, lim.max), lim.precision);
  recentCreates.push(now);
  const created = await ff.create(COINS[coin].code, expect.toCcy, nominal, expect.toAddress);
  checkCreated(created, coin, expect);

  const record = newRecord(created, coin, expect, lim, now, {
    ...(dest ? { destinationId: dest.id } : {}),
    ...(opts.transferId ? { transferId: opts.transferId } : {}),
  });
  logger.info(`[order ${record.id}] new ${coin} address ${record.depositAddress}: pays ${expect.toCcy} to ${expect.label}${opts.transferId ? ` (transfer ${opts.transferId})` : ''}, minimum ${lim.min} ${coin}`);
  load().orders.push(record);
  markDirty();
  flush();
  return record;
}

/** The amount is outside FixedFloat's limits for this pair right now. */
export class LimitError extends UserError {
  constructor(
    message: string,
    public min: number,
    public max: number,
  ) {
    super(message);
  }
}

/**
 * An order our own wallet pays straight away, for exactly `amount` (one step of a transfer). The caller sends
 * the coins to the returned order's deposit address, and only there. Refunds come back to `ownRefund`.
 */
export async function openSwap(
  req: { from: Coin; amount: number; expect: Expect; transferId: string; ownRefund: string; destinationId?: string },
  now = Date.now(),
): Promise<OrderRecord> {
  const lim = await limits(req.from, req.expect.toCcy, { now });
  if (req.amount < lim.min) throw new LimitError(`Below FixedFloat's minimum of ${lim.min} ${req.from}.`, lim.min, lim.max);
  if (req.amount > lim.max) throw new LimitError(`Above FixedFloat's maximum of ${lim.max} ${req.from}.`, lim.min, lim.max);
  // An earlier, never-paid order of this transfer (a crash between creating it and saving the transfer) must not block the pair.
  for (const r of load().orders) if (r.transferId === req.transferId && r.ownRefund && r.ff.status === 'NEW' && !r.abandoned) abandon(r);
  const created = await ff.create(COINS[req.from].code, req.expect.toCcy, req.amount, req.expect.toAddress);
  checkCreated(created, req.from, req.expect);
  // Our wallet only ever pays an address FixedFloat hasn't used before: paying an old one could reopen someone else's order.
  if (load().orders.some((o) => o.depositAddress.toLowerCase() === created.from.address.toLowerCase())) {
    throw new Error(`FixedFloat order ${created.id} reuses an old deposit address; making another one.`);
  }
  const record = newRecord(created, req.from, req.expect, lim, now, {
    transferId: req.transferId,
    ownRefund: req.ownRefund,
    ...(req.destinationId ? { destinationId: req.destinationId } : {}),
  });
  logger.info(`[order ${record.id}] ${req.amount} ${req.from} → ${req.expect.toCcy} for ${req.expect.label} (transfer ${req.transferId}): our wallet pays ${record.depositAddress}`);
  load().orders.push(record);
  markDirty();
  flush();
  return record;
}

/**
 * FixedFloat's rules (ToS 2.20): no new order may be paid in the same direction until the previous one is
 * complete. Returns the order still in the way, if any. Orders stuck for days don't block forever.
 */
export function pairBusy(from: Coin, to: PayoutCcy, now = Date.now()): OrderRecord | null {
  return (
    load().orders.find((r) => {
      if (r.coin !== from || r.toCcy !== to || r.abandoned || now - r.createdAt > 3 * D) return false;
      const s = r.ff.status;
      if (s === 'PENDING' || s === 'EXCHANGE' || s === 'WITHDRAW') return true;
      if (s === 'EMERGENCY') return r.ff.emergency?.choice !== 'REFUND';
      // Paid, but FixedFloat hasn't seen it yet: by our own wallet, or spotted on-chain.
      if (s === 'NEW' || s === 'EXPIRED') return (r.ownRefund !== undefined && now - r.createdAt < 24 * H) || seenCounts(r, now);
      return false;
    }) ?? null
  );
}

/** Marks an order our wallet will never pay (so it doesn't hold up the pair). */
export function abandon(r: OrderRecord): void {
  r.abandoned = true;
  logger.info(`[order ${r.id}] dropped: our wallet won't pay it`);
  markDirty();
  flush();
}

/** Saves on shutdown. */
export function stopOrders(): void {
  flush();
}

// ---------------------------------------------------------------- what the browser sees

const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));

/** Everything the UI needs, and nothing that could move money (no token). */
export function orderView(r: OrderRecord, now = Date.now()) {
  const o = r.ff;
  const c = COINS[r.coin];
  const fromTx = o.from.tx ?? null;
  const toTx = o.to.tx ?? null;
  const counted = seenCounts(r, now);
  const received = str(fromTx?.amount) ?? (counted ? r.seen!.amount : null);
  const orderAmount = Number(o.from.amount);

  // Until the payout exists, FixedFloat's USDT figure is an estimate for the order amount.
  // Only show it once the deposit matches that amount (after a "continue", FixedFloat rewrites it).
  let usdt: string | null = null;
  if (toTx?.id && str(toTx.amount)) usdt = str(toTx.amount);
  else if (received && Math.abs(Number(received) - orderAmount) <= orderAmount * 0.005) usdt = str(o.to.amount);

  const tx = fromTx?.id ?? null;
  const recent = (a?: Answer) => Boolean(a?.sentAt && a.forTx === tx && now - a.sentAt < 10 * M);
  let stage = stageOf(o);
  // FixedFloat can take a moment to reflect an answer we just gave.
  if (stage === 'received' && o.status === 'EMERGENCY' && recent(r.auto)) stage = 'swapping';
  if (stage === 'attention' && o.status === 'EMERGENCY' && recent(r.autoRefund)) stage = 'refunded';
  if ((stage === 'waiting' || stage === 'expired') && counted) stage = 'received'; // spotted on-chain, FixedFloat not caught up yet

  const refund = r.autoRefund;
  return {
    id: r.id,
    coin: r.coin,
    coinName: c.name,
    network: c.network,
    address: r.depositAddress,
    createdAt: r.createdAt,
    stage,
    status: o.status,
    min: r.min,
    max: r.max ?? null,
    minUsd: r.minUsd,
    watchDays: WATCH_DAYS,
    expiresAt: o.time?.expiration ? o.time.expiration * 1000 : null,
    received,
    seenAt: counted ? r.seen!.at : null,
    confirmations: Number(fromTx?.confirmations ?? 0) || 0,
    requiredConfirmations: o.from.reqConfirmations ?? null,
    blockMinutes: c.blockMinutes,
    depositTx: tx,
    depositTxUrl: tx ? c.explorerTx(tx) : null,
    usdt,
    usdtFinal: Boolean(toTx?.id),
    payoutTx: toTx?.id ?? null,
    payoutTxUrl: toTx?.id ? PAYOUTS[r.toCcy].explorerTx(toTx.id) : null,
    payoutAddress: r.toAddress,
    /** What comes out ('USDT' or 'XMR') and the name of where it goes ("Coinbase"). */
    toCcy: r.toCcy,
    payoutLabel: r.toLabel,
    destinationId: r.destinationId ?? null,
    transferId: r.transferId ?? null,
    refundTx: o.back?.tx?.id ?? null,
    refundTxUrl: o.back?.tx?.id ? c.explorerTx(o.back.tx.id) : null,
    refundTo: str(o.back?.address) ?? refund?.to ?? null,
    refundSource: refund?.source ?? null,
    /** Set when the owner should give a refund address (automatic refund impossible, or failing for now). */
    autoRefundError: refund && !refund.sentAt && (refund.gaveUp || refund.handOff) ? refund.error : null,
    /** A temporary problem while sending a refund back; it keeps retrying. */
    refundRetry: refund && !refund.gaveUp && !refund.handOff && !refund.sentAt ? refund.error : null,
    emergency: o.status === 'EMERGENCY' ? { flags: o.emergency?.status ?? [], choice: o.emergency?.choice ?? 'NONE' } : null,
    autoContinued: recent(r.auto),
    autoError: emergencyAction(o) === 'continue' ? r.auto.error : null,
    reusedAddress: r.reusedAddress,
    pollError: r.pollError,
    /** Once it's done: roughly what the swap cost (dollar value in, at the exchange, minus what came out). */
    cost: o.status === 'DONE' && toTx?.id && received && usdt && r.prices ? costOf(Number(received) * r.prices.from, Number(received) * r.prices.from - Number(usdt) * r.prices.to) : null,
    updatedAt: r.polledAt,
  };
}
export type OrderView = ReturnType<typeof orderView>;
