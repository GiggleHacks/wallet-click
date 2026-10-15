import crypto from 'node:crypto';
import path from 'node:path';
import { config, isChecksumAddress } from './config.js';
import { UserError } from './errors.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * The address book: USDT (ERC-20) addresses that swaps may pay out to. "Coinbase" (PAYOUT_ADDRESS) is
 * built in. Adding or removing one needs the password (checked by the route), and a destination that a
 * permanent address points at can't be removed, so a saved phone-wallet address always lands where it did.
 */

export interface Destination {
  id: string;
  label: string;
  address: string;
  createdAt: number;
  builtIn?: boolean;
}

interface DestinationsFile {
  version: 1;
  destinations: Destination[];
}

export const COINBASE_ID = 'coinbase';
const MAX = 50;

const file = () => path.join(config.dataDir, 'destinations.json');
let cache: DestinationsFile | null = null;

function load(): DestinationsFile {
  cache ??= readJson<DestinationsFile>(file()) ?? { version: 1, destinations: [] };
  return cache;
}

const builtIn = (): Destination => ({ id: COINBASE_ID, label: config.payout.label, address: config.payout.address, createdAt: 0, builtIn: true });

export const destinations = {
  list: (): Destination[] => [builtIn(), ...load().destinations],

  get(id: string | undefined | null): Destination | null {
    if (!id || id === COINBASE_ID) return builtIn();
    return load().destinations.find((d) => d.id === id) ?? null;
  },

  /** The destination an order or permanent address will pay out to; refuses unknown ids. */
  need(id: string | undefined | null): Destination {
    const d = destinations.get(id);
    if (!d) throw new UserError("That destination isn't in your address book any more.");
    return d;
  },

  add(label: string, address: string, now = Date.now()): Destination {
    const name = label.trim().replace(/\s+/g, ' ');
    const addr = address.trim();
    if (!name || name.length > 40) throw new UserError('Give it a name of up to 40 characters.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new UserError("That isn't an Ethereum (ERC-20) address. It should start with 0x and have 40 more characters.");
    if (!isChecksumAddress(addr)) {
      throw new UserError(
        "That address has no valid checksum (the mix of upper- and lower-case letters), so a typo couldn't be caught. Copy it again from the exchange's USDT deposit page.",
      );
    }
    const all = destinations.list();
    const same = all.find((d) => d.address.toLowerCase() === addr.toLowerCase());
    if (same) throw new UserError(`That address is already saved as "${same.label}".`);
    if (all.some((d) => d.label.toLowerCase() === name.toLowerCase())) throw new UserError(`There's already a destination called "${name}".`);
    if (load().destinations.length >= MAX) throw new UserError(`The address book holds up to ${MAX} destinations.`);
    const d: Destination = { id: `d_${crypto.randomBytes(5).toString('hex')}`, label: name, address: addr, createdAt: now };
    load().destinations.push(d);
    writeJsonAtomic(file(), load());
    return d;
  },

  /** `usedBy` names whatever still pays out here (a permanent address, a transfer in progress), or null. */
  remove(id: string, usedBy: (id: string) => string | null = () => null): void {
    if (id === COINBASE_ID) throw new UserError(`${config.payout.label} is built in and can't be removed.`);
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
