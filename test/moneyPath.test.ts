import { describe, expect, it } from 'vitest';
import { compareGrid, estimate, estimateTxs } from '../web/src/lib/fees.js';
import { momentsOf, moneyPath, spotsAt, type PathOptions } from '../web/src/lib/moneyPath.js';
import type { Fees } from '../web/src/types.js';

const H = 3_600_000;
const base: PathOptions = { coin: 'BTC', route: 'direct', delayHours: 0, pieces: 1, entry: 'button' };
const kinds = (o: Partial<PathOptions>) => moneyPath({ ...base, ...o }).columns.map((c) => `${c.kind}${c.lanes ? '*' : ''}:${c.holder}`);
/** When piece `lane` first starts moving toward FixedFloat's swap out (its turn). */
const turn = (o: Partial<PathOptions>, lane: number) => {
  const p = moneyPath({ ...base, ...o });
  const swapOut = p.columns.length - 2;
  return p.legs.find((l) => l.lane === lane && l.to === swapOut && l.kind === 'travel')!.start;
};

describe('where the money goes', () => {
  it('a plain coin button: straight to FixedFloat, the server never holds it', () => {
    expect(kinds({})).toEqual(['wallet:you', 'swap:fixedfloat', 'dest:exchange']);
    expect(moneyPath(base).txs).toEqual([{ kind: 'swap', from: 'BTC', to: 'USDC', share: 1 }]);
  });

  it('straight with a wait: held at a one-time address on the server, then forwarded', () => {
    expect(kinds({ delayHours: 24 })).toEqual(['wallet:you', 'address:server', 'swap:fixedfloat', 'dest:exchange']);
    expect(turn({ delayHours: 24 }, 0)).toBeGreaterThanOrEqual(24 * H);
  });

  it('Bitcoin in pieces: one split to a fresh change address per piece, each forwarded on its own', () => {
    const p = moneyPath({ ...base, pieces: 3 });
    expect(kinds({ pieces: 3 })).toEqual(['wallet:you', 'address:server', 'address*:server', 'swap*:fixedfloat', 'dest:exchange']);
    expect(p.txs).toContainEqual({ kind: 'split', coin: 'BTC', pieces: 3 });
    expect(p.txs).toContainEqual({ kind: 'forward', coin: 'BTC', count: 3 });
    expect(p.shares).toHaveLength(3);
    expect(p.shares.reduce((s, v) => s + v, 0)).toBeCloseTo(1);
  });

  it('Ethereum in pieces: no split, each share leaves the same address in turn, 5 min–2 h after the one before landed', () => {
    expect(kinds({ coin: 'ETH', pieces: 4, delayHours: 4 })).toEqual(['wallet:you', 'address:server', 'swap*:fixedfloat', 'dest:exchange']);
    const p = moneyPath({ ...base, coin: 'ETH', pieces: 4, delayHours: 4 });
    expect(p.txs.some((t) => t.kind === 'split')).toBe(false);
    for (let k = 1; k < 4; k++) {
      const landed = Math.max(...p.legs.filter((l) => l.lane === k - 1).map((l) => l.end));
      const gap = turn({ coin: 'ETH', pieces: 4, delayHours: 4 }, k) - landed;
      expect(gap).toBeGreaterThanOrEqual(5 * 60_000);
      expect(gap).toBeLessThanOrEqual(2 * H);
    }
  });

  it('a permanent address always lands on the server first', () => {
    expect(kinds({ entry: 'permanent' })).toEqual(['wallet:you', 'address:server', 'swap:fixedfloat', 'dest:exchange']);
  });

  it('ETH through Monero, 4 h, 4 pieces: FixedFloat in, one vault, four subaddresses, four swaps out', () => {
    const o = { coin: 'ETH' as const, route: 'monero' as const, delayHours: 4, pieces: 4 };
    expect(kinds(o)).toEqual(['wallet:you', 'swap:fixedfloat', 'vault:server', 'vault*:server', 'swap*:fixedfloat', 'dest:exchange']);
    const p = moneyPath({ ...base, ...o });
    expect(p.txs.filter((t) => t.kind === 'swap')).toHaveLength(5);
    // The split, each piece's own move, and each send to FixedFloat.
    expect(p.txs).toContainEqual({ kind: 'xmr', count: 9 });
    expect(p.legs.filter((l) => l.kind === 'hop')).toHaveLength(4);
    // The wait counts from when it unlocked.
    const unlocked = p.legs.find((l) => l.caption.startsWith('The XMR unlocks'))!.end;
    expect(turn(o, 0) - unlocked).toBeGreaterThanOrEqual(4 * H);
  });

  it('a Monero payment with a wait: its own subaddress is the vault, no swap in', () => {
    expect(kinds({ coin: 'XMR', delayHours: 12 })).toEqual(['wallet:you', 'vault:server', 'vault:server', 'swap:fixedfloat', 'dest:exchange']);
    expect(kinds({ coin: 'XMR', route: 'monero' })).toEqual(['wallet:you', 'swap:fixedfloat', 'dest:exchange']);
  });

  it('can say where every piece is at any moment', () => {
    const p = moneyPath({ ...base, coin: 'ETH', route: 'monero', delayHours: 4, pieces: 2 });
    expect(spotsAt(p, 0).map((s) => s.leg.from)).toEqual([0, 0]);
    expect(spotsAt(p, p.end).every((s) => s.leg.to === p.columns.length - 1 && s.progress === 1)).toBe(true);
    const m = momentsOf(p);
    expect(m[0].at).toBe(0);
    expect(m.at(-1)!.at).toBe(p.end);
  });
});

