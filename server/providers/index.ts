import { config } from '../config.js';
import { cyphergoat } from './cyphergoat.js';
import { swapzone } from './swapzone.js';
import type { FallbackProvider, ProviderId } from './types.js';

export { SwapApiError } from './types.js';
export type { CreatedSwap, FallbackProvider, ProviderId } from './types.js';

const ALL: Record<ProviderId, FallbackProvider> = { swapzone, cyphergoat };

/** A provider by id (also one that has since lost its key, so that its old orders can still be followed). */
export const providerById = (id: ProviderId): FallbackProvider => ALL[id];

/**
 * The fallbacks to try, in the order SWAP_FALLBACKS lists them: named there and with a key. `walletPaid`: our own
 * wallet pays the order, so only providers that take a refund address qualify.
 */
export function fallbacks(opts: { walletPaid?: boolean } = {}): FallbackProvider[] {
  return (config.swapFallbacks as ProviderId[]).map(providerById).filter((p) => p.configured() && (!opts.walletPaid || p.supportsRefundAddress));
}

/** One line for the start-up log. */
export function fallbackSummary(): string {
  const named = config.swapFallbacks as ProviderId[];
  if (!named.length) return 'none (FixedFloat only)';
  return named.map((id) => `${ALL[id].label}${ALL[id].configured() ? '' : ' (no API key: skipped)'}`).join(', ');
}
