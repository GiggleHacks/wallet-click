import { useCallback, useEffect, useRef, useState } from 'react';
import type { Coin, Order } from '../types';
import { sfx } from './sound';

/**
 * "How it works": a scripted run through the whole flow (click → fresh address → payment →
 * swap → Coinbase) with the real windows, animations and sounds. Nothing touches the server.
 */

export const DEMO_ID = 'DEMO';
/** Deliberately not a valid address, so nobody can pay it by scanning the demo QR code. */
export const DEMO_ADDRESS = 'DEMO-not-a-real-address';

const SCRIPT: Record<Coin, { amount: string; usdt: string; req: number; min: string; minUsd: number }> = {
  ETH: { amount: '0.05', usdt: '126.84', req: 4, min: '0.005', minUsd: 12.72 },
  BTC: { amount: '0.0015', usdt: '125.37', req: 2, min: '0.0001243', minUsd: 10.42 },
  XMR: { amount: '0.23', usdt: '124.18', req: 20, min: '0.0184', minUsd: 9.97 },
};
const NAMES: Record<Coin, [string, string, number]> = { BTC: ['Bitcoin', 'Bitcoin', 10], ETH: ['Ethereum', 'Ethereum mainnet', 0.2], XMR: ['Monero', 'Monero', 2] };

function demoOrder(coin: Coin): Order {
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

interface Hooks {
  /** The demo "clicked" a coin and its receive window should open. */
  onOpen(order: Order): void;
  /** The pretend payment just arrived. */
  onDetected(order: Order): void;
}

export function useDemo(payoutAddress: string, hooks: Hooks) {
  const [order, setOrder] = useState<Order | null>(null);
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
  }, []);

  const start = useCallback(
    (coin: Coin) => {
      clear();
      setOrder(null);
      const s = SCRIPT[coin];
      const base = { ...demoOrder(coin), payoutAddress };
      let t = 0;
      const at = (ms: number, fn: () => void) => {
        t += ms;
        timers.current.push(setTimeout(fn, t));
      };
      let current = base;
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
      // 3. Confirmations tick up.
      for (let c = 1; c <= s.req; c++) at(1100, () => set({ confirmations: c }));
      // 4. Swap, send, done.
      at(1200, () => set({ stage: 'swapping', status: 'EXCHANGE' }));
      at(3600, () => set({ stage: 'sending', status: 'WITHDRAW', usdt: s.usdt }));
      at(3400, () => set({ stage: 'done', status: 'DONE', usdtFinal: true }));
    },
    [payoutAddress],
  );

  useEffect(() => clear, []);

  return { order, pressing, start, stop };
}
