import { config } from '../config.js';

/**
 * The coins the Wallet window can hold at a fresh address of its own. Every address comes from the same seed as the
 * hot wallet, but from derivation accounts nothing else uses (BTC account 2, ETH account 2, Litecoin, Solana), so a
 * Wallet address can never be one of the transfers' addresses. Monero uses its own wallet account.
 *
 * `ffCode` is FixedFloat's currency code (checked against its public rate list: BTC, LTC, ETH, ETHBASE, ETHARBITRUM,
 * ETHOP, POL, BSC (BNB on BNB Smart Chain), SOL, XMR). Anything else FixedFloat takes is a "long tail" coin: paid to a
 * FixedFloat address that swaps it into our Monero (see swap.ts).
 */

export type Kind = 'utxo' | 'evm' | 'sol' | 'xmr';

export interface Asset {
  id: AssetId;
  /** What it's called, and the network it's on ("Ethereum" on "Base"). */
  name: string;
  symbol: string;
  network: string;
  kind: Kind;
  ffCode: string;
  decimals: number;
  /** Confirmations before it counts as held (blocks; Solana: finalized). */
  confirmations: number;
  /** What a FixedFloat price probe asks about (a typical small payment). */
  probe: number;
  /** One line for whoever pays: the network matters. */
  warning: string;
  explorerTx: (h: string) => string;
  explorerAddress: (a: string) => string;
  /** EVM: chain id. UTXO: address prefixes. */
  chainId?: number;
  rpcUrls?: () => string[];
  /** OP Stack chains (Base, Optimism) charge an L1 data fee on top of gas. */
  opStack?: boolean;
  /** Pixel coin art colour. */
  color: string;
}

export const ASSET_IDS = ['BTC', 'LTC', 'ETH', 'ETH-BASE', 'ETH-ARB', 'ETH-OP', 'POL', 'BNB', 'SOL', 'XMR'] as const;
export type AssetId = (typeof ASSET_IDS)[number];

const evm = (over: Omit<Asset, 'kind' | 'decimals' | 'explorerTx' | 'explorerAddress'> & { explorer: string }): Asset => {
  const { explorer, ...rest } = over;
  return { ...rest, kind: 'evm', decimals: 18, explorerTx: (h) => `${explorer}/tx/${h}`, explorerAddress: (a) => `${explorer}/address/${a}` };
};

