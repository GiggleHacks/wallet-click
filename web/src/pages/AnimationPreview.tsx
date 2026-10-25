import { useEffect, useMemo, useRef, useState } from 'react';
import { CoinIcon, PlayIcon, ShieldIcon } from '../components/art';
import { JourneyStrip, type Phase } from '../components/JourneyDialog';
import { TransferStrip } from '../components/TransferDialog';
import { ModalLayer, Window } from '../components/Win98';
import { demoOrder, demoTransfer } from '../lib/demo';
import { ANIM_LABEL, setAnimStyle, useAnimStyle, type AnimStyle } from '../lib/motion';
import { sfx } from '../lib/sound';
import type { Coin, Order, Stage } from '../types';

/**
 * "How it works › Animations": every moment of a transfer on its own, looping for as long as you like, without
 * playing a whole payment through. Auto-play walks through them all and starts again. The style switch here is the
 * same setting as in Themes and the Start menu.
 */

type Flow = 'direct' | 'privacy';
interface Moment {
  key: string;
  label: string;
  /** How long auto-play stays on it (ms). */
  ms: number;
  sound?: () => void;
}

const DIRECT: Moment[] = [
  { key: 'waiting', label: 'Waiting', ms: 2200 },
  { key: 'received', label: 'Arriving', ms: 3600, sound: () => sfx.ding() },
  { key: 'swapping', label: 'Swapping', ms: 4200, sound: () => sfx.swap() },
  { key: 'sending', label: 'Sending', ms: 3600, sound: () => sfx.send() },
  { key: 'done', label: 'Done', ms: 3200, sound: () => sfx.tada() },
];

const PRIVACY: Moment[] = [
  { key: 'confirming', label: 'Arriving', ms: 3400, sound: () => sfx.ding() },
  { key: 'swap1', label: 'Swap', ms: 4000, sound: () => sfx.swap() },
  { key: 'vault-in', label: 'Vault', ms: 3000, sound: () => sfx.send() },
  { key: 'locked', label: 'Unlocking', ms: 5600, sound: () => sfx.vaultLock() },
  { key: 'churn', label: 'Shuffle', ms: 3000, sound: () => sfx.shuffle() },
  { key: 'waiting', label: 'Waiting', ms: 4000 },
  { key: 'release', label: 'Release', ms: 3000, sound: () => sfx.vaultOpen() },
  { key: 'swap2', label: 'Swap', ms: 4000, sound: () => sfx.swap() },
  { key: 'sending', label: 'Sending', ms: 3400, sound: () => sfx.send() },
  { key: 'done', label: 'Done', ms: 3200, sound: () => sfx.tada() },
];

const H = 3_600_000;
const NAMES: Record<Coin, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', XMR: 'Monero' };

