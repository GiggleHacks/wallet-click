import type { Coin, PayoutCcy } from '../config.js';
import type { FfOrder } from '../fixedfloat.js';

/**
 * Swap providers other than FixedFloat. FixedFloat stays the primary and is used exactly as before; these are only
 * tried when it can't take an order (down, paused, out of reserves) and only if listed in SWAP_FALLBACKS with a key.
 * Each one turns its own order into FixedFloat's shape (`FfOrder`), so the rest of the engine doesn't care which it is.
 */
export type ProviderId = 'swapzone' | 'cyphergoat';

/** A swap service answered with an error, or couldn't be reached. `code` is the HTTP status (or FixedFloat's own code). */
export class SwapApiError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

/** What a pair allows right now, as one provider says. */
export interface RawLimits {
  min: number;
  max: number;
  usdPerCoin: number | null;
  outPerCoin: number | null;
  precision: number;
  /** The exchange that quoted it (the aggregator picks among several). */
  exchange: string;
}

export interface CreateRequest {
  from: Coin;
  to: PayoutCcy;
  amount: number;
  toAddress: string;
  /** Where a failed swap's coins go back to: only set when our own wallet pays. */
  refundAddress?: string;
  /** Exchanges not to use (the one that did the other leg of this transfer). */
  avoid?: string[];
}

export interface CreatedSwap {
  /** The provider's own id for the order. */
  nativeId: string;
  /** Access token, if the provider has one (stays on the server). */
  token: string;
  /** Which exchange does the swap. */
  exchange: string;
  /** The order in FixedFloat's shape, built from what the provider answered (never from what we asked for). */
  order: FfOrder;
}

export interface FallbackProvider {
  id: ProviderId;
  label: string;
  /** Prefix of our order ids for it, so they can never clash with FixedFloat's. */
  idPrefix: string;
  /** Takes a refund address with the order, so it may be used when our own wallet pays. */
  supportsRefundAddress: boolean;
  configured(): boolean;
  limits(from: Coin, to: PayoutCcy, probe: number, avoid?: string[]): Promise<RawLimits>;
  create(req: CreateRequest): Promise<CreatedSwap>;
  order(nativeId: string): Promise<FfOrder>;
}
