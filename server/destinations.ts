import crypto from 'node:crypto';
import path from 'node:path';
import { PAYOUTS, STABLES, config, isChecksumAddress, type Stable } from './config.js';
import { UserError } from './errors.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * The address book: the addresses swaps may pay out to, each for one asset: USDT on Ethereum (ERC-20) or USDC on
 * Base. "Coinbase" (PAYOUT_ADDRESS, USDT) and "Coinbase (USDC on Base)" (PAYOUT_ADDRESS_USDC_BASE) are built in.
 * Adding or removing one needs the password (checked by the route), and a destination that a permanent address
 * points at can't be removed, so a saved phone-wallet address always lands where it did.
 */

export interface Destination {
  id: string;
  label: string;
  address: string;
  /** What it pays out: FixedFloat's currency code (older entries: USDT). */
  ccy: Stable;
  createdAt: number;
  builtIn?: boolean;
}

interface DestinationsFile {
  version: 1;
  destinations: Destination[];
}

export const COINBASE_ID = 'coinbase';
export const COINBASE_BASE_ID = 'coinbase-base';
const BUILT_IN = new Set([COINBASE_ID, COINBASE_BASE_ID]);
const MAX = 50;

const file = () => path.join(config.dataDir, 'destinations.json');
let cache: DestinationsFile | null = null;

function load(): DestinationsFile {
  if (!cache) {
    cache = readJson<DestinationsFile>(file()) ?? { version: 1, destinations: [] };
    for (const d of cache.destinations) d.ccy ??= 'USDT'; // older entries predate USDC on Base
  }
  return cache;
}

const builtIns = (): Destination[] => [
  { id: COINBASE_ID, label: config.payout.label, address: config.payout.address, ccy: 'USDT', createdAt: 0, builtIn: true },
  { id: COINBASE_BASE_ID, label: config.payoutBase.label, address: config.payoutBase.address, ccy: config.payoutBase.ccy, createdAt: 0, builtIn: true },
];

export const destinations = {
  list: (): Destination[] => [...builtIns(), ...load().destinations],

  get(id: string | undefined | null): Destination | null {
    if (!id) return builtIns()[0];
    return builtIns().find((d) => d.id === id) ?? load().destinations.find((d) => d.id === id) ?? null;
  },

  /** The destination an order or permanent address will pay out to; refuses unknown ids. */
  need(id: string | undefined | null): Destination {
    const d = destinations.get(id);
    if (!d) throw new UserError("That destination isn't in your address book any more.");
    return d;
  },

  add(label: string, address: string, ccy: Stable = 'USDT', now = Date.now()): Destination {
    const name = label.trim().replace(/\s+/g, ' ');
    const addr = address.trim();
    if (!STABLES.includes(ccy)) throw new UserError('Pick USDT on Ethereum or USDC on Base.');
    const asset = PAYOUTS[ccy].label;
    if (!name || name.length > 40) throw new UserError('Give it a name of up to 40 characters.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new UserError(`That isn't an Ethereum-style address for ${asset}. It should start with 0x and have 40 more characters.`);
    if (!isChecksumAddress(addr)) {
      throw new UserError(
        `That address has no valid checksum (the mix of upper- and lower-case letters), so a typo couldn't be caught. Copy it again from the exchange's ${asset} deposit page.`,
      );
    }
    const all = destinations.list();
    // The same address may be saved once for each asset: an exchange can use one address on several networks.
    const same = all.find((d) => d.ccy === ccy && d.address.toLowerCase() === addr.toLowerCase());
    if (same) throw new UserError(`That address is already saved as "${same.label}".`);
    if (all.some((d) => d.label.toLowerCase() === name.toLowerCase())) throw new UserError(`There's already a destination called "${name}".`);
    if (load().destinations.length >= MAX) throw new UserError(`The address book holds up to ${MAX} destinations.`);
    const d: Destination = { id: `d_${crypto.randomBytes(5).toString('hex')}`, label: name, address: addr, ccy, createdAt: now };
    load().destinations.push(d);
    writeJsonAtomic(file(), load());
    return d;
  },

  /** `usedBy` names whatever still pays out here (a permanent address, a transfer in progress), or null. */
  remove(id: string, usedBy: (id: string) => string | null = () => null): void {
    const fixed = builtIns().find((d) => d.id === id);
    if (fixed || BUILT_IN.has(id)) throw new UserError(`${fixed?.label ?? 'That destination'} is built in and can't be removed.`);
    const list = load().destinations;
    const i = list.findIndex((d) => d.id === id);
    if (i < 0) throw new UserError('That destination is already gone.');
    const user = usedBy(id);
    if (user) throw new UserError(`${user} pays out here, so it can't be removed.`);
    list.splice(i, 1);
    writeJsonAtomic(file(), load());
  },

  /** Drops the in-memory copy (tests). */
  reset(): void {
    cache = null;
  },
};
