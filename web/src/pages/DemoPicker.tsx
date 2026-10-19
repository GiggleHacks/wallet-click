import type { ReactNode } from 'react';
import { CoinIcon, HouseIcon, PlayIcon, ShieldIcon } from '../components/art';
import { ModalLayer, Window } from '../components/Win98';
import type { DemoKind } from '../lib/demo';

interface Flow {
  kind: DemoKind;
  icon: ReactNode;
  title: string;
  sub: string;
}

const FRESH: Flow[] = [
  { kind: 'BTC', icon: <CoinIcon coin="BTC" size={34} />, title: 'Bitcoin', sub: 'Straight to USDC' },
  { kind: 'ETH', icon: <CoinIcon coin="ETH" size={34} />, title: 'Ethereum', sub: 'Straight to USDC' },
  { kind: 'XMR', icon: <CoinIcon coin="XMR" size={34} />, title: 'Monero', sub: 'Straight to USDC' },
  { kind: 'privacy', icon: <ShieldIcon size={34} />, title: 'Privacy Enhanced', sub: 'Through a Monero vault' },
];

const PERMANENT: Flow[] = [
  {
    kind: 'route',
    icon: (
      <span className="stack-icon">
        <CoinIcon coin="BTC" size={34} />
        <span className="stack-badge">
          <HouseIcon size={16} />
        </span>
      </span>
    ),
    title: 'Straight to USDC',
    sub: 'You send BTC from your phone',
  },
  {
    kind: 'route-privacy',
    icon: (
      <span className="stack-icon">
        <ShieldIcon size={34} />
        <span className="stack-badge">
          <HouseIcon size={16} />
        </span>
      </span>
    ),
    title: 'Privacy Enhanced',
    sub: 'You send BTC; it goes through the vault',
  },
];

/** "How it works": preview exactly what you'll see and hear when money arrives, without sending any. */
export function DemoPicker({ onPick, onClose }: { onPick(kind: DemoKind): void; onClose(): void }) {
  const button = (f: Flow) => (
    <button key={f.kind} type="button" className="btn98 pick-btn" onClick={() => onPick(f.kind)}>
      {f.icon}
      <span>
        <b>{f.title}</b>
        <small>{f.sub}</small>
      </span>
    </button>
  );
  return (
    <ModalLayer>
      <Window title="How it works" icon={<PlayIcon size={16} />} onClose={onClose} className="win-picker" role="dialog">
        <p className="line-sub picker-intro">
          Preview exactly what you'll see and hear when money arrives: the same windows, animations and sounds as a real payment. Pick a flow to watch. The coins are pretend:
          nothing is created and no money moves. A day's wait plays as a time-lapse.
        </p>
        <fieldset className="group98">
          <legend>When someone pays a fresh address</legend>
          <div className="pick-grid">{FRESH.map(button)}</div>
        </fieldset>
        <fieldset className="group98">
          <legend>When you send to one of your permanent addresses</legend>
          <div className="pick-grid">{PERMANENT.map(button)}</div>
        </fieldset>
        <div className="btn-row">
          <button type="button" className="btn98" onClick={onClose}>
            Cancel
          </button>
        </div>
      </Window>
    </ModalLayer>
  );
}
