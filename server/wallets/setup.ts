import { setDeriver } from '../addresses.js';
import { btcAddress, btcWallet } from './btc.js';
import { ethAddress, ethWallet } from './eth.js';
import { registerWallet } from './index.js';
import { unlock, walletState } from './seed.js';

/** Unlocks the BTC/ETH seed (if WALLET_KEY and data/wallet.enc are there) and switches those wallets on. */
export function setupHotWallets(): ReturnType<typeof walletState> {
  const ready = unlock();
  registerWallet('BTC', () => (ready ? btcWallet : null));
  registerWallet('ETH', () => (ready ? ethWallet : null));
  setDeriver(ready ? (coin, index, chain = 0) => (coin === 'BTC' ? btcAddress(index, chain) : ethAddress(index)) : null);
  return walletState();
}
