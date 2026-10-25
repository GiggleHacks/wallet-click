import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimeLapse } from '../components/JourneyDialog';
import type { Coin, Cost, Order, Transfer, TransferStep } from '../types';
import { sfx } from './sound';

/**
 * "How it works": a preview of exactly what you see and hear when money arrives, with the real windows,
 * animations and sounds, and pretend coins. Nothing touches the server.
 *  - a coin: click → fresh address → payment → swap → Coinbase;
 *  - Privacy Enhanced: … → swap to Monero → vault → shuffle → a day's wait as a time-lapse → swap to USDC → Coinbase;
 *  - a permanent address: money lands at your saved address → forward → swap (→ the vault…) → Coinbase.
 */

export type DemoKind = Coin | 'privacy' | 'route' | 'route-privacy';
type Flavor = 'privacy' | 'route' | 'route-privacy';
export const DEMO_ID = 'DEMO';
export const DEMO_TRANSFER = 'DEMO-T';
const DEMO_ROUTE = 'DEMO-R';
const ROUTE_LABEL: Record<Flavor, string> = { privacy: '', route: 'Phone → Coinbase', 'route-privacy': 'Private → Coinbase' };
/** Deliberately not a valid address, so nobody can pay it by scanning the demo QR code. */
export const DEMO_ADDRESS = 'DEMO-not-a-real-address';

const SCRIPT: Record<Coin, { amount: string; usdt: string; req: number; min: string; minUsd: number; cost: Cost }> = {
  ETH: { amount: '0.05', usdt: '126.84', req: 4, min: '0.005', minUsd: 12.72, cost: { usd: 1.37, pct: 1.1, inUsd: 128.21 } },
  BTC: { amount: '0.0015', usdt: '125.37', req: 2, min: '0.0001243', minUsd: 10.42, cost: { usd: 1.33, pct: 1.0, inUsd: 126.7 } },
  XMR: { amount: '0.23', usdt: '124.18', req: 20, min: '0.0184', minUsd: 9.97, cost: { usd: 1.3, pct: 1.0, inUsd: 125.48 } },
};
const NAMES: Record<Coin, [string, string, number]> = { BTC: ['Bitcoin', 'Bitcoin', 10], ETH: ['Ethereum', 'Ethereum mainnet', 0.2], XMR: ['Monero', 'Monero', 2] };

const H = 3_600_000;
/** The demo's 24-hour wait plays in this long. */
const LAPSE_MS = 8000;

export function demoOrder(coin: Coin): Order {
  const s = SCRIPT[coin];
  const now = Date.now();
  return {
    id: DEMO_ID,
    coin,
    coinName: NAMES[coin][0],
    network: NAMES[coin][1],
    address: DEMO_ADDRESS,
    createdAt: now,
    stage: 'waiting',
    status: 'NEW',
    min: s.min,
    max: null,
    minUsd: s.minUsd,
    watchDays: 30,
    expiresAt: now + 30 * 60_000,
    received: null,
    seenAt: null,
    confirmations: 0,
    requiredConfirmations: s.req,
    blockMinutes: NAMES[coin][2],
    depositTx: null,
    depositTxUrl: null,
    usdt: null,
    usdtFinal: false,
    payoutTx: null,
    payoutTxUrl: null,
    payoutAddress: '',
    refundTx: null,
    refundTxUrl: null,
    refundTo: null,
    refundSource: null,
    autoRefundError: null,
    refundRetry: null,
    emergency: null,
    autoContinued: false,
    autoError: null,
    reusedAddress: false,
    pollError: null,
    updatedAt: now,
  };
}

