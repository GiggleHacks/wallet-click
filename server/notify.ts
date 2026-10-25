import fs from 'node:fs';
import path from 'node:path';
import { COINS, PAYOUTS, config, isStable, type Coin, type PayoutCcy } from './config.js';
import { logger } from './logs.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * Queues a Telegram ping when money arrives or leaves. Failures are logged and swallowed: a ping must
 * never block, retry, or change a transfer. Delivery is a host process reading data/telegram-outbox.jsonl,
 * so this process never holds a bot token.
 */

export interface Notice {
  kind: 'received' | 'sent';
  /** Stable id. A repeat (restart, second poll) does not send again. */
  key: string;
  amount: string;
  asset: string;
  /** Where it landed, or where it went. */
  address?: string | null;
  label?: string | null;
  detail?: string | null;
  txUrl?: string | null;
  at: number;
}

const KEYS_KEEP = 2000;

function dir(): string {
  return process.env.WC_NOTIFY_DIR || config.dataDir;
}
const keysFile = () => path.join(dir(), 'notify-keys.json');
const outboxFile = () => path.join(dir(), 'telegram-outbox.jsonl');

let keys: Set<string> | null = null;

function loadKeys(): Set<string> {
  if (keys) return keys;
  const saved = readJson<string[]>(keysFile());
  keys = new Set(Array.isArray(saved) ? saved : []);
  return keys;
}

/** Tests: drop the in-memory dedupe set. */
export function resetNotify(): void {
  keys = null;
}

/** Mark keys already handled so a restart does not replay old payments. Does not send. */
export function rememberNotified(ids: string[]): void {
  if (!enabled()) return;
  try {
    const seen = loadKeys();
    let changed = false;
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      changed = true;
    }
    if (!changed) return;
    const keep = [...seen].slice(-KEYS_KEEP);
    keys = new Set(keep);
    writeJsonAtomic(keysFile(), keep, false);
  } catch (e) {
    logger.warn({ err: e }, 'telegram notify prime failed');
  }
}

function stamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatNotice(n: Notice): string {
  const emoji = n.kind === 'received' ? '📥' : '📤';
  const verb = n.kind === 'received' ? 'Received' : 'Sent';
  const lines = [`${emoji} ${verb}`, `${n.amount} ${n.asset}`.trim()];
  if (n.detail) lines.push(n.detail);
  if (n.label) lines.push(n.label);
  if (n.address) lines.push(`To: ${n.address}`);
  if (n.txUrl) lines.push(n.txUrl);
  lines.push(stamp(n.at));
  return lines.join('\n');
}

function enabled(): boolean {
  return !(process.env.VITEST && process.env.WC_NOTIFY_TEST !== '1');
}

/** Queue one ping. No-op if this key was already queued, or during tests unless WC_NOTIFY_TEST=1. */
export function notify(n: Notice): void {
  if (!enabled()) return;
  if (!n.key || !n.amount) return;
  try {
    const seen = loadKeys();
    if (seen.has(n.key)) return;
    seen.add(n.key);
    const keep = [...seen].slice(-KEYS_KEEP);
    keys = new Set(keep);
    writeJsonAtomic(keysFile(), keep, false);
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(outboxFile(), `${JSON.stringify({ key: n.key, at: n.at, text: formatNotice(n) })}\n`, { mode: 0o600 });
    logger.info(`telegram queued: ${n.kind} ${n.amount} ${n.asset}`);
  } catch (e) {
    logger.warn({ err: e }, 'telegram notify failed');
  }
}

/** A FixedFloat order just moved. External deposits ping once; a stablecoin payout (not our own Monero vault) pings once. */
export function noteOrderMoney(p: {
  id: string;
  coin: Coin;
  depositAddress: string;
  ownRefund?: string;
  toCcy: PayoutCcy;
  toAddress: string;
  toLabel: string;
  seen?: { at: number; amount: string };
  /** True only when this process just spotted the payment on-chain. A restart must not replay old sightings. */
  seenNew?: boolean;
  fromTxId?: string | null;
  fromAmount?: string | null;
  toTxId?: string | null;
  toAmount?: string | null;
  hadFrom: boolean;
  hadTo: boolean;
  hadRefund: boolean;
  refundTxId?: string | null;
  refundAmount?: string | null;
  refundTo?: string | null;
  at: number;
}): void {
  const external = !p.ownRefund;
  if (external && p.seenNew && p.seen) {
    notify({
      kind: 'received',
      key: `recv:order:${p.id}`,
      amount: p.seen.amount,
      asset: p.coin,
      address: p.depositAddress,
      txUrl: p.fromTxId ? COINS[p.coin].explorerTx(p.fromTxId) : null,
      at: p.seen.at,
    });
  }
  if (external && !p.hadFrom && p.fromAmount) {
    notify({
      kind: 'received',
      key: `recv:order:${p.id}`,
      amount: p.fromAmount,
      asset: p.coin,
      address: p.depositAddress,
      txUrl: p.fromTxId ? COINS[p.coin].explorerTx(p.fromTxId) : null,
      at: p.at,
    });
  }
  if (!p.hadTo && p.toTxId && isStable(p.toCcy)) {
    notify({
      kind: 'sent',
      key: `send:payout:${p.toTxId}`,
      amount: p.toAmount ?? '?',
      asset: PAYOUTS[p.toCcy].symbol,
      label: p.toLabel,
      address: p.toAddress,
      txUrl: PAYOUTS[p.toCcy].explorerTx(p.toTxId),
      at: p.at,
    });
  }
  if (!p.hadRefund && p.refundTxId) {
    notify({
      kind: 'sent',
      key: `send:refund:${p.refundTxId}`,
      amount: p.refundAmount ?? '?',
      asset: p.coin,
      detail: 'Refund',
      address: p.refundTo,
      txUrl: COINS[p.coin].explorerTx(p.refundTxId),
      at: p.at,
    });
  }
}

export function noteRouteReceived(p: { routeId: string; label: string; coin: Coin; address: string; amount: string; txids: string[]; at: number }): void {
  const txid = p.txids[0];
  const id = p.txids.length ? [...p.txids].sort().join(',') : p.amount;
  notify({
    kind: 'received',
    key: `recv:route:${p.routeId}:${id}`,
    amount: p.amount,
    asset: p.coin,
    label: p.label,
    address: p.address,
    txUrl: txid ? COINS[p.coin].explorerTx(txid) : null,
    at: p.at,
  });
}

export function noteHotSend(p: { txid: string; amount: string; coin: Coin; to: string; at: number }): void {
  notify({
    kind: 'sent',
    key: `send:hot:${p.txid}`,
    amount: p.amount || '?',
    asset: p.coin,
    detail: 'To the swap',
    address: p.to,
    txUrl: COINS[p.coin].explorerTx(p.txid),
    at: p.at,
  });
}

