import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { fromBase } from '../chain.js';
import { config, type Coin } from '../config.js';
import { destinations } from '../destinations.js';
import { HttpError, UserError, friendlyError } from '../errors.js';
import { budgetLeft, ff, type FfOrder } from '../fixedfloat.js';
import { logger } from '../logs.js';
import { notify } from '../notify.js';
import { emergencyAction, orders as mainOrders, pairBusy, registerPairCheck, stageOf } from '../orders.js';
import { walletState } from '../wallets/seed.js';
import { xmrConfigured } from '../wallets/xmr.js';
import { ASSETS, ASSET_IDS, counterOf, payUri, type Asset, type AssetId } from './assets.js';
import { chainOf, type Quote, type Ref } from './chains.js';
import { flush, load, markDirty, save, type Entry, type Move, type MoveTo, type StashOrder, type Who } from './store.js';
import { cachedPair, checkStashOrder, ffCurrencies, pairInfo, quotePair } from './swap.js';

/**
 * The Wallet window's engine. Hands out fresh addresses (never the same one twice), watches them, pings when money
 * is broadcast and again once it's confirmed, and holds it there until you move it:
 *  - Swap to Monero: a FixedFloat order pays a fresh subaddress of the Wallet's own Monero account (held again);
 *  - Send to Coinbase: a FixedFloat order pays USDC on Base to an address book destination.
 * A move signs, saves, then broadcasts one transaction that empties the address into the order's deposit address,
 * like the transfers do. "Long tail" coins (anything else FixedFloat takes) get a FixedFloat address instead, which
 * swaps into the Wallet's Monero.
 */

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

const now = () => Date.now();
const newId = (p: string) => `${p}${crypto.randomBytes(5).toString('hex')}`;
const big = (v: string | undefined | null) => BigInt(v || '0');

export function assetReady(a: Asset): boolean {
  return a.kind === 'xmr' ? xmrConfigured() : walletState().ready;
}

const refOf = (e: Entry): Ref => ({ asset: ASSETS[e.asset], index: e.index, address: e.address });
const activeMove = (e: Entry): Move | null => e.moves.find((m) => m.step !== 'done' && m.step !== 'failed') ?? null;
const orderOf = (id: string | undefined) => (id ? (load().orders.find((o) => o.id === id) ?? null) : null);

/** Pings, unless they're turned off for the Wallet. */
function ping(n: Parameters<typeof notify>[0]): void {
  if (load().settings.pings) notify(n);
}

const nameOf = (e: Entry) => {
  const a = ASSETS[e.asset];
  if (e.via) return `${e.via.code} → XMR`;
  return a.kind === 'evm' && a.network !== a.name ? `${a.symbol} (${a.network})` : a.symbol;
};

// ---------------------------------------------------------------- new addresses

const recent: number[] = [];
const recentVia: number[] = [];
const MAX_WAITING = 300;

function throttle(list: number[], perMinute: number, t: number): void {
  while (list.length && t - list[0] > M) list.shift();
  if (list.length >= perMinute) throw new HttpError(429, `Easy there: ${perMinute} new addresses a minute at most. Try again in a few seconds.`);
  list.push(t);
}

