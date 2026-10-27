import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';

/**
 * SLIP-10 for ed25519 (the scheme Solana wallets use: Phantom, Solflare, Ledger). ed25519 only has hardened
 * children, so every step of the path must end in '. BIP32 (secp256k1) can't do this, hence its own few lines.
 */

const HARDENED = 0x80000000;

export function slip10Ed25519(seed: Uint8Array, path: string): { key: Uint8Array; chainCode: Uint8Array } {
  const steps = path.split('/');
  if (steps[0] !== 'm') throw new Error(`Not a derivation path: ${path}`);
  let I = hmac(sha512, utf8ToBytes('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);
  for (const step of steps.slice(1)) {
    const m = /^(\d+)'$/.exec(step);
    if (!m) throw new Error(`ed25519 paths are hardened only: "${step}" in ${path}`);
    const index = Number(m[1]) + HARDENED;
    const data = new Uint8Array(37);
    data.set(key, 1); // 0x00 || key || index (big-endian)
    new DataView(data.buffer).setUint32(33, index >>> 0, false);
    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }
  return { key, chainCode };
}

export const ed25519Public = (privateKey: Uint8Array) => ed25519.getPublicKey(privateKey);
export const ed25519Sign = (message: Uint8Array, privateKey: Uint8Array) => ed25519.sign(message, privateKey);

/** A Solana address is just the public key in base58. */
export const solAddressOf = (privateKey: Uint8Array) => base58.encode(ed25519Public(privateKey));
