import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Coin, Fees } from '../types';
import { moneyPath, type MoneyPath, type PathOptions, type Tx } from './moneyPath';
import { getChoice, setChoice } from './prefs';

/**
 * Roughly what a payment loses on the way, for a set of Send options: every swap's cut and every transaction of our
 * own, from the server's live numbers (/api/fees), or typical ones where it has none. An estimate: FixedFloat's rate
 * moves, and its cut is measured on a small amount.
 */

/** Used when the server can't say: FixedFloat's float rate is about 1%; network fees on a normal day. */
const TYPICAL = { swap: 1.0, btcForward: 0.6, btcSplit: 0.3, btcSplitPiece: 0.15, ethForward: 0.4, xmrTx: 0.02 };

export interface FeeLine {
  label: string;
  count: number;
  usd: number;
  pct: number;
  /** A typical value: the live one wasn't available. */
  typical: boolean;
}

export interface Estimate {
  lines: FeeLine[];
  usd: number;
  pct: number;
  typical: boolean;
}

const NET: Record<Coin, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', XMR: 'Monero' };
const pick = (live: number | null | undefined, typical: number): [number, boolean] => (live === null || live === undefined ? [typical, true] : [live, false]);

/** What the money is worth along the way: `at[piece][column]` is a piece's dollars as it leaves that stop. */
export interface Flow extends Estimate {
  at: number[][];
  /** What arrives, in all. */
  out: number;
}

/** One cost: a swap's percent of what it swaps, or a transaction's fee in dollars. */
function costOf(tx: Tx, fees: Fees | null): { label: string; pct?: number; usd?: number; typical: boolean } {
  if (tx.kind === 'swap') {
    const [pct, typical] = pick(fees?.swap[tx.from]?.[tx.to === 'XMR' ? 'xmr' : 'usdc'], TYPICAL.swap);
    return { label: `FixedFloat swap ${tx.from} → ${tx.to}`, pct, typical };
  }
  if (tx.kind === 'forward') {
    const [usd, typical] = tx.coin === 'BTC' ? pick(fees?.network.BTC.forward, TYPICAL.btcForward) : tx.coin === 'ETH' ? pick(fees?.network.ETH.forward, TYPICAL.ethForward) : pick(fees?.network.XMR.tx, TYPICAL.xmrTx);
    return { label: `Your server forwards it (${NET[tx.coin]} fee)`, usd, typical };
  }
  if (tx.kind === 'split') {
    const [base, t1] = pick(fees?.network.BTC.split, TYPICAL.btcSplit);
    const [per, t2] = pick(fees?.network.BTC.splitPiece, TYPICAL.btcSplitPiece);
    return { label: 'Split into pieces (Bitcoin fee)', usd: base + per * tx.pieces, typical: t1 || t2 };
  }
  const [usd, typical] = pick(fees?.network.XMR.tx, TYPICAL.xmrTx);
  return { label: 'Moves in your Monero wallet (Monero fee)', usd, typical };
}

/**
 * Walks every piece through its stops, taking each cost where it's taken: a swap's cut of what that piece is worth by
 * then, a fee shared by all of it before the split in proportion, a piece's own fee from that piece. The table, the
 * total and the dollars on the map all come from this one walk, so they always agree.
 */
export function valueFlow(p: MoneyPath, fees: Fees | null, amountUsd: number): Flow {
  const amount = Math.max(0, amountUsd);
  const lines: FeeLine[] = [];
  const line = (label: string, usd: number, typical: boolean, count: number) => {
    const same = lines.find((l) => l.label === label);
    if (same) {
      same.count += count;
      same.usd += usd;
      same.typical ||= typical;
    } else lines.push({ label, count, usd, pct: 0, typical });
  };
  const v = p.shares.map((s) => amount * s);
  const at = p.shares.map(() => p.columns.map(() => 0));
  p.columns.forEach((_, col) => {
    for (const tx of p.txs.filter((x) => x.col === col)) {
      const c = costOf(tx, fees);
      const lanes = tx.lane === null ? p.shares.map((_, k) => k) : [tx.lane];
      let usd = 0;
      for (const k of lanes) {
        const take = Math.min(v[k], c.pct !== undefined ? (v[k] * c.pct) / 100 : (c.usd ?? 0) * (tx.lane === null ? p.shares[k] : 1));
        v[k] -= take;
        usd += take;
      }
      line(c.label, usd, c.typical, 1);
    }
    v.forEach((val, k) => (at[k][col] = val));
  });
  for (const l of lines) l.pct = amount ? (l.usd / amount) * 100 : 0;
  const usd = lines.reduce((s, l) => s + l.usd, 0);
  return { lines, usd, pct: amount ? (usd / amount) * 100 : 0, typical: lines.some((l) => l.typical), at, out: v.reduce((s, x) => s + x, 0) };
}

export const estimate = (o: PathOptions, fees: Fees | null, amountUsd: number): Estimate => valueFlow(moneyPath(o), fees, amountUsd);

/** Every route × pieces, for the comparison grid: rows are routes, columns are 1–`max` pieces. */
export function compareGrid(o: PathOptions, fees: Fees | null, amountUsd: number, max = 4): { route: PathOptions['route']; pcts: number[] }[] {
  const routes: PathOptions['route'][] = o.coin === 'XMR' ? ['direct'] : ['direct', 'monero'];
  return routes.map((route) => ({ route, pcts: Array.from({ length: max }, (_, i) => estimate({ ...o, route, pieces: i + 1 }, fees, amountUsd).pct) }));
}

/** "1.2%", "0.45%". */
export const pctText = (p: number) => `${p < 1 ? p.toFixed(2) : p.toFixed(1)}%`;
/** "$6.20", "$0.04". */
export const feeUsd = (v: number) => `$${v < 10 ? v.toFixed(2) : v.toFixed(0)}`;

/** The live numbers, refreshed every couple of minutes while something shows them (null until they arrive, or if they can't). */
export function useFees(): Fees | null {
  const [f, setF] = useState<Fees | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .fees()
        .then((v) => alive && setF(v))
        .catch(() => {});
    load();
    const iv = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);
  return f;
}

const AMOUNT_KEY = 'feeAmount';
const DEFAULT_AMOUNT = 500;

/** The amount the estimates are for, remembered in this browser (shared by How it works and Send options). */
export function getFeeAmount(): number {
  const v = Number(getChoice(AMOUNT_KEY));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_AMOUNT;
}

export function useFeeAmount(): [number, (v: number) => void] {
  const [v, setV] = useState(getFeeAmount);
  useEffect(() => {
    const on = () => setV(getFeeAmount());
    window.addEventListener('wc:prefs', on);
    return () => window.removeEventListener('wc:prefs', on);
  }, []);
  return [
    v,
    (next: number) => {
      setV(next);
      if (next > 0) {
        setChoice(AMOUNT_KEY, String(next));
        window.dispatchEvent(new Event('wc:prefs'));
      }
    },
  ];
}