/** The step list a transfer window shows, for each kind of demo. */
function stepList(flavor: Flavor): [string, string][] {
  const head: [string, string][] =
    flavor === 'privacy'
      ? [['in', 'Bitcoin payment']]
      : [
          ['in', `Payment at "${ROUTE_LABEL[flavor]}"`],
          ['forward', 'Forward to FixedFloat'],
        ];
  const tail: [string, string][] =
    flavor === 'route'
      ? [
          ['swap1', 'Swap to USDC'],
          ['out', 'USDC to Coinbase'],
        ]
      : [
          ['swap1', 'Swap to Monero'],
          ['vault', 'Monero arrives and unlocks'],
          ['churn', 'Move within your wallet'],
          ['wait', 'Wait 24 hours'],
          ['swap2', 'Swap Monero to USDC'],
          ['out', 'USDC to Coinbase'],
        ];
  return [...head, ...tail];
}

/** The steps with everything before `active` done ('all': everything done). */
function stepsAt(flavor: Flavor, active: string, details: Record<string, string>): TransferStep[] {
  const list = stepList(flavor);
  const at = active === 'all' ? list.length : list.findIndex(([key]) => key === active);
  return list.map(([key, label], i) => ({ key, label, status: i < at ? 'done' : i === at ? 'active' : 'pending', detail: details[key] ?? null, link: null }));
}

export function demoTransfer(flavor: Flavor, leg1: Order, payoutAddress: string): Transfer {
  const now = Date.now();
  const route = flavor !== 'privacy';
  const privacy = flavor !== 'route';
  return {
    id: DEMO_TRANSFER,
    createdAt: now,
    coin: 'BTC',
    coinName: 'Bitcoin',
    privacy,
    delayHours: privacy ? 24 : null,
    routeId: route ? DEMO_ROUTE : null,
    routeLabel: route ? ROUTE_LABEL[flavor] : null,
    destinationId: 'coinbase-base',
    destinationLabel: 'Coinbase',
    payoutCcy: 'USDCBASE',
    destinationAddress: payoutAddress,
    state: route ? 'collect' : 'swap1',
    stage: 'waiting',
    received: null,
    usdt: null,
    payoutTxUrl: null,
    releaseAt: null,
    unlockedAt: null,
    xmr: null,
    xmrArrived: false,
    xmrConfirmations: 0,
    usdValue: null,
    steps: stepsAt(flavor, 'in', { in: 'Waiting for the payment' }),
    attention: null,
    error: null,
    waitingFor: null,
    canRelease: false,
    canChangeDelay: false,
    canRetry: false,
    leg1: route ? null : leg1,
    leg2: null,
    log: [],
    updatedAt: now,
  };
}

interface Hooks {
  /** The demo "clicked" a button and its receive window should open. */
  onOpen(order: Order): void;
  /** The pretend payment just arrived (a coin run: the copy dialog plays). */
  onDetected(order: Order): void;
  /** The pretend payment just arrived (Privacy Enhanced: its transfer window plays). */
  onJourney(transfer: Transfer): void;
}

