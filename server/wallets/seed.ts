import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { config } from '../config.js';
import { slip10Ed25519 } from '../stash/ed25519.js';
import { readJson, writeJsonAtomic } from '../store.js';

/**
 * The BTC/ETH hot wallet seed: 24 BIP39 words, kept in data/wallet.enc encrypted with WALLET_KEY
 * (scrypt + AES-256-GCM). `npm run wallet:init` makes it and writes the words once to data/seed-backup.txt
 * for a paper backup; delete that file afterwards. The seed never leaves the server.
 */

interface EncFile {
  version: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  data: string;
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
export const walletFile = () => path.join(config.dataDir, 'wallet.enc');
export const backupFile = () => path.join(config.dataDir, 'seed-backup.txt');

const derive = (key: string, salt: Buffer, k: { N: number; r: number; p: number }) =>
  crypto.scryptSync(key, salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 256 * k.N * k.r });

export function encrypt(mnemonic: string, key: string): EncFile {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(key, salt, SCRYPT), iv);
  const data = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()]);
  return {
    version: 1,
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decrypt(enc: EncFile, key: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', derive(key, Buffer.from(enc.kdf.salt, 'base64'), enc.kdf), Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('WALLET_KEY does not unlock data/wallet.enc (wrong key, or the file was changed).');
  }
}

/** Creates the seed (or stores a given one). Refuses to overwrite an existing wallet. */
export function initWallet(key: string, mnemonic = generateMnemonic(wordlist, 256)): { mnemonic: string } {
  if (fs.existsSync(walletFile())) throw new Error(`${walletFile()} already exists. Refusing to replace a wallet that may hold money.`);
  if (key.length < 16) throw new Error('WALLET_KEY must be at least 16 characters (use a long random string).');
  const words = mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(words, wordlist)) throw new Error('That is not a valid BIP39 mnemonic.');
  writeJsonAtomic(walletFile(), encrypt(words, key));
  return { mnemonic: words };
}

let root: HDKey | null = null;
/** The BIP39 seed itself, for ed25519 (SLIP-10) keys, which BIP32 can't derive. */
let seedBytes: Uint8Array | null = null;
let unlockError: string | null = null;

/** Unlocks the seed with WALLET_KEY. Returns false (and the wallet stays off) when either is missing. */
export function unlock(): boolean {
  root = null;
  seedBytes = null;
  unlockError = null;
  const enc = readJson<EncFile>(walletFile());
  if (!enc || !config.walletKey) return false;
  try {
    seedBytes = mnemonicToSeedSync(decrypt(enc, config.walletKey));
    root = HDKey.fromMasterSeed(seedBytes);
    return true;
  } catch (e) {
    unlockError = (e as Error).message;
    return false;
  }
}

export const walletState = () => ({
  ready: root !== null,
  exists: fs.existsSync(walletFile()),
  /** The words are still lying in data/seed-backup.txt: write them down, then delete it. */
  backupPending: fs.existsSync(backupFile()),
  error: unlockError,
});

/** A child key; only the wallet modules use it. */
export function keyAt(derivationPath: string): HDKey {
  if (!root) throw new Error('The hot wallet is locked (WALLET_KEY).');
  const k = root.derive(derivationPath);
  if (!k.privateKey || !k.publicKey) throw new Error('Key derivation failed.');
  return k;
}

/** An ed25519 private key (SLIP-10, hardened steps only), for Solana; only the wallet modules use it. */
export function ed25519KeyAt(derivationPath: string): Uint8Array {
  if (!seedBytes) throw new Error('The hot wallet is locked (WALLET_KEY).');
  return slip10Ed25519(seedBytes, derivationPath).key;
}

/** Tests: forget the unlocked seed. */
export function lock(): void {
  root = null;
  seedBytes = null;
}
