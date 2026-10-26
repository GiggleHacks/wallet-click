import type { Coin, Cost, Order, Transfer, TransferStep } from '../types';

/** Pretend orders and transfers for "How it works › Animations": the real windows' strips, with nothing behind them. */

type Flavor = 'privacy' | 'route' | 'route-privacy';
const DEMO_ID = 'DEMO';
const DEMO_TRANSFER = 'DEMO-T';
const DEMO_ROUTE = 'DEMO-R';
const ROUTE_LABEL: Record<Flavor, string> = { privacy: '', route: 'Phone → Coinbase', 'route-privacy': 'Private → Coinbase' };
/** Deliberately not a valid address, so nobody can pay it by scanning the demo QR code. */
const DEMO_ADDRESS = 'DEMO-not-a-real-address';

const SCRIPT: Record<Coin, { amount: string; usdt: string; req: number; min: string; minUsd: number; cost: Cost }> = {
  ETH: { amount: '0.05', usdt: '126.84', req: 4, min: '0.005', minUsd: 12.72, cost: { usd: 1.37, pct: 1.1, inUsd: 128.21 } },
  BTC: { amount: '0.0015', usdt: '125.37', req: 2, min: '0.0001243', minUsd: 10.42, cost: { usd: 1.33, pct: 1.0, inUsd: 126.7 } },
  XMR: { amount: '0.23', usdt: '124.18', req: 20, min: '0.0184', minUsd: 9.97, cost: { usd: 1.3, pct: 1.0, inUsd: 125.48 } },
};
const NAMES: Record<Coin, [string, string, number]> = { BTC: ['Bitcoin', 'Bitcoin', 10], ETH: ['Ethereum', 'Ethereum mainnet', 0.2], XMR: ['Monero', 'Monero', 2] };

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
