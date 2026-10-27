import path from 'node:path';
import { config } from '../config.js';
import type { FfOrder } from '../fixedfloat.js';
import { readJson, writeJsonAtomic } from '../store.js';
import type { AssetId } from './assets.js';

/**
 * data/stash.json: the Wallet window's addresses, what they hold, the moves out of them and the FixedFloat orders
 * those use. Kept apart from routes.json / transfers.json / orders.json so nothing the transfers do can touch it
 * (and nothing here can touch them). Order tokens and signed transactions are in here: it never goes to the browser.
 */

export type Who = 'you' | 'openclaw' | 'auto' | 'swap';
export type MoveTo = 'xmr' | 'coinbase';

export interface Move {
  id: string;
  to: MoveTo;
  by: Who;
  createdAt: number;
  /** Where the swap pays out: one of our own Wallet Monero subaddresses, or an address book destination. */
  toCcy: 'XMR' | 'USDCBASE';
  toAddress?: string;
  toLabel?: string;
  destinationId?: string;
  /** The Wallet entry the Monero lands in (Swap to Monero). */
  xmrEntryId?: string;
  step: 'quote' | 'order' | 'signed' | 'sent' | 'done' | 'failed';
  /** What's being sent (base units, as strings), and how. */
  quote?: { amount: string; fee: string; inputs?: string[]; gas?: string; maxFee?: string };
  orderId?: string;
  /** Signed before broadcasting, saved so a crash broadcasts the same one again. Secret. */
  signed?: { txids: string[]; raw: string[]; amount: string; fee: string; blockhash?: string };
  sentAt?: number;
  doneAt?: number;
  /** What came out of the swap (USDC or XMR, decimal), once FixedFloat paid it. */
  out?: string;
  error: string | null;
  tries: number;
  nextAt: number;
}

export interface Via {
  /** FixedFloat's code for the coin the payer sends ("ZEC"), its name and network. */
  code: string;
  name: string;
  network: string;
  depositAddress: string;
  /** Memo / destination tag the payer must include (XRP, XLM, ATOM, TON …). */
  tag: string | null;
  orderId: string;
  expiresAt: number | null;
  min: string | null;
  max: string | null;
}

export interface Entry {
  id: string;
  asset: AssetId;
  index: number;
  address: string;
  label: string;
  createdAt: number;
  by: Who;
  /** XMR entries that a swap pays into: the move or long-tail order it came from. */
  from?: { kind: 'move' | 'via'; entryId?: string; orderId?: string; ccy: string };
  /** A long-tail coin: the payer pays this FixedFloat address, and the Monero lands here. */
  via?: Via;
  /** Latest scan, base units. */
  seen: string;
  spendable: string;
  txids: string[];
  confirmed: boolean;
  firstSeenAt: number | null;
  heldAt: number | null;
  scannedAt: number | null;
  scanError: string | null;
  moves: Move[];
  /** Hidden from the list (the address is still watched, and never handed out again). */
  archived?: boolean;
  /** The automatic action already tried this balance and couldn't (below the minimum): wait for more. */
  autoTriedFor?: string;
}

export interface StashOrder {
  id: string;
  /** FixedFloat access token: it can redirect a refund, so it never leaves the server. */
  token: string;
  kind: 'move' | 'via';
  entryId: string;
  moveId?: string;
  fromCode: string;
  toCcy: 'XMR' | 'USDCBASE';
  toAddress: string;
  depositAddress: string;
  createdAt: number;
  /** Latest FixedFloat snapshot, without the token. */
  ff: FfOrder;
  nextPollAt: number;
  pollError: string | null;
  /** Refunds of a move go back to the Wallet address that paid. */
  ownRefund?: string;
  /** Our last emergency answer, per deposit. */
  answered?: { forTx: string | null; choice: 'EXCHANGE' | 'REFUND'; at: number };
}

export interface Settings {
  /** What happens once a payment is confirmed: nothing (hold), or swap it on its own. */
  onArrival: 'hold' | MoveTo;
  /** Where "Send to Coinbase" pays by default (an address book id). */
  destinationId: string;
  /** Coins not shown in the picker. */
  hidden: string[];
  /** Telegram pings for the Wallet window's addresses. */
  pings: boolean;
}

export interface StashFile {
  version: 1;
  /** Next derivation index per counter (BTC, LTC, EVM, SOL). Only ever goes up. */
  next: Record<string, number>;
  entries: Entry[];
  orders: StashOrder[];
  settings: Settings;
}

const file = () => path.join(config.dataDir, 'stash.json');
let cache: StashFile | null = null;
let dirty = false;

export const DEFAULT_SETTINGS: Settings = { onArrival: 'hold', destinationId: 'coinbase-base', hidden: [], pings: true };

export function load(): StashFile {
  if (!cache) {
    cache = readJson<StashFile>(file()) ?? { version: 1, next: {}, entries: [], orders: [], settings: { ...DEFAULT_SETTINGS } };
    cache.settings = { ...DEFAULT_SETTINGS, ...cache.settings };
  }
  return cache;
}

export const markDirty = () => {
  dirty = true;
};

/** Writes stash.json if anything changed. */
export function flush(): void {
  if (!dirty || !cache) return;
  writeJsonAtomic(file(), cache, false);
  dirty = false;
}

/** Writes now: before an address is handed out, after an order is created, after a transaction is signed. */
export function save(): void {
  dirty = true;
  flush();
}

/** Tests: forget the in-memory copy. */
export function resetStore(): void {
  cache = null;
  dirty = false;
}
