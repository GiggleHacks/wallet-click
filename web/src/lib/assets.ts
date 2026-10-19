import type { Destination, Stable } from '../types';

/**
 * What a destination is paid in: USDC on Base now. Older payments, still on the desktop list, were USDT on
 * Ethereum: the server names those ("USDT") explicitly. The codes are FixedFloat's own ("USDCBASE"). Nothing named
 * means USDC on Base.
 */
export const symbolOf = (ccy?: string | null) => (ccy === 'USDT' ? 'USDT' : ccy === 'XMR' ? 'XMR' : 'USDC');
/** "USDC on Base" (or, for an older payment, "USDT on Ethereum"). */
export const assetName = (ccy?: string | null) => (ccy === 'USDT' ? 'USDT on Ethereum' : 'USDC on Base');
export const networkOf = (ccy?: string | null) => (ccy === 'USDT' ? 'Ethereum' : 'Base');
/** Coinbase's two built-in destinations get its logo. */
export const isCoinbaseId = (id?: string | null) => !id || id === 'coinbase' || id === 'coinbase-base';
/** The built-in destination (the old built-in USDT one was "coinbase"; the server maps that to this). */
export const DEFAULT_DESTINATION = 'coinbase-base';
/** A destination's name for a menu: the asset is added unless the name already says it. */
export const destName = (d: Pick<Destination, 'label' | 'ccy'>) => (d.ccy === 'USDCBASE' && !/usdc/i.test(d.label) ? `${d.label} (USDC on Base)` : d.label);
export type { Stable };
