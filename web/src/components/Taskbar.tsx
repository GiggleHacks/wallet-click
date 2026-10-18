import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { getPref, setPref } from '../lib/prefs';
import { audioState, sfx } from '../lib/sound';
import { useTheme, type Theme } from '../lib/themes';
import type { Coin } from '../types';
import { APP_VERSION } from '../version';
import { VersionTag } from './VersionTag';
import { AppMark, BookIcon, ClockIcon, CoinIcon, DisplayIcon, HouseIcon, KeyIcon, LineSpeaker, LogIcon, PlayIcon, PowerIcon, Speaker, StartGlyph } from './art';

export interface TaskItem {
  key: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick(): void;
}

export interface Balloon {
  id: number;
  title: string;
  text: string;
  onClick?(): void;
}

interface Props {
  items: TaskItem[];
  balloon: Balloon | null;
  onDismissBalloon(): void;
  onCreate(coin: Coin): void;
  onDemo(): void;
  onDisplay(): void;
  onAddressBook(): void;
  onPrivacy(): void;
  onAddresses(): void;
  onLogs(): void;
  onLock(): void;
  /** Extra things in the notification area (a countdown on phones). */
  tray?: ReactNode;
}

/** One Start menu entry; each shell lays these out its own way (list, live tiles, pinned grid). */
interface Entry {
  key: string;
  label: string;
  short: string;
  icon(size: number): ReactNode;
  onClick(): void;
  /** Live tile colour (Windows 10). */
  tile: string;
}

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return { time: now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), date: now.toLocaleDateString() };
}

function useAudioState() {
  const [state, setState] = useState(audioState());
  useEffect(() => {
    const update = () => setState(audioState());
    window.addEventListener('wc:audio', update);
    window.addEventListener('wc:prefs', update);
    const t = setInterval(update, 2000);
    return () => {
      window.removeEventListener('wc:audio', update);
      window.removeEventListener('wc:prefs', update);
      clearInterval(t);
    };
  }, []);
  return state;
}

function ClassicMenu({ theme, entries }: { theme: Theme; entries: Entry[] }) {
  const sepAfter = new Set(['eth', 'sound']);
  return (
    <>
      <div className="start-banner">
        <span>
          Wallet<b>Click</b> <i>{theme.version}</i>
        </span>
      </div>
      <ul>
        {entries.map((e) => (
          <li key={e.key} className={sepAfter.has(e.key) ? 'has-sep' : undefined}>
            <button type="button" onClick={e.onClick}>
              {e.icon(24)} {e.label}
            </button>
          </li>
        ))}
        <li className="menu-version">
          <VersionTag />
        </li>
      </ul>
    </>
  );
}

