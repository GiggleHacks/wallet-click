import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Coin, Minimums } from '../types';
import type { SendOptions } from './sendOptions';

/**
 * What a payment must be for its Send options to work, from FixedFloat's live minimums. Every piece is its own
 * swap, so pieces raise the minimum: each one is at least `pieceFactor` × FixedFloat's minimum. Below that a payment
 * goes in fewer pieces (or waits for more), so we recommend sending a margin above it.
 */

/** How much above the minimum we suggest: prices and network fees move while a payment waits. */
const SAFETY = 1.3;
const roundUp = (usd: number) => Math.ceil(usd / 5) * 5;

export interface Minimum {
  /** The least that still goes through as chosen (in dollars). */
  min: number;
  /** What we suggest sending, to be safe. */
  safe: number;
  /** Below `min` but at least this, it goes in fewer pieces; below this it waits for more (null: one piece anyway). */
  single: number | null;
}

export function minimumFor(m: Minimums | null, coin: Coin, o: Pick<SendOptions, 'route' | 'pieces'>): Minimum | null {
  if (!m) return null;
  const n = Math.max(1, o.pieces);
  const pieces = (perSwap: number | null) => (perSwap === null ? null : n > 1 ? n * m.pieceFactor * perSwap : perSwap);
  let min: number | null;
  let single: number | null;
  if (coin !== 'XMR' && o.route === 'monero') {
    // Into Monero first (FixedFloat's bigger minimum), then each piece out of Monero.
    const into = m[coin].intoMonero;
    const out = pieces(m.XMR.direct);
    min = into === null || out === null ? null : Math.max(into, out);
    single = into;
  } else {
    min = pieces(m[coin].direct);
    single = m[coin].direct;
  }
  if (min === null) return null;
  return { min: Math.round(min * 100) / 100, safe: roundUp(min * SAFETY), single: n > 1 && single !== null && single < min ? single : null };
}

const money = (usd: number) => `$${usd < 100 ? usd.toFixed(usd % 1 ? 2 : 0) : Math.round(usd)}`;
export { money as usdText };

/** FixedFloat's minimums, refreshed every couple of minutes while something shows them. */
export function useMinimums(): Minimums | null {
  const [m, setM] = useState<Minimums | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .minimums()
        .then((v) => alive && setM(v))
        .catch(() => {});
    load();
    const iv = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);
  return m;
}
