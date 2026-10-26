import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Coin, Fees } from '../types';
import { moneyPath, type PathOptions, type Tx } from './moneyPath';
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

export function estimateTxs(txs: Tx[], fees: Fees | null, amountUsd: number): Estimate {
  const lines: FeeLine[] = [];
  const amount = Math.max(0, amountUsd);
  /** What's left after the swaps so far (the second swap of a Monero journey takes its cut of less). */
  let value = amount;
  const line = (label: string, count: number, usd: number, typical: boolean) => {
    const same = lines.find((l) => l.label === label);
    if (same) {
      same.count += count;
      same.usd += usd;
      same.typical ||= typical;
    } else lines.push({ label, count, usd, pct: 0, typical });
  };
  // The swaps into Monero happen before those out of it: take them in order.
  let stage = '';
  let stageValue = value;
  for (const tx of txs) {
    if (tx.kind === 'swap') {
      const key = `${tx.from}>${tx.to}`;
      if (key !== stage) {
        stage = key;
        stageValue = value;
      }
      const [pct, typical] = pick(fees?.swap[tx.from]?.[tx.to === 'XMR' ? 'xmr' : 'usdc'], TYPICAL.swap);
      const usd = (stageValue * tx.share * pct) / 100;
      value -= usd;
      line(`FixedFloat swap ${tx.from} → ${tx.to}`, 1, usd, typical);
    } else if (tx.kind === 'forward') {
      const [usd, typical] = tx.coin === 'BTC' ? pick(fees?.network.BTC.forward, TYPICAL.btcForward) : tx.coin === 'ETH' ? pick(fees?.network.ETH.forward, TYPICAL.ethForward) : pick(fees?.network.XMR.tx, TYPICAL.xmrTx);
      line(`Your server forwards it (${NET[tx.coin]} fee)`, tx.count, usd * tx.count, typical);
      value -= usd * tx.count;
    } else if (tx.kind === 'split') {
      const [base, t1] = pick(fees?.network.BTC.split, TYPICAL.btcSplit);
      const [per, t2] = pick(fees?.network.BTC.splitPiece, TYPICAL.btcSplitPiece);
      const usd = base + per * tx.pieces;
      line('Split into pieces (Bitcoin fee)', 1, usd, t1 || t2);
      value -= usd;
    } else {
      const [usd, typical] = pick(fees?.network.XMR.tx, TYPICAL.xmrTx);
      line('Moves in your Monero wallet (Monero fee)', tx.count, usd * tx.count, typical);
      value -= usd * tx.count;
    }
  }
  for (const l of lines) l.pct = amount ? (l.usd / amount) * 100 : 0;
  const usd = lines.reduce((s, l) => s + l.usd, 0);
  return { lines, usd, pct: amount ? (usd / amount) * 100 : 0, typical: lines.some((l) => l.typical) };
}

export const estimate = (o: PathOptions, fees: Fees | null, amountUsd: number): Estimate => estimateTxs(moneyPath(o).txs, fees, amountUsd);

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