/** Frames the browser really drew in the last half second, per second. */
function useFps(): number {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let since = performance.now();
    const loop = (t: number) => {
      frames++;
      if (t - since >= 500) {
        setFps(Math.round((frames * 1000) / (t - since)));
        frames = 0;
        since = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return fps;
}

export function AnimationPreview({ onClose }: { onClose(): void }) {
  const [flow, setFlow] = useState<Flow>('direct');
  const [coin, setCoin] = useState<Coin>('BTC');
  const [at, setAt] = useState(1);
  const [auto, setAuto] = useState(true);
  /** Bumped to start the strip over (Done again, or auto-play going round). */
  const [run, setRun] = useState(0);
  const [since, setSince] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const fps = useFps();
  const style = useAnimStyle();
  const moments = flow === 'direct' ? DIRECT : PRIVACY;
  const m = moments[Math.min(at, moments.length - 1)];

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = (i: number, again = false) => {
    const next = moments[i];
    if (again) setRun((r) => r + 1);
    setAt(i);
    setSince(Date.now());
    next.sound?.();
  };

  // Auto-play: on to the next moment when this one has had its turn, round to the start after the last.
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    if (!auto) return;
    const timer = setTimeout(() => (at + 1 >= moments.length ? goRef.current(0, true) : goRef.current(at + 1)), m.ms);
    return () => clearTimeout(timer);
  }, [auto, at, m.ms, moments.length, since]);

  const pick = (i: number) => {
    setAuto(false);
    go(i, i === at);
  };
  const changeFlow = (f: Flow) => {
    setFlow(f);
    if (f === 'privacy' && coin === 'XMR') setCoin('BTC');
    setAt(f === 'direct' ? 1 : 0);
    setSince(Date.now());
    setRun((r) => r + 1);
  };

  const elapsed = now - since;
  const order = useMemo<Order>(() => ({ ...demoOrder(coin), received: coin === 'BTC' ? '0.0015' : coin === 'ETH' ? '0.05' : '0.23', confirmations: 1, toCcy: 'USDCBASE', payoutLabel: 'Coinbase', destinationId: 'coinbase-base', usdt: '125.37' }), [coin]);
  // Privacy: the vault's ring fills block by block, and the day's wait drains in six seconds.
  const lapse = (elapsed % 6000) / 6000;
  const transfer = useMemo(() => {
    const t = demoTransfer('privacy', demoOrder(coin), '');
    return { ...t, coin, coinName: NAMES[coin], received: order.received, xmr: '0.2231', usdt: '118.42', unlockedAt: 0, releaseAt: 24 * H };
  }, [coin, order.received]);
  const t = { ...transfer, xmrConfirmations: m.key === 'locked' ? Math.min(10, Math.floor(elapsed / 500)) : 10 };

  return (
    <ModalLayer>
      <Window
        title="Animations"
        icon={<PlayIcon size={16} />}
        onClose={onClose}
        className="win-anim"
        role="dialog"
        statusBar={
          <>
            <span className="status-cell grow">
              {flow === 'direct' ? `${NAMES[coin]} → USDC` : `${NAMES[coin]} → Monero → USDC`}: {m.label}
            </span>
            <span className="status-cell">{ANIM_LABEL[style]}</span>
            <span className="status-cell">{fps ? `${fps} fps` : '…'}</span>
          </>
        }
      >
        <div className="anim-bar">
          <div className="seg98" role="radiogroup" aria-label="Flow">
            <button type="button" role="radio" aria-checked={flow === 'direct'} className={`btn98 seg-btn ${flow === 'direct' ? 'is-pressed' : ''}`} onClick={() => changeFlow('direct')}>
              Straight
            </button>
            <button type="button" role="radio" aria-checked={flow === 'privacy'} className={`btn98 seg-btn ${flow === 'privacy' ? 'is-pressed' : ''}`} onClick={() => changeFlow('privacy')}>
              <ShieldIcon size={16} /> Privacy
            </button>
          </div>
          <div className="seg98" role="radiogroup" aria-label="Coin">
            {(['BTC', 'ETH', 'XMR'] as Coin[]).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={coin === c}
                className={`btn98 seg-btn ${coin === c ? 'is-pressed' : ''}`}
                disabled={flow === 'privacy' && c === 'XMR'}
                onClick={() => setCoin(c)}
              >
                <CoinIcon coin={c} size={18} /> {c}
              </button>
            ))}
          </div>
        </div>
        <div className="seg98 anim-style" role="radiogroup" aria-label="Style">
          {(['smooth', 'retro', 'calm'] as AnimStyle[]).map((a) => (
            <button key={a} type="button" role="radio" aria-checked={style === a} className={`btn98 seg-btn ${style === a ? 'is-pressed' : ''}`} onClick={() => (sfx.tap(), setAnimStyle(a))}>
              {ANIM_LABEL[a]}
            </button>
          ))}
        </div>

        <div className="anim-stage">
          {flow === 'direct' ? (
            <TransferStrip key={`d${run}${coin}`} order={order} shown={m.key as Stage} />
          ) : (
            <JourneyStrip key={`p${run}${coin}`} t={t} shown={m.key as Phase} now={m.key === 'waiting' ? lapse * 24 * H : 0} />
          )}
        </div>

        <div className="seg98 anim-moments" role="radiogroup" aria-label="Moment">
          {moments.map((x, i) => (
            <button key={`${x.key}${i}`} type="button" role="radio" aria-checked={i === at} className={`btn98 seg-btn ${i === at ? 'is-pressed' : ''}`} onClick={() => pick(i)}>
              {x.label}
            </button>
          ))}
        </div>

        <div className="btn-row">
          <label className="check98 anim-auto">
            <input type="checkbox" checked={auto} onChange={(e) => (setAuto(e.target.checked), setSince(Date.now()))} />
            <span className="check98-box" aria-hidden="true" />
            <span className="check98-text">Auto-play</span>
          </label>
          <button type="button" className="btn98 is-default" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </Window>
    </ModalLayer>
  );
}
