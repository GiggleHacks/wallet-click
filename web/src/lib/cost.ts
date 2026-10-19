import type { Cost } from '../types';
import { usdt } from './format';

const money = (v: number) => `${v < 0 ? '−' : ''}$${usdt(String(Math.abs(v)))}`;

/** What a done swap cost, e.g. "Swap cost ≈ $2.14 (1.7%)". */
export function costText(c: Cost): string {
  const pct = `${c.pct < 0 ? '−' : ''}${Math.abs(c.pct).toFixed(1)}%`;
  return `Swap cost ≈ ${money(c.usd)} (${pct})${c.usd < 0 ? ': the price rose while it swapped' : ''}`;
}

export const COST_HELP = "FixedFloat's cut plus network fees: the dollar value of what was paid in, when the swap ran, minus what arrived (USDT or USDC).";

/** Privacy Enhanced: how much the Monero price moved during the wait (not a cost, so it's shown apart). */
export function driftText(c: Cost): string | null {
  if (c.drift === undefined || Math.abs(c.drift) < 0.01) return null;
  return `Monero price moved ${c.drift > 0 ? '+' : ''}${money(c.drift)} while waiting`;
}