export function useDemo(payoutAddress: string, hooks: Hooks) {
  const [order, setOrder] = useState<Order | null>(null);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [timeLapse, setTimeLapse] = useState<TimeLapse | null>(null);
  const [kind, setKind] = useState<DemoKind | null>(null);
  const [pressing, setPressing] = useState<Coin | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const stop = useCallback(() => {
    clear();
    setPressing(null);
    setOrder(null);
    setTransfer(null);
    setTimeLapse(null);
    setKind(null);
  }, []);

  const startCoin = useCallback(
    (coin: Coin, at: (ms: number, fn: () => void) => void) => {
      const s = SCRIPT[coin];
      let current = { ...demoOrder(coin), payoutAddress };
      const set = (patch: Partial<Order>) => {
        current = { ...current, ...patch, updatedAt: Date.now() };
        setOrder(current);
        return current;
      };
      // 1. "Click" the coin button.
      setPressing(coin);
      sfx.tap();
      at(650, () => {
        setPressing(null);
        sfx.open();
        hooksRef.current.onOpen(set({ createdAt: Date.now() }));
      });
      // 2. Someone scans the QR code and pays.
      at(4000, () => hooksRef.current.onDetected(set({ stage: 'received', status: 'PENDING', received: s.amount, seenAt: Date.now() })));
      // 3. Confirmations tick up (Monero needs 20, so they tick faster).
      const tick = Math.min(1100, 6000 / s.req);
      for (let c = 1; c <= s.req; c++) at(tick, () => set({ confirmations: c }));
      // 4. Swap, send, done.
      at(1200, () => set({ stage: 'swapping', status: 'EXCHANGE' }));
      at(3600, () => set({ stage: 'sending', status: 'WITHDRAW', usdt: s.usdt }));
      at(3400, () => set({ stage: 'done', status: 'DONE', usdtFinal: true, cost: s.cost }));
    },
    [payoutAddress],
  );

  /** Privacy Enhanced, and payments to a permanent address: the transfer window plays it all. */
  const startJourney = useCallback(
    (flavor: Flavor, at: (ms: number, fn: () => void) => void) => {
      const s = SCRIPT.BTC;
      const route = flavor !== 'privacy';
      const privacy = flavor !== 'route';
      let leg1: Order = {
        ...demoOrder('BTC'),
        payoutAddress: privacy ? '' : payoutAddress,
        toCcy: privacy ? 'XMR' : 'USDCBASE',
        payoutLabel: privacy ? 'Monero vault' : 'Coinbase',
        transferId: DEMO_TRANSFER,
        ...(privacy ? { min: '0.0013469', minUsd: 108.8 } : {}),
      };
      let t = demoTransfer(flavor, leg1, payoutAddress);
      let legShown = !route; // a permanent address only gets its FixedFloat order once the payment is forwarded
      const setLeg = (patch: Partial<Order>) => {
        leg1 = { ...leg1, ...patch, updatedAt: Date.now() };
        if (!route) setOrder(leg1);
        return leg1;
      };
      const set = (patch: Partial<Transfer>) => {
        t = { ...t, ...(legShown ? { leg1 } : {}), ...patch, updatedAt: Date.now() };
        setTransfer(t);
        return t;
      };
      const d: Record<string, string> = {};
      const steps = (active: string, more: Record<string, string> = {}) => stepsAt(flavor, active, Object.assign(d, more));
      const xmr = '0.2231';
      const out = privacy ? '118.42' : '124.03';

      if (!route) {
        // 1. The address to pay (the first swap's).
        sfx.tap();
        at(450, () => {
          sfx.open();
          set({});
          hooksRef.current.onOpen(setLeg({ createdAt: Date.now() }));
        });
        // 2. Paid: the transfer window takes over and plays everything.
        at(3600, () => {
          setLeg({ stage: 'received', status: 'PENDING', received: s.amount, seenAt: Date.now() });
          hooksRef.current.onJourney(set({ stage: 'received', received: s.amount, usdValue: 126.1, steps: steps('in', { in: `${s.amount} BTC received` }) }));
        });
        for (let c = 1; c <= s.req; c++) at(1000, () => (setLeg({ confirmations: c }), set({})));
        // 3. FixedFloat swaps it.
        at(1100, () => {
          setLeg({ stage: 'swapping', status: 'EXCHANGE' });
          set({ stage: 'swapping', steps: steps('swap1', { swap1: 'FixedFloat order DEMO' }) });
        });
      } else {
        // 1. You send from your phone to your saved address: it lands, rings, and the transfer window opens.
        at(1200, () => hooksRef.current.onJourney(set({ stage: 'received', received: s.amount, usdValue: 126.1, steps: steps('in', { in: `${s.amount} BTC, 0 of 1 confirmations` }) })));
        // 2. Confirmed: the hot wallet forwards exactly that to a fresh FixedFloat order.
        at(2600, () => set({ state: 'send1', steps: steps('forward', { in: `${s.amount} BTC`, forward: 'FixedFloat order DEMO' }) }));
        // 3. FixedFloat swaps it.
        at(1700, () => {
          legShown = true;
          setLeg({ stage: 'swapping', status: 'EXCHANGE', received: '0.00149', confirmations: 1 });
          set({ state: 'swap1', stage: 'swapping', steps: steps('swap1', { forward: '0.00149 BTC (network fee 0.00001)' }) });
        });
      }

      if (!privacy) {
        // 4. USDC out to Coinbase.
        at(3200, () => {
          setLeg({ stage: 'sending', status: 'WITHDRAW', usdt: out });
          set({ stage: 'sending', steps: steps('out', { swap1: `${out} USDC` }) });
        });
        at(2800, () => {
          setLeg({ stage: 'done', status: 'DONE', usdtFinal: true });
          set({ state: 'done', stage: 'done', usdt: out, cost: { usd: 2.07, pct: 1.6, inUsd: 126.1 }, steps: steps('all', { out: `${out} USDC` }) });
        });
        return;
      }

      // 4. Swapped to Monero, it lands in the vault: the door shuts and it unlocks block by block.
      at(3000, () => {
        setLeg({ stage: 'done', status: 'DONE', usdt: xmr, usdtFinal: true });
        set({ state: 'xmr-in', stage: 'holding', steps: steps('vault', { swap1: `${xmr} XMR` }) });
      });
      at(1900, () => set({ xmrArrived: true, xmr, usdValue: 120.85, xmrConfirmations: 0, steps: steps('vault', { vault: `${xmr} XMR` }) }));
      for (let c = 1; c <= 10; c++) at(c === 1 ? 700 : 170, () => set({ xmrConfirmations: c }));
      // 5. The shuffle to a fresh spot.
      at(500, () => set({ state: 'churn', unlockedAt: Date.now(), steps: steps('churn') }));
      // 6. A day's wait, as a time-lapse.
      at(2700, () => {
        const now = Date.now();
        setTimeLapse({ realStart: now, virtualStart: now, speed: (24 * H) / LAPSE_MS });
        set({ state: 'wait', unlockedAt: now, releaseAt: now + 24 * H, steps: steps('wait', { churn: `${xmr} XMR` }) });
      });
      // 7. Out of the vault, swapped to USDC, sent to Coinbase.
      const leg2: Order = { ...demoOrder('XMR'), id: 'DEMO2', payoutAddress, payoutLabel: 'Coinbase', transferId: DEMO_TRANSFER, stage: 'swapping', status: 'EXCHANGE', received: xmr };
      at(LAPSE_MS + 300, () => set({ state: 'open2', steps: steps('swap2', { wait: 'Over' }) }));
      at(1600, () => set({ state: 'swap2', stage: 'swapping', leg2, steps: steps('swap2', { swap2: `FixedFloat order DEMO2: ${xmr} XMR` }) }));
      at(3000, () => set({ stage: 'sending', leg2: { ...leg2, stage: 'sending', status: 'WITHDRAW', usdt: out }, steps: steps('out', { swap2: `${xmr} XMR` }) }));
      // 126.10 in, 118.42 out: 4.61 of fees, and the Monero price fell 3.07 while it waited.
      at(2800, () => set({ state: 'done', stage: 'done', usdt: out, cost: { usd: 4.61, pct: 3.7, inUsd: 126.1, drift: -3.07 }, leg2: { ...leg2, stage: 'done', status: 'DONE', usdt: out, usdtFinal: true }, steps: steps('all', { out: `${out} USDC` }) }));
    },
    [payoutAddress],
  );

  const start = useCallback(
    (what: DemoKind) => {
      clear();
      setOrder(null);
      setTransfer(null);
      setTimeLapse(null);
      setKind(what);
      let t = 0;
      const at = (ms: number, fn: () => void) => {
        t += ms;
        timers.current.push(setTimeout(fn, t));
      };
      if (what === 'privacy' || what === 'route' || what === 'route-privacy') startJourney(what, at);
      else startCoin(what, at);
    },
    [startCoin, startJourney],
  );

  useEffect(() => clear, []);

  return { order, transfer, timeLapse, kind, pressing, start, stop };
}
