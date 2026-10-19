import { useSyncExternalStore } from 'react';
import type { Coin } from '../types';
import { getChoice, setChoice } from './prefs';

/**
 * How the coin buttons send what comes in: straight to USDT or through Monero, an optional wait first, and in one
 * piece or several. Remembered in this browser; a permanent address keeps its own copy.
 */
export interface SendOptions {
  route: 'direct' | 'monero';
  delayHours: number;
  pieces: number;
}

export const DEFAULT_OPTIONS: SendOptions = { route: 'direct', delayHours: 0, pieces: 1 };
const KEY = 'sendOptions';

function read(): SendOptions {
  try {
    const v = JSON.parse(getChoice(KEY) ?? 'null') as Partial<SendOptions> | null;
    if (!v) return DEFAULT_OPTIONS;
    return {
      route: v.route === 'monero' ? 'monero' : 'direct',
      delayHours: Number.isInteger(v.delayHours) && v.delayHours! >= 0 ? v.delayHours! : 0,
      pieces: Number.isInteger(v.pieces) && v.pieces! >= 1 && v.pieces! <= 4 ? v.pieces! : 1,
    };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

let cached: { raw: string | null; value: SendOptions } | null = null;
/** The same object until it changes (useSyncExternalStore needs that). */
export function getSendOptions(): SendOptions {
  const raw = getChoice(KEY);
  if (!cached || cached.raw !== raw) cached = { raw, value: read() };
  return cached.value;
}

export function saveSendOptions(o: SendOptions): void {
  setChoice(KEY, JSON.stringify(o));
  window.dispatchEvent(new Event('wc:prefs'));
}

const subscribe = (cb: () => void) => {
  window.addEventListener('wc:prefs', cb);
  return () => window.removeEventListener('wc:prefs', cb);
};
export const useSendOptions = () => useSyncExternalStore(subscribe, getSendOptions);

/** Monero is private already: "through Monero" only changes what happens to Bitcoin and Ethereum. */
export const throughMonero = (o: SendOptions, coin: Coin) => o.route === 'monero' && coin !== 'XMR';

export const waitText = (h: number) => (h ? `wait ${h} h` : 'no wait');
export const piecesText = (n: number) => (n > 1 ? `${n} pieces` : '1 piece');

/** "Through Monero · wait 4 h · 4 pieces". */
export function optionsSummary(o: SendOptions, sym = 'USDT'): string {
  const route = o.route === 'monero' ? 'Through Monero' : `Straight to ${sym}`;
  return `${route} · ${waitText(o.delayHours)} · ${piecesText(o.pieces)}`;
}

/** The small line under a coin button. */
export function coinSub(o: SendOptions, coin: Coin): string {
  const extra = [o.delayHours ? `${o.delayHours} h` : '', o.pieces > 1 ? `${o.pieces} pieces` : ''].filter(Boolean);
  if (throughMonero(o, coin)) return ['Private', ...extra].join(' · ');
  return extra.length ? `${coin} · ${extra.join(' · ')}` : `New ${coin} address`;
}

/** Whether the coin button hands out a plain FixedFloat address (nothing held, nothing split). */
export const plainAddress = (o: SendOptions, coin: Coin) => !throughMonero(o, coin) && !o.delayHours && o.pieces === 1;
