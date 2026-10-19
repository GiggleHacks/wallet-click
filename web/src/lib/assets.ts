import type { Destination, Stable } from '../types';

/**
 * What a destination is paid in: USDT on Ethereum, or USDC on Base. The codes are FixedFloat's own ("USDCBASE"),
 * which is what the server sends; an older server or record that names none means USDT.
 */
export const symbolOf = (ccy?: string | null) => (ccy === 'USDCBASE' ? 'USDC' : ccy === 'XMR' ? 'XMR' : 'USDT');
/** "USDT on Ethereum", "USDC on Base". */
export const assetName = (ccy?: string | null) => (ccy === 'USDCBASE' ? 'USDC on Base' : 'USDT on Ethereum');
export const networkOf = (ccy?: string | null) => (ccy === 'USDCBASE' ? 'Base' : 'Ethereum');
/** Coinbase's two built-in destinations get its logo. */
export const isCoinbaseId = (id?: string | null) => !id || id === 'coinbase' || id === 'coinbase-base';
/** A destination's name for a menu: the asset is added unless the name already says it. */
export const destName = (d: Pick<Destination, 'label' | 'ccy'>) => (d.ccy === 'USDCBASE' && !/usdc/i.test(d.label) ? `${d.label} (USDC on Base)` : d.label);
export type { Stable };
