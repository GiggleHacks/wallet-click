import fs from 'node:fs';
import { config } from '../config.js';
import { btcAddress } from '../wallets/btc.js';
import { ethAddress } from '../wallets/eth.js';
import { backupFile, initWallet, unlock, walletFile } from '../wallets/seed.js';

/**
 * Creates the BTC/ETH hot wallet seed: `npm run wallet:init` (or, in Docker,
 * `docker compose exec wallet-click node dist/server/cli/wallet-init.js`).
 *
 * The 24 words are written once to data/seed-backup.txt (readable only by this user), not printed, so they don't
 * end up in terminal scrollback or logs. Copy them onto paper, then delete the file. To restore an existing seed
 * instead, pipe its words in: `echo "word1 … word24" | … wallet-init.js --restore`.
 */

const key = config.walletKey;
if (!key) {
  console.error('Set WALLET_KEY (a long random string, e.g. `openssl rand -hex 32`) in .env first.');
  process.exit(1);
}

try {
  const restore = process.argv.includes('--restore');
  const words = restore ? fs.readFileSync(0, 'utf8') : undefined;
  const { mnemonic } = initWallet(key, words);
  if (!restore) {
    fs.writeFileSync(
      backupFile(),
      [
        'Wallet Click hot wallet seed (BIP39, 24 words). Write these down on paper, keep them safe, then DELETE this file.',
        'Anyone with these words can spend whatever is in the hot wallet.',
        '',
        mnemonic,
        '',
        "Derivation: Bitcoin m/84'/0'/0'/0/i (native segwit), Ethereum m/44'/60'/0'/0/i.",
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  }
  unlock();
  console.log(`Hot wallet created: ${walletFile()}`);
  if (!restore) console.log(`The 24 words are in ${backupFile()}. Copy them onto paper, then delete that file.`);
  console.log(`First addresses (for checking a restore): BTC ${btcAddress(0)}  ETH ${ethAddress(0)}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