function cleanLabel(label: string | undefined): string {
  return (label ?? '').replace(/[\u0000-\u001f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

async function newEntry(asset: Asset, label: string, by: Who, t: number, from?: Entry['from']): Promise<Entry> {
  const data = load();
  const chain = chainOf(asset);
  let index: number;
  let address: string;
  if (asset.kind === 'xmr') {
    ({ index, address } = await chain.address(0)); // the Monero wallet hands out a new subaddress each time
  } else {
    const counter = counterOf(asset);
    for (;;) {
      index = data.next[counter] ?? 0;
      data.next[counter] = index + 1;
      save(); // the index is used up before the address exists: a crash can skip one, never repeat one
      ({ address } = await chain.address(index));
      const taken = address.toLowerCase();
      if (!data.entries.some((e) => e.address.toLowerCase() === taken)) break;
    }
  }
  if (data.entries.some((e) => e.address === address)) throw new Error('The Monero wallet returned a subaddress already in use.');
  const e: Entry = {
    id: newId('w_'),
    asset: asset.id,
    index,
    address,
    label,
    createdAt: t,
    by,
    ...(from ? { from } : {}),
    seen: '0',
    spendable: '0',
    txids: [],
    confirmed: true,
    firstSeenAt: null,
    heldAt: null,
    scannedAt: null,
    scanError: null,
    moves: [],
  };
  data.entries.push(e);
  save();
  nextScan.set(e.id, t + 5 * S);
  return e;
}

/** A fresh address of the Wallet's own for `assetId`, never handed out before. */
export async function createAddress(assetId: AssetId, opts: { label?: string; by: Who }, t = now()): Promise<Entry> {
  const asset = ASSETS[assetId];
  if (!assetReady(asset)) throw new UserError(asset.kind === 'xmr' ? 'The Monero wallet is not set up (MONERO_RPC_URL).' : 'The hot wallet is locked or not set up (WALLET_KEY).');
  const waiting = load().entries.filter((e) => !e.archived && big(e.seen) === 0n && !e.moves.length && t - e.createdAt < 90 * D).length;
  if (waiting >= MAX_WAITING) throw new UserError(`${MAX_WAITING} addresses are still waiting for money: archive some first.`);
  throttle(recent, 10, t);
  const e = await newEntry(asset, cleanLabel(opts.label), opts.by, t);
  logger.info(`[wallet ${e.id}] new ${nameOf(e)} address${e.label ? ` for "${e.label}"` : ''} (${opts.by})`);
  return e;
}

/** The coins FixedFloat takes that the Wallet doesn't hold itself: paid to FixedFloat, swapped into our Monero. */
export async function longTail(): Promise<{ code: string; name: string; network: string; coin: string; tag: boolean }[]> {
  const held = new Set(ASSET_IDS.map((id) => ASSETS[id].ffCode));
  return (await ffCurrencies())
    .filter((c) => c.recv && !held.has(c.code))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
    .map((c) => ({ code: c.code, name: c.name, network: c.network, coin: c.coin, tag: Boolean(c.tag) }));
}

/** A FixedFloat address for a long-tail coin, swapping whatever arrives into a fresh Monero subaddress of the Wallet. */
export async function createVia(code: string, opts: { label?: string; by: Who }, t = now()): Promise<Entry> {
  if (!xmrConfigured()) throw new UserError('Other coins land in Monero, and the Monero wallet is not set up (MONERO_RPC_URL).');
  const held = ASSET_IDS.find((id) => ASSETS[id].ffCode === code);
  if (held) throw new UserError(`${ASSETS[held].name} has a wallet of its own here: pick it from the list.`);
  const ccy = (await ffCurrencies()).find((c) => c.code === code);
  if (!ccy || !ccy.recv) throw new UserError(`FixedFloat doesn't take ${code} right now.`);
  throttle(recentVia, 3, t);
  const p = await quotePair(code, 'XMR', 1);
  if (p.blocking.length) throw new UserError(`FixedFloat can't swap ${ccy.name} into Monero right now (${p.blocking.join(', ')}). Try again later.`);
  if (!(p.min > 0) || !(p.max > p.min)) throw new UserError('FixedFloat did not return usable limits. Try again shortly.');
  const label = cleanLabel(opts.label);
  const e = await newEntry(ASSETS.XMR, label, opts.by, t, { kind: 'via', ccy: code });
  try {
    const nominal = Math.ceil(Math.min(p.min * 3, p.max) * 10 ** p.precision) / 10 ** p.precision;
    const o = await ff.create(code, 'XMR', nominal, e.address);
    checkStashOrder(o, code, 'XMR', e.address);
    if (usedDeposit(o.from.address)) throw new Error(`FixedFloat order ${o.id} reuses an old deposit address.`);
    const order = recordOrder(o, { kind: 'via', entryId: e.id, fromCode: code, toCcy: 'XMR', toAddress: e.address }, t);
    e.from = { kind: 'via', orderId: order.id, ccy: code };
    e.via = {
      code,
      name: ccy.name,
      network: ccy.network,
      depositAddress: o.from.address,
      tag: o.from.tag ? String(o.from.tag) : null,
      orderId: o.id,
      expiresAt: o.time?.expiration ? o.time.expiration * 1000 : null,
      min: String(p.min),
      max: String(p.max),
    };
    save();
    logger.info(`[wallet ${e.id}] ${code} address ${o.from.address} via FixedFloat order ${o.id}, landing in Monero${label ? ` for "${label}"` : ''} (${opts.by})`);
    return e;
  } catch (err) {
    e.archived = true; // the subaddress is spent either way: it's never handed out
    save();
    throw err;
  }
}

function usedDeposit(address: string): boolean {
  const a = address.toLowerCase();
  return load().orders.some((o) => o.depositAddress.toLowerCase() === a) || mainOrders.all().some((o) => o.depositAddress.toLowerCase() === a);
}

const stripToken = (o: FfOrder): FfOrder => {
  const { token: _t, ...rest } = o;
  return rest;
};

function recordOrder(o: FfOrder, p: Pick<StashOrder, 'kind' | 'entryId' | 'fromCode' | 'toCcy' | 'toAddress'> & { moveId?: string; ownRefund?: string }, t: number): StashOrder {
  const r: StashOrder = { id: o.id, token: o.token ?? '', ...p, depositAddress: o.from.address, createdAt: t, ff: stripToken(o), nextPollAt: t + 10 * S, pollError: null };
  load().orders.push(r);
  save();
  return r;
}

export function updateEntry(id: string, patch: { label?: string; archived?: boolean }): Entry {
  const e = load().entries.find((x) => x.id === id);
  if (!e) throw new HttpError(404, 'No such address.');
  if (patch.label !== undefined) e.label = cleanLabel(patch.label);
  if (patch.archived !== undefined) e.archived = patch.archived;
  save();
  return e;
}

// ---------------------------------------------------------------- moving it out

const coreCoin = (a: Asset): Coin | null => (a.id === 'BTC' ? 'BTC' : a.id === 'ETH' ? 'ETH' : a.id === 'XMR' ? 'XMR' : null);
const LIVE = new Set(['PENDING', 'EXCHANGE', 'WITHDRAW']);

/** A Wallet order on this pair that hasn't finished (FixedFloat: one order per direction at a time). */
function stashBusy(fromCode: string, to: string, t: number, except?: string): { id: string } | null {
  return (
    load().orders.find((o) => {
      if (o.id === except || o.fromCode !== fromCode || o.toCcy !== to || t - o.createdAt > 3 * D) return false;
      const s = o.ff.status;
      if (LIVE.has(s)) return true;
      if (s === 'EMERGENCY') return o.ff.emergency?.choice !== 'REFUND';
      if (s === 'NEW' || s === 'EXPIRED') {
        if (o.kind === 'via') return false; // a payer may never pay it
        const m = load().entries.find((e) => e.id === o.entryId)?.moves.find((x) => x.id === o.moveId);
        return Boolean(m && m.orderId === o.id && m.step !== 'failed' && m.step !== 'done' && t - o.createdAt < 24 * H);
      }
      return false;
    }) ?? null
  );
}
registerPairCheck((fromCode, to, t) => stashBusy(fromCode, to, t));

/** Starts moving everything confirmed at an address: to Monero, or to Coinbase (USDC on Base). */
export async function startMove(id: string, to: MoveTo, opts: { destinationId?: string; by: Who }, t = now()): Promise<Entry> {
  const e = load().entries.find((x) => x.id === id);
  if (!e) throw new HttpError(404, 'No such address.');
  const a = ASSETS[e.asset];
  if (!assetReady(a)) throw new UserError(`The ${a.name} wallet isn't available on this server right now.`);
  if (activeMove(e)) throw new UserError('This one is already moving.');
  if (to === 'xmr' && a.kind === 'xmr') throw new UserError("It's Monero already.");
  if (to === 'xmr' && !xmrConfigured()) throw new UserError('The Monero wallet is not set up (MONERO_RPC_URL).');
  if (!config.ff.apiKey) throw new UserError('FixedFloat is not set up (FF_API_KEY).');
  const spendable = big(e.spendable);
  if (spendable <= 0n) throw new UserError(big(e.seen) > 0n ? 'Still confirming: it can move once the payment is confirmed.' : 'Nothing has arrived here yet.');
  const toCcy = to === 'xmr' ? 'XMR' : 'USDCBASE';
  const dest = to === 'coinbase' ? destinations.need(opts.destinationId ?? load().settings.destinationId) : null;
  if (dest && dest.ccy !== 'USDCBASE') throw new UserError(`${dest.label} doesn't take USDC on Base.`);
  // A quick check against FixedFloat's minimum (when it answers): better to say so now than fail later.
  try {
    const p = await pairInfo(a.ffCode, toCcy, a.probe, 2 * M, t);
    const have = Number(fromBase(spendable, a.decimals));
    if (p.min > 0 && have < p.min) {
      const usd = p.usdPerCoin ? ` (about $${Math.ceil(p.min * p.usdPerCoin)})` : '';
      throw new UserError(`FixedFloat's minimum for ${to === 'xmr' ? 'Monero' : 'USDC'} is ${p.min} ${a.symbol}${usd}; this holds ${fromBase(spendable, a.decimals)}.`);
    }
  } catch (err) {
    if (err instanceof UserError) throw err;
    // FixedFloat unreachable: the move itself checks again.
  }
  const m: Move = {
    id: newId('m_'),
    to,
    by: opts.by,
    createdAt: t,
    toCcy,
    ...(dest ? { destinationId: dest.id, toAddress: dest.address, toLabel: dest.label } : { toLabel: 'Wallet (Monero)' }),
    step: 'quote',
    error: null,
    tries: 0,
    nextAt: 0,
  };
  e.moves.push(m);
  save();
  nextScan.set(e.id, t + 20 * S);
  logger.info(`[wallet ${e.id}] move ${m.id}: ${nameOf(e)} → ${to === 'xmr' ? 'Monero' : dest!.label} (${opts.by})`);
  if (opts.by === 'openclaw') {
    ping({ kind: 'sent', key: `stash:agent:${m.id}`, amount: fromBase(spendable, a.decimals), asset: nameOf(e), label: e.label || null, detail: `🤖 OpenClaw started: ${to === 'xmr' ? 'Swap to Monero' : `Send to ${dest!.label}`}`, at: t });
  }
  return e;
}

/** Starts a move for every address holding something confirmed (they then go one at a time per pair). */
export async function moveAll(to: MoveTo, opts: { destinationId?: string; by: Who }): Promise<{ started: string[]; skipped: { id: string; why: string }[] }> {
  const started: string[] = [];
  const skipped: { id: string; why: string }[] = [];
  for (const e of load().entries) {
    if (e.archived || big(e.spendable) <= 0n || activeMove(e) || (to === 'xmr' && e.asset === 'XMR')) continue;
    try {
      await startMove(e.id, to, opts);
      started.push(e.id);
    } catch (err) {
      skipped.push({ id: e.id, why: friendlyError(err) });
    }
  }
  return { started, skipped };
}

const backoff = (tries: number) => Math.min(30 * S * 2 ** Math.max(0, tries - 1), 15 * M);

function wait(m: Move, t: number, ms: number, why: string | null): void {
  m.nextAt = t + ms;
  if (m.error !== why) {
    m.error = why;
    markDirty();
  }
}

function fail(e: Entry, m: Move, why: string): void {
  m.step = 'failed';
  m.error = why;
  markDirty();
  logger.warn(`[wallet ${e.id}] move ${m.id} stopped: ${why}`);
}

const toQuote = (q: Move['quote']): Quote => ({ amount: big(q!.amount), fee: big(q!.fee), inputs: q!.inputs, gas: q!.gas, maxFee: q!.maxFee });
const fromQuote = (q: Quote): Move['quote'] => ({ amount: q.amount.toString(), fee: q.fee.toString(), ...(q.inputs ? { inputs: q.inputs } : {}), ...(q.gas ? { gas: q.gas, maxFee: q.maxFee } : {}) });

/** One step of a move. Each step saves before the next can start, so a crash never repeats a send. */
export async function stepMove(e: Entry, m: Move, t = now()): Promise<void> {
  if (t < m.nextAt) return;
  const a = ASSETS[e.asset];
  const chain = chainOf(a);
  const ref = refOf(e);
  try {
    switch (m.step) {
      case 'quote': {
        const core = coreCoin(a);
        const blocker = (core && pairBusy(core, m.toCcy, t)) || stashBusy(a.ffCode, m.toCcy, t);
        if (blocker) return wait(m, t, M, `Waiting for FixedFloat order ${blocker.id} on the same pair to finish (FixedFloat's rules)`);
        if (budgetLeft() < 80) return wait(m, t, 30 * S, 'Waiting for room in the FixedFloat request budget');
        const q = await chain.quote(ref);
        if (!q) {
          if (t - m.createdAt > D) return fail(e, m, 'Nothing confirmed to move (or too little to pay the network fee).');
          return wait(m, t, 30 * S, 'Waiting for the payment to confirm');
        }
        const p = await quotePair(a.ffCode, m.toCcy, Number(fromBase(q.amount, a.decimals)));
        if (p.belowMin) return fail(e, m, `Below FixedFloat's minimum of ${p.min} ${a.symbol}${p.usdPerCoin ? ` (about $${Math.ceil(p.min * p.usdPerCoin)})` : ''}.`);
        if (p.aboveMax) return fail(e, m, `Above FixedFloat's maximum of ${p.max} ${a.symbol}: move it by hand.`);
        if (p.blocking.length) return wait(m, t, 5 * M, `FixedFloat can't do ${a.ffCode} → ${m.toCcy} right now (${p.blocking.join(', ')})`);
        if (m.to === 'xmr' && !m.xmrEntryId) {
          const x = await newEntry(ASSETS.XMR, e.label, 'swap', t, { kind: 'move', entryId: e.id, ccy: a.ffCode });
          m.xmrEntryId = x.id;
          m.toAddress = x.address;
          save();
        }
        const amount = Math.floor(Number(fromBase(q.amount, a.decimals)) * 10 ** p.precision) / 10 ** p.precision;
        const o = await ff.create(a.ffCode, m.toCcy, amount, m.toAddress!);
        checkStashOrder(o, a.ffCode, m.toCcy, m.toAddress!);
        if (usedDeposit(o.from.address)) throw new Error(`FixedFloat order ${o.id} reuses an old deposit address; making another one.`);
        recordOrder(o, { kind: 'move', entryId: e.id, moveId: m.id, fromCode: a.ffCode, toCcy: m.toCcy, toAddress: m.toAddress!, ownRefund: e.address }, t);
        m.orderId = o.id;
        m.quote = fromQuote(q);
        m.step = 'order';
        m.error = null;
        m.tries = 0;
        save();
        logger.info(`[wallet ${e.id}] FixedFloat order ${o.id}: ${fromBase(q.amount, a.decimals)} ${a.ffCode} → ${m.toCcy}, our wallet pays ${o.from.address}`);
        return;
      }
      case 'order': {
        const o = orderOf(m.orderId);
        if (!o) return fail(e, m, 'Its FixedFloat order went missing.');
        if (t - o.createdAt > 20 * M) {
          // Never paid and getting stale: start over with a fresh order rather than pay an expiring one.
          m.step = 'quote';
          m.orderId = undefined;
          o.ff = { ...o.ff, status: 'EXPIRED' };
          o.nextPollAt = Number.MAX_SAFE_INTEGER;
          save();
          return;
        }
        let q = toQuote(m.quote);
        let signed;
        try {
          signed = await chain.prepare(ref, o.depositAddress, q);
        } catch (err) {
          if (!/quoting again/i.test((err as Error).message)) throw err;
          const again = await chain.quote(ref);
          if (!again) throw err;
          q = again;
          m.quote = fromQuote(q);
          signed = await chain.prepare(ref, o.depositAddress, q);
        }
        m.signed = { txids: signed.txids, raw: signed.raw, amount: signed.amount.toString(), fee: signed.fee.toString(), ...(signed.blockhash ? { blockhash: signed.blockhash } : {}) };
        m.step = 'signed';
        m.error = null;
        m.tries = 0;
        save(); // saved before it's broadcast
        return;
      }
      case 'signed': {
        const s = m.signed!;
        try {
          for (const raw of s.raw) await chain.broadcast(raw);
        } catch (err) {
          const there = await chain.status(ref, s.txids[0]).catch(() => null);
          if (!there) {
            if (chain.expired && (await chain.expired({ txids: s.txids, raw: s.raw, amount: big(s.amount), fee: big(s.fee), blockhash: s.blockhash }).catch(() => false))) {
              m.signed = undefined;
              m.step = 'order'; // it can never land now: sign a new one for the same order
              save();
              return;
            }
            throw err;
          }
        }
        m.step = 'sent';
        m.sentAt = t;
        m.error = null;
        m.tries = 0;
        save();
        const o = orderOf(m.orderId);
        if (o) o.nextPollAt = t + 10 * S;
        logger.info(`[wallet ${e.id}] sent ${fromBase(big(s.amount), a.decimals)} ${a.symbol} to FixedFloat (${s.txids.join(', ')})`);
        ping({ kind: 'sent', key: `stash:out:${m.id}`, amount: fromBase(big(s.amount), a.decimals), asset: nameOf(e), label: e.label || null, detail: `to swap → ${m.to === 'xmr' ? 'Monero' : m.toLabel}${m.by === 'openclaw' ? ' (OpenClaw)' : m.by === 'auto' ? ' (automatic)' : ''}`, address: o?.depositAddress ?? null, txUrl: a.explorerTx(s.txids[0]), at: t });
        return;
      }
      case 'sent': {
        const o = orderOf(m.orderId);
        if (!o) return fail(e, m, 'Its FixedFloat order went missing.');
        const f = o.ff;
        if (f.status === 'DONE' || (f.status === 'EMERGENCY' && f.emergency?.choice === 'REFUND')) {
          if (f.to?.tx?.id) {
            m.step = 'done';
            m.doneAt = t;
            m.out = f.to.tx.amount ? String(f.to.tx.amount) : undefined;
            m.error = null;
            save();
            if (m.to === 'coinbase') ping({ kind: 'sent', key: `stash:done:${m.id}`, amount: m.out ?? '?', asset: 'USDC', label: e.label || null, detail: `${nameOf(e)} → ${m.toLabel}`, address: m.toAddress ?? null, txUrl: `https://basescan.org/tx/${f.to.tx.id}`, at: t });
            logger.info(`[wallet ${e.id}] move ${m.id} done: ${m.out ?? '?'} ${m.toCcy} paid out`);
          } else if (f.back?.tx?.id || f.refunded) {
            fail(e, m, 'FixedFloat sent it back to this address.');
            nextScan.set(e.id, t);
          }
          return;
        }
        // Make sure our transaction is out there: broadcast it again while nobody has seen it.
        const s = m.signed!;
        if (t - (m.sentAt ?? t) > 5 * M && !(await chain.status(ref, s.txids[0]).catch(() => ({ confirmations: 0 })))) {
          if (chain.expired && (await chain.expired({ txids: s.txids, raw: s.raw, amount: big(s.amount), fee: big(s.fee), blockhash: s.blockhash }).catch(() => false))) {
            m.signed = undefined;
            m.step = 'order';
            m.error = 'The transaction expired before it landed; signing it again';
            save();
            return;
          }
          for (const raw of s.raw) await chain.broadcast(raw).catch(() => undefined);
          return wait(m, t, 2 * M, 'Broadcasting it again (not seen on the network yet)');
        }
        return wait(m, t, 15 * S, null);
      }
    }
  } catch (err) {
    m.tries++;
    m.error = friendlyError(err);
    m.nextAt = t + backoff(m.tries);
    markDirty();
    logger.warn(`[wallet ${e.id}] move ${m.id} (${m.step}) try ${m.tries}: ${m.error}`);
  }
}

// ---------------------------------------------------------------- watching

/** When each address is looked at next (runtime only: after a restart everything is looked at soon). */
const nextScan = new Map<string, number>();

function scanDelay(e: Entry, t: number): number {
  const age = t - e.createdAt;
  const xmrLocal = ASSETS[e.asset].kind === 'xmr';
  if (activeMove(e)) return 20 * S;
  if (big(e.seen) > 0n && !e.confirmed) return xmrLocal ? 30 * S : 15 * S; // incoming: watch it confirm
  if (age < 2 * H) return xmrLocal ? 30 * S : 12 * S;
  if (big(e.spendable) > 0n) return 10 * M;
  if (age < 7 * D) return 2 * M;
  if (age < 90 * D) return 15 * M;
  return 2 * H;
}

export async function scanEntry(e: Entry, t = now()): Promise<void> {
  const a = ASSETS[e.asset];
  if (!assetReady(a)) return;
  const prev = { seen: big(e.seen), spendable: big(e.spendable), confirmed: e.confirmed };
  try {
    const s = await chainOf(a).scan(refOf(e));
    e.scannedAt = t;
    e.scanError = null;
    e.seen = s.seen.toString();
    e.spendable = s.spendable.toString();
    e.txids = s.txids.slice(0, 20);
    e.confirmed = s.confirmed && s.seen > 0n ? true : s.seen === 0n;
    markDirty();
    if (s.seen > prev.seen) {
      e.firstSeenAt ??= t;
      const key = s.txids.length ? [...s.txids].sort().join(',') : s.seen.toString();
      logger.info(`[wallet ${e.id}] ${fromBase(s.seen - prev.seen, a.decimals)} ${a.symbol} arriving at ${nameOf(e)}${e.label ? ` "${e.label}"` : ''}`);
      const from = e.from?.kind === 'move' ? `from your ${e.from.ccy} swap` : e.from?.kind === 'via' ? `swapped from ${e.from.ccy}` : 'fresh address';
      ping({ kind: 'received', key: `stash:in:${e.id}:${key}`, amount: fromBase(s.seen - prev.seen, a.decimals), asset: nameOf(e), label: e.label || null, detail: `incoming · ${from}`, address: e.address, txUrl: s.txids[0] ? a.explorerTx(s.txids[0]) : null, at: t });
    }
    if (e.confirmed && s.spendable > 0n && (!prev.confirmed || s.spendable > prev.spendable)) {
      e.heldAt = t;
      ping({ kind: 'received', key: `stash:held:${e.id}:${s.spendable}`, amount: fromBase(s.spendable, a.decimals), asset: nameOf(e), label: e.label || null, detail: 'confirmed · held in the Wallet', address: e.address, at: t });
      await maybeAuto(e, t);
    }
  } catch (err) {
    e.scanError = friendlyError(err);
    markDirty();
  }
}

/** The Wallet's "on arrival" setting: swap a confirmed payment on its own (never what a swap just paid in). */
async function maybeAuto(e: Entry, t: number): Promise<void> {
  const how = load().settings.onArrival;
  if (how === 'hold' || e.archived || activeMove(e) || e.from?.kind === 'move') return;
  if (how === 'xmr' && e.asset === 'XMR') return;
  if (e.autoTriedFor === e.spendable) return;
  e.autoTriedFor = e.spendable;
  try {
    await startMove(e.id, how, { by: 'auto' }, t);
  } catch (err) {
    logger.warn(`[wallet ${e.id}] automatic ${how === 'xmr' ? 'Swap to Monero' : 'Send to Coinbase'} didn't start: ${friendlyError(err)}`);
  }
}

// ---------------------------------------------------------------- FixedFloat orders

function pollDelay(o: StashOrder, t: number): number | null {
  const age = t - o.createdAt;
  const s = o.ff.status;
  if (LIVE.has(s)) return 15 * S;
  if (s === 'EMERGENCY') return emergencyAction(o.ff) === 'continue' ? 30 * S : 5 * M;
  if (age > 30 * D) return null;
  if (o.kind === 'move') {
    const m = load().entries.find((e) => e.id === o.entryId)?.moves.find((x) => x.id === o.moveId);
    if (s === 'DONE' || !m || m.step === 'failed' || m.step === 'done' || m.orderId !== o.id) return null;
    return m.step === 'sent' ? 15 * S : M;
  }
  if (s === 'DONE') return 30 * M; // a second payment to the same address reopens it
  return age < 2 * H ? 15 * S : 5 * M;
}

export async function pollStashOrder(o: StashOrder, t = now()): Promise<void> {
  const was = o.ff.status;
  try {
    o.ff = stripToken(await ff.order(o.id, o.token));
    o.pollError = null;
  } catch (err) {
    o.pollError = friendlyError(err);
  }
  markDirty();
  const f = o.ff;
  if (f.status !== was) logger.info(`[wallet order ${o.id}] FixedFloat: ${was} → ${f.status}`);
  const e = load().entries.find((x) => x.id === o.entryId);
  // A long-tail payment: FixedFloat saw it arrive.
  if (o.kind === 'via' && e && f.from?.tx?.id && (LIVE.has(f.status) || f.status === 'EMERGENCY' || f.status === 'DONE')) {
    ping({ kind: 'received', key: `stash:via:${o.id}:${f.from.tx.id}`, amount: String(f.from.tx.amount ?? '?'), asset: o.fromCode, label: e.label || null, detail: 'incoming · swapping into Monero', address: o.depositAddress, at: t });
    e.firstSeenAt ??= t;
  }
  // Late or odd-sized payments: continue at market rate. Below the minimum: a move's coins go back to the address that paid.
  const action = emergencyAction(f);
  const tx = f.from?.tx?.id ?? null;
  const answeredRecently = o.answered && o.answered.forTx === tx && t - o.answered.at < 5 * M;
  if (!answeredRecently && (action === 'continue' || (action === 'refund' && o.ownRefund))) {
    const choice = action === 'continue' ? 'EXCHANGE' : 'REFUND';
    try {
      await ff.emergency(o.id, o.token, choice, choice === 'REFUND' ? o.ownRefund : undefined);
      o.answered = { forTx: tx, choice, at: t };
      logger.info(`[wallet order ${o.id}] FixedFloat flagged it (${(f.emergency?.status ?? []).join(', ')}): answered ${choice}`);
    } catch (err) {
      logger.warn(`[wallet order ${o.id}] couldn't answer FixedFloat's emergency: ${friendlyError(err)}`);
    }
  }
  const d = pollDelay(o, t);
  o.nextPollAt = d === null ? Number.MAX_SAFE_INTEGER : t + d;
}

// ---------------------------------------------------------------- the loop

let ticking = false;

/** One pass: scans that are due, moves, FixedFloat orders. */
export async function tick(t = now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const data = load();
    for (const e of data.entries) if (!nextScan.has(e.id)) nextScan.set(e.id, t + Math.random() * 20 * S); // after a restart: soon, spread out
    const due = data.entries
      .filter((e) => nextScan.get(e.id)! <= t)
      .sort((x, y) => nextScan.get(x.id)! - nextScan.get(y.id)!)
      .slice(0, 8);
    await Promise.all(
      due.map(async (e) => {
        nextScan.set(e.id, t + scanDelay(e, t)); // set first, so a slow scan isn't started twice
        await scanEntry(e, t);
        nextScan.set(e.id, t + scanDelay(e, t));
      }),
    );
    for (const e of data.entries) {
      const m = activeMove(e);
      if (m) await stepMove(e, m, t);
    }
    for (const o of data.orders.filter((x) => x.nextPollAt <= t).slice(0, 4)) {
      if (budgetLeft() < 80) break; // leave FixedFloat's request budget to the transfers first
      await pollStashOrder(o, t);
    }
  } finally {
    ticking = false;
    flush();
  }
}

export function startStash(log: FastifyBaseLogger): () => void {
  const timer = setInterval(() => {
    tick().catch((e) => log.warn({ err: e }, 'wallet tick failed'));
  }, 2 * S);
  timer.unref();
  return () => {
    clearInterval(timer);
    flush();
  };
}

/** Tests: forget the runtime schedule and throttles. */
export function resetEngine(): void {
  nextScan.clear();
  recent.length = 0;
  recentVia.length = 0;
}

// ---------------------------------------------------------------- what the browser (and OpenClaw) see

function stateOf(e: Entry): 'waiting' | 'incoming' | 'held' | 'moving' | 'moved' {
  if (activeMove(e)) return 'moving';
  const seen = big(e.seen);
  if (e.via && seen === 0n) {
    const o = orderOf(e.via.orderId);
    return o && o.ff.from?.tx?.id && o.ff.status !== 'NEW' ? 'incoming' : 'waiting';
  }
  const last = e.moves[e.moves.length - 1];
  if (seen === 0n) return last?.step === 'done' ? 'moved' : 'waiting';
  if (!e.confirmed) return 'incoming';
  // What the gas reserve left behind after a move isn't worth showing as held.
  if (last?.step === 'done' && last.quote && big(e.spendable) <= big(last.quote.fee) * 3n) return 'moved';
  return 'held';
}

const usdOf = (a: Asset): number | null => cachedPair(a.ffCode, 'USDCBASE')?.usdPerCoin ?? cachedPair(a.ffCode, 'XMR')?.usdPerCoin ?? null;

/** Everything the window shows about an address, and nothing that could move money (no tokens, no signed transactions). */
export function entryView(e: Entry) {
  const a = ASSETS[e.asset];
  const usd = usdOf(a);
  const amount = fromBase(big(e.seen), a.decimals);
  const viaOrder = e.via ? orderOf(e.via.orderId) : null;
  return {
    id: e.id,
    asset: a.id,
    name: e.via ? e.via.name : a.name,
    symbol: e.via ? e.via.code : a.symbol,
    network: e.via ? e.via.network : a.network,
    color: a.color,
    kind: e.via ? ('via' as const) : a.kind,
    label: e.label,
    by: e.by,
    createdAt: e.createdAt,
    address: e.via ? e.via.depositAddress : e.address,
    uri: e.via ? null : payUri(a, e.address),
    warning: e.via ? `Send only ${e.via.name} (${e.via.network}).${e.via.tag ? ' Include the memo / tag below, or the payment is lost.' : ''}` : a.warning,
    explorer: e.via ? null : a.explorerAddress(e.address) || null,
    state: stateOf(e),
    amount,
    spendable: fromBase(big(e.spendable), a.decimals),
    heldSymbol: a.symbol,
    usd: usd ? Math.round(Number(amount) * usd * 100) / 100 : null,
    confirmed: e.confirmed,
    firstSeenAt: e.firstSeenAt,
    txs: e.txids.slice(0, 5).map((id) => ({ id, url: a.explorerTx(id) })),
    scanError: e.scanError,
    archived: Boolean(e.archived),
    from: e.from ? { kind: e.from.kind, ccy: e.from.ccy, entryId: e.from.entryId ?? null } : null,
    via: e.via
      ? {
          code: e.via.code,
          name: e.via.name,
          network: e.via.network,
          tag: e.via.tag,
          expiresAt: e.via.expiresAt,
          min: e.via.min,
          max: e.via.max,
          status: viaOrder?.ff.status ?? null,
          stage: viaOrder ? stageOf(viaOrder.ff) : null,
          received: viaOrder?.ff.from?.tx?.amount ? String(viaOrder.ff.from.tx.amount) : null,
          orderId: e.via.orderId,
        }
      : null,
    moves: e.moves.map((m) => {
      const o = orderOf(m.orderId);
      return {
        id: m.id,
        to: m.to,
        by: m.by,
        step: m.step,
        createdAt: m.createdAt,
        sentAt: m.sentAt ?? null,
        doneAt: m.doneAt ?? null,
        amount: m.signed ? fromBase(big(m.signed.amount), a.decimals) : m.quote ? fromBase(big(m.quote.amount), a.decimals) : null,
        out: m.out ?? null,
        toLabel: m.toLabel ?? null,
        error: m.error,
        orderId: m.orderId ?? null,
        orderStatus: o?.ff.status ?? null,
        txUrl: m.signed ? a.explorerTx(m.signed.txids[0]) : null,
        payoutUrl: o?.ff.to?.tx?.id ? (m.toCcy === 'USDCBASE' ? `https://basescan.org/tx/${o.ff.to.tx.id}` : null) : null,
        xmrEntryId: m.xmrEntryId ?? null,
      };
    }),
  };
}
export type EntryView = ReturnType<typeof entryView>;

/** Prices and minimums for the coins in use, refreshed in the background while someone is looking (~2 calls per coin per 10 minutes). */
let pricesAt = 0;
export function refreshPrices(t = now()): void {
  if (t - pricesAt < 60 * S || !config.ff.apiKey) return;
  pricesAt = t;
  const ids = new Set<AssetId>(load().entries.filter((e) => !e.archived && big(e.seen) > 0n).map((e) => e.asset));
  void (async () => {
    for (const id of ASSET_IDS) {
      const a = ASSETS[id];
      for (const to of id === 'XMR' ? ['USDCBASE'] : ['USDCBASE', 'XMR']) {
        if (!ids.has(id) && cachedPair(a.ffCode, to)) continue; // coins nobody holds: once is enough
        if (budgetLeft() < 120) return;
        await pairInfo(a.ffCode, to, a.probe).catch(() => undefined);
      }
    }
  })();
}

export function assetsView() {
  const hidden = new Set(load().settings.hidden);
  return ASSET_IDS.map((id) => {
    const a = ASSETS[id];
    const minUsd = (to: string) => {
      const p = cachedPair(a.ffCode, to);
      return p?.usdPerCoin ? Math.ceil(p.min * p.usdPerCoin) : null;
    };
    return {
      id,
      name: a.name,
      symbol: a.symbol,
      network: a.network,
      color: a.color,
      kind: a.kind,
      ready: assetReady(a),
      hidden: hidden.has(id),
      usd: usdOf(a),
      minUsd: { xmr: id === 'XMR' ? null : minUsd('XMR'), coinbase: minUsd('USDCBASE') },
    };
  });
}

export function walletView(opts: { all?: boolean } = {}) {
  const data = load();
  const list = data.entries.filter((e) => opts.all || !e.archived).slice(-200).reverse().map(entryView);
  const total = list.reduce((s, v) => s + (v.state === 'held' || v.state === 'incoming' || v.state === 'moving' ? (v.usd ?? 0) : 0), 0);
  return {
    entries: list,
    totalUsd: Math.round(total * 100) / 100,
    settings: data.settings,
    assets: assetsView(),
    ready: { wallet: walletState().ready, monero: xmrConfigured(), fixedfloat: Boolean(config.ff.apiKey) },
    destinations: destinations.list().map((d) => ({ id: d.id, label: d.label })),
  };
}

export const getEntry = (id: string) => load().entries.find((e) => e.id === id) ?? null;