function Win10Menu({ entries }: { entries: Entry[] }) {
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
  const rail = ['themes', 'sound', 'lock'].map((k) => byKey[k]);
  const tiles = ['btc', 'eth', 'demo', 'themes'].map((k) => byKey[k]);
  return (
    <>
      <div className="s10-rail">
        <span className="s10-avatar" title="Wallet Click">
          <AppMark size={20} />
        </span>
        <span className="grow" />
        {rail.map((e) => (
          <button key={e.key} type="button" className="s10-rail-btn" onClick={e.onClick} title={e.label} aria-label={e.label}>
            {e.key === 'lock' ? <PowerIcon size={16} /> : e.icon(18)}
          </button>
        ))}
      </div>
      <div className="s10-list">
        <p className="s10-letter">W</p>
        {entries.map((e) => (
          <button key={e.key} type="button" className="s10-item" onClick={e.onClick}>
            <span className="s10-item-icon">{e.icon(22)}</span>
            {e.label}
          </button>
        ))}
        <VersionTag className="menu-version" />
      </div>
      <div className="s10-tiles">
        <p className="s10-group">Wallet Click</p>
        <div className="s10-grid">
          {tiles.map((e) => (
            <button key={e.key} type="button" className="s10-tile" style={{ background: e.tile }} onClick={e.onClick}>
              <span className="s10-tile-icon">{e.icon(40)}</span>
              <span className="s10-tile-label">{e.short}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function Win11Menu({ entries }: { entries: Entry[] }) {
  const [query, setQuery] = useState('');
  const lock = entries.find((e) => e.key === 'lock')!;
  const pinned = entries.filter((e) => e.key !== 'lock' && e.label.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <>
      <input className="s11-search" placeholder="Search for apps, settings, and documents" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
      <p className="s11-head">Pinned</p>
      <div className="s11-grid">
        {pinned.map((e) => (
          <button key={e.key} type="button" className="s11-app" onClick={e.onClick}>
            {e.icon(32)}
            <span>{e.short}</span>
          </button>
        ))}
        {!pinned.length && <p className="s11-empty">No results for "{query}"</p>}
      </div>
      <div className="s11-foot">
        <span className="s11-user">
          <span className="s11-avatar">
            <AppMark size={18} />
          </span>
          Wallet Click
          <VersionTag className="menu-version" />
        </span>
        <button type="button" className="s11-power" onClick={lock.onClick} title="Log off" aria-label="Log off">
          <PowerIcon size={16} />
        </button>
      </div>
    </>
  );
}

export function Taskbar({ items, balloon, onDismissBalloon, onCreate, onDemo, onDisplay, onAddressBook, onPrivacy, onAddresses, onLogs, onLock, tray }: Props) {
  const theme = useTheme();
  const [menu, setMenu] = useState(false);
  const { time, date } = useClock();
  const audio = useAudioState();
  const classic = theme.shell === 'classic';

  useEffect(() => {
    if (!balloon) return;
    const t = setTimeout(onDismissBalloon, 9000);
    return () => clearTimeout(t);
  }, [balloon, onDismissBalloon]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const toggleSound = () => {
    if (audio === 'locked') {
      sfx.tap(); // the click itself unlocks audio
      window.dispatchEvent(new Event('wc:audio'));
      return;
    }
    const on = !getPref('sound');
    setPref('sound', on);
    if (on) sfx.tap();
  };

  const pick = (fn: () => void) => () => {
    setMenu(false);
    fn();
  };

  const SpeakerIcon = (size: number, muted: boolean) => (classic ? <Speaker size={size} muted={muted} /> : <LineSpeaker size={size} muted={muted} />);
  const entries: Entry[] = [
    { key: 'btc', label: 'New Bitcoin address', short: 'Bitcoin', icon: (s) => <CoinIcon coin="BTC" size={s} />, onClick: pick(() => onCreate('BTC')), tile: '#d9790b' },
    { key: 'eth', label: 'New Ethereum address', short: 'Ethereum', icon: (s) => <CoinIcon coin="ETH" size={s} />, onClick: pick(() => onCreate('ETH')), tile: '#4a5fc1' },
    { key: 'xmr', label: 'New Monero address', short: 'Monero', icon: (s) => <CoinIcon coin="XMR" size={s} />, onClick: pick(() => onCreate('XMR')), tile: '#c45000' },
    { key: 'privacy', label: 'Send options…', short: 'Options', icon: (s) => <ClockIcon size={s} />, onClick: pick(onPrivacy), tile: '#4b3a9a' },
    { key: 'addresses', label: 'My Addresses…', short: 'My Addresses', icon: (s) => <HouseIcon size={s} />, onClick: pick(onAddresses), tile: '#9a3b1f' },
    { key: 'book', label: 'Address Book…', short: 'Address Book', icon: (s) => <BookIcon size={s} />, onClick: pick(onAddressBook), tile: '#1d5aa8' },
    { key: 'demo', label: 'How it works', short: 'How it works', icon: (s) => <PlayIcon size={s} />, onClick: pick(onDemo), tile: '#744da9' },
    { key: 'themes', label: 'Themes and background…', short: 'Themes', icon: (s) => <DisplayIcon size={s} />, onClick: pick(onDisplay), tile: '#0063b1' },
    { key: 'logs', label: 'Logs', short: 'Logs', icon: (s) => <LogIcon size={s} />, onClick: pick(onLogs), tile: '#4c4a48' },
    { key: 'sound', label: `Sound: ${audio === 'off' ? 'Off' : 'On'}`, short: 'Sound', icon: (s) => SpeakerIcon(s, audio === 'off'), onClick: pick(toggleSound), tile: '#00796b' },
    { key: 'lock', label: 'Log off…', short: 'Log off', icon: (s) => <KeyIcon size={s} />, onClick: pick(onLock), tile: '#b03030' },
  ];

  return (
    <>
      <AnimatePresence>
        {menu && (
          <>
            <div className="menu-backdrop" onClick={() => setMenu(false)} />
            <motion.nav
              className={`start-menu start-${theme.shell}`}
              aria-label="Start menu"
              initial={{ opacity: 0, y: theme.shell === 'win11' ? 40 : 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: theme.shell === 'win11' ? 40 : 14 }}
              transition={{ duration: theme.shell === 'classic' ? 0.12 : 0.2, ease: 'easeOut' }}
            >
              {theme.shell === 'classic' && <ClassicMenu theme={theme} entries={entries} />}
              {theme.shell === 'win10' && <Win10Menu entries={entries} />}
              {theme.shell === 'win11' && <Win11Menu entries={entries} />}
            </motion.nav>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {balloon && (
          <motion.button
            key={balloon.id}
            type="button"
            className="balloon"
            initial={{ opacity: 0, y: classic ? 10 : 0, x: classic ? 0 : 40 }}
            animate={{ opacity: 1, y: 0, x: 0 }}
            exit={{ opacity: 0 }}
            onClick={() => {
              balloon.onClick?.();
              onDismissBalloon();
            }}
          >
            {!classic && (
              <span className="toast-app">
                <AppMark size={14} /> Wallet Click
              </span>
            )}
            <b>{balloon.title}</b>
            <span>{balloon.text}</span>
          </motion.button>
        )}
      </AnimatePresence>

      <div className="taskbar">
        <div className="taskbar-main">
          <button
            type="button"
            className={`btn98 start-btn ${menu ? 'is-pressed' : ''}`}
            onClick={() => (sfx.tap(), setMenu((m) => !m))}
            aria-label="Start"
            aria-expanded={menu}
          >
            {classic ? (
              <>
                <AppMark size={16} /> Start
              </>
            ) : (
              <StartGlyph variant={theme.shell === 'win10' ? 'win10' : 'win11'} size={theme.shell === 'win10' ? 16 : 22} />
            )}
          </button>
          <span className="tb-divider" />
          <div className="task-items">
            {items.map((it) => (
              <button key={it.key} type="button" className={`btn98 task-item ${it.active ? 'is-pressed' : ''}`} onClick={it.onClick} title={it.label} aria-label={it.label}>
                {it.icon}
                <span className="task-label">{it.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="tray">
          {tray}
          <button
            type="button"
            className={`tray-btn ${audio === 'locked' ? 'is-attn' : ''}`}
            onClick={toggleSound}
            title={audio === 'locked' ? 'Click to turn sound on' : audio === 'off' ? 'Sound is off' : 'Sound is on'}
            aria-label="Sound"
          >
            {SpeakerIcon(16, audio !== 'ready')}
          </button>
          <span className="tray-version" title={`Wallet Click version ${APP_VERSION}`}>
            v{APP_VERSION}
          </span>
          <span className="tray-clock">
            <span>{time}</span>
            <span className="tray-date">{date}</span>
          </span>
        </div>
      </div>
    </>
  );
}