export const ASSETS: Record<AssetId, Asset> = {
  BTC: {
    id: 'BTC',
    name: 'Bitcoin',
    symbol: 'BTC',
    network: 'Bitcoin',
    kind: 'utxo',
    ffCode: 'BTC',
    decimals: 8,
    confirmations: 1,
    probe: 0.001,
    warning: 'Send only Bitcoin (BTC) on the Bitcoin network.',
    explorerTx: (h) => `https://mempool.space/tx/${h}`,
    explorerAddress: (a) => `https://mempool.space/address/${a}`,
    color: '#f7931a',
  },
  LTC: {
    id: 'LTC',
    name: 'Litecoin',
    symbol: 'LTC',
    network: 'Litecoin',
    kind: 'utxo',
    ffCode: 'LTC',
    decimals: 8,
    confirmations: 2,
    probe: 0.5,
    warning: 'Send only Litecoin (LTC) on the Litecoin network (not MWEB).',
    explorerTx: (h) => `https://litecoinspace.org/tx/${h}`,
    explorerAddress: (a) => `https://litecoinspace.org/address/${a}`,
    color: '#345d9d',
  },
  ETH: evm({
    id: 'ETH',
    name: 'Ethereum',
    symbol: 'ETH',
    network: 'Ethereum',
    ffCode: 'ETH',
    confirmations: 12,
    probe: 0.02,
    warning: 'Send only ETH on Ethereum mainnet. Not a token, not another network.',
    explorer: 'https://etherscan.io',
    chainId: 1,
    rpcUrls: () => config.chains.ethRpcUrls,
    color: '#627eea',
  }),
  'ETH-BASE': evm({
    id: 'ETH-BASE',
    name: 'Ethereum',
    symbol: 'ETH',
    network: 'Base',
    ffCode: 'ETHBASE',
    confirmations: 10,
    probe: 0.02,
    warning: 'Send only ETH on the Base network. Not a token, not Ethereum mainnet.',
    explorer: 'https://basescan.org',
    chainId: 8453,
    rpcUrls: () => config.stash.baseRpcUrls,
    opStack: true,
    color: '#0052ff',
  }),
  'ETH-ARB': evm({
    id: 'ETH-ARB',
    name: 'Ethereum',
    symbol: 'ETH',
    network: 'Arbitrum',
    ffCode: 'ETHARBITRUM',
    confirmations: 20,
    probe: 0.02,
    warning: 'Send only ETH on Arbitrum One. Not a token, not Ethereum mainnet.',
    explorer: 'https://arbiscan.io',
    chainId: 42161,
    rpcUrls: () => config.stash.arbRpcUrls,
    color: '#28a0f0',
  }),
  'ETH-OP': evm({
    id: 'ETH-OP',
    name: 'Ethereum',
    symbol: 'ETH',
    network: 'Optimism',
    ffCode: 'ETHOP',
    confirmations: 10,
    probe: 0.02,
    warning: 'Send only ETH on OP Mainnet (Optimism). Not a token, not Ethereum mainnet.',
    explorer: 'https://optimistic.etherscan.io',
    chainId: 10,
    rpcUrls: () => config.stash.opRpcUrls,
    opStack: true,
    color: '#ff0420',
  }),
  POL: evm({
    id: 'POL',
    name: 'Polygon',
    symbol: 'POL',
    network: 'Polygon',
    ffCode: 'POL',
    confirmations: 64,
    probe: 100,
    warning: 'Send only POL on the Polygon network. Not a token, not POL on Ethereum.',
    explorer: 'https://polygonscan.com',
    chainId: 137,
    rpcUrls: () => config.stash.polygonRpcUrls,
    color: '#8247e5',
  }),
  BNB: evm({
    id: 'BNB',
    name: 'BNB',
    symbol: 'BNB',
    network: 'BNB Smart Chain',
    ffCode: 'BSC',
    confirmations: 15,
    probe: 0.05,
    warning: 'Send only BNB on BNB Smart Chain (BEP-20 network). Not a token, not opBNB.',
    explorer: 'https://bscscan.com',
    chainId: 56,
    rpcUrls: () => config.stash.bscRpcUrls,
    color: '#f0b90b',
  }),
  SOL: {
    id: 'SOL',
    name: 'Solana',
    symbol: 'SOL',
    network: 'Solana',
    kind: 'sol',
    ffCode: 'SOL',
    decimals: 9,
    confirmations: 1,
    probe: 0.2,
    warning: 'Send only SOL on Solana, at least 0.001 SOL. Not USDC, USDT or another token.',
    explorerTx: (h) => `https://solscan.io/tx/${h}`,
    explorerAddress: (a) => `https://solscan.io/account/${a}`,
    rpcUrls: () => config.stash.solRpcUrls,
    color: '#9945ff',
  },
  XMR: {
    id: 'XMR',
    name: 'Monero',
    symbol: 'XMR',
    network: 'Monero',
    kind: 'xmr',
    ffCode: 'XMR',
    decimals: 12,
    confirmations: 10,
    probe: 0.1,
    warning: 'Send only Monero (XMR).',
    explorerTx: (h) => `https://xmrchain.net/tx/${h}`,
    explorerAddress: () => '',
    color: '#ff6600',
  },
};

export const isAssetId = (v: string): v is AssetId => (ASSET_IDS as readonly string[]).includes(v);

/** A link that opens a wallet app with the address filled in. */
export function payUri(a: Asset, address: string): string {
  switch (a.kind) {
    case 'evm':
      return `ethereum:${address}@${a.chainId}`; // EIP-681: the chain id keeps it on the right network
    case 'sol':
      return `solana:${address}`;
    case 'xmr':
      return `monero:${address}`;
    default:
      return `${a.id === 'LTC' ? 'litecoin' : 'bitcoin'}:${address}`;
  }
}

/** Derivation paths: accounts no other part of Wallet Click uses. */
export const stashPath = (a: Asset, index: number): string => {
  switch (a.kind) {
    case 'utxo':
      return a.id === 'LTC' ? `m/84'/2'/0'/0/${index}` : `m/84'/0'/2'/0/${index}`;
    case 'evm':
      return `m/44'/60'/2'/0/${index}`;
    case 'sol':
      return `m/44'/501'/${index}'/0'`;
    default:
      throw new Error(`${a.id} addresses come from the Monero wallet.`);
  }
};

/** Which counter an asset draws its index from. All EVM chains share one, so an address is only ever used on one chain. */
export const counterOf = (a: Asset): string => (a.kind === 'evm' ? 'EVM' : a.id);