const live: Fees = {
  swap: { BTC: { usdc: 0.8, xmr: 0.9 }, ETH: { usdc: 0.7, xmr: 0.9 }, XMR: { usdc: 0.6, xmr: null } },
  network: { BTC: { forward: 0.5, split: 0.25, splitPiece: 0.12 }, ETH: { forward: 0.3 }, XMR: { tx: 0.02 } },
  at: 0,
};

describe('what it costs', () => {
  it('a plain swap costs FixedFloat’s cut', () => {
    const e = estimate(base, live, 500);
    expect(e.pct).toBeCloseTo(0.8);
    expect(e.usd).toBeCloseTo(4);
    expect(e.typical).toBe(false);
  });

  it('pieces add network fees; Monero adds a second swap', () => {
    const one = estimate({ ...base, delayHours: 4 }, live, 500).usd;
    const four = estimate({ ...base, delayHours: 4, pieces: 4 }, live, 500).usd;
    // The swap then takes its cut of slightly less.
    expect(four - one).toBeCloseTo(3 * 0.5 + 0.25 + 4 * 0.12, 1);
    const monero = estimate({ ...base, route: 'monero' }, live, 500);
    expect(monero.pct).toBeGreaterThan(estimate(base, live, 500).pct + 0.5);
    expect(monero.lines.map((l) => l.label)).toEqual(['FixedFloat swap BTC → XMR', 'Moves in your Monero wallet (Monero fee)', 'FixedFloat swap XMR → USDC']);
  });

  it('falls back to typical numbers, and says so', () => {
    const e = estimateTxs([{ kind: 'swap', from: 'BTC', to: 'USDC', share: 1 }], null, 1000);
    expect(e).toMatchObject({ pct: 1, typical: true });
  });

  it('compares every route and number of pieces', () => {
    const g = compareGrid({ ...base, coin: 'ETH' }, live, 500);
    expect(g.map((r) => r.route)).toEqual(['direct', 'monero']);
    expect(g[0].pcts[3]).toBeGreaterThan(g[0].pcts[0]);
    expect(g[1].pcts[0]).toBeGreaterThan(g[0].pcts[0]);
    expect(compareGrid({ ...base, coin: 'XMR' }, live, 500)).toHaveLength(1);
  });
});
