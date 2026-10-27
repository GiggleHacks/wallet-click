import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { AnyCoinIcon, WalletIcon, WarnIcon } from '../components/art';
import { PasswordField } from '../components/PasswordField';
import { QrCode } from '../components/QrCode';
import { Tip } from '../components/Tip';
import { ModalLayer, Window } from '../components/Win98';
import { MASK, figuresHidden, shortAddr, timeAgo, trimAmount } from '../lib/format';
import { sfx } from '../lib/sound';
import type { WalletAsset, WalletCoin, WalletData, WalletEntry, WalletState } from '../types';

const POLL_MS = 3000;

const STATE_TEXT: Record<WalletState, string> = {
  waiting: 'Waiting for payment',
  incoming: 'Incoming, confirming',
  held: 'Held',
  moving: 'Moving',
  moved: 'Moved',
};

const STEP_TEXT: Record<string, string> = {
  quote: 'Making the swap order',
  order: 'Signing',
  signed: 'Sending',
  sent: 'Swapping',
  done: 'Done',
  failed: 'Stopped',
};

const money = (usd: number | null | undefined) => (usd === null || usd === undefined ? '' : figuresHidden() ? `$${MASK}` : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const amountText = (v: string, sym: string) => (figuresHidden() ? `${MASK} ${sym}` : `${trimAmount(v)} ${sym}`);
const coinName = (e: { name: string; network: string }) => (e.name === e.network || e.network === 'Bitcoin' ? e.name : `${e.name} on ${e.network}`);

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const EntryIcon = ({ e, size }: { e: WalletEntry; size: number }) =>
  e.via ? <AnyCoinIcon code={e.via.code} network={e.via.network} size={size} /> : <AnyCoinIcon id={e.asset} size={size} />;

/** Counts down to a FixedFloat order's expiry (it still swaps late payments, at the market rate then). */
function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((until - now) / 1000));
  if (!left) return <span>quote window over (late payments still go through)</span>;
  return (
    <span className="wal-countdown">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left at this quote
    </span>
  );
}

/** One address, ready to hand over: QR, the address, its network warning, and what has arrived. */
function AddressCard({ e, compact = false }: { e: WalletEntry; compact?: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (what: string, text: string) => void copyText(text).then((ok) => ok && (sfx.copy(), setCopied(what)));
  return (
    <div className={`wal-card ${compact ? 'is-compact' : ''}`}>
      <div className="receive-grid">
        <div className="qr-box">
          <QrCode value={e.uri ?? e.address} size={compact ? 128 : 168} logo={<EntryIcon e={e} size={compact ? 22 : 30} />} />
        </div>
        <div className="receive-info">
          <span className="lbl">
            {coinName(e)}
            {e.label ? ` · ${e.label}` : ''}
          </span>
          <div className="address-box" onClick={() => copy('address', e.address)} title="Click to copy">
            {e.address}
          </div>
          <div className="btn-row wal-copy-row">
            <button type="button" className="btn98" onClick={() => copy('address', e.address)}>
              {copied === 'address' ? 'Copied!' : 'Copy address'}
            </button>
            {e.uri && (
              <a className="btn98 btn-link pay-link" href={e.uri}>
                Open in wallet
              </a>
            )}
          </div>
          {e.via?.tag && (
            <>
              <span className="lbl">Memo / destination tag (they must include it):</span>
              <div className="address-box wal-memo" onClick={() => copy('memo', e.via!.tag!)} title="Click to copy">
                {e.via.tag}
              </div>
            </>
          )}
          <div className="warn-box wal-warn">
            <WarnIcon size={18} /> {e.warning}
          </div>
          {e.via && (
            <p className="line-sub">
              FixedFloat swaps it into your Monero here as it arrives. {e.via.min ? `Minimum ${trimAmount(e.via.min)} ${e.via.code}. ` : ''}
              {e.via.expiresAt && e.state === 'waiting' && <Countdown until={e.via.expiresAt} />}
            </p>
          )}
        </div>
      </div>
      <p className={`wal-status is-${e.state}`}>
        <span className="wal-dot" aria-hidden="true" /> {STATE_TEXT[e.state]}
        {e.state !== 'waiting' && e.amount !== '0' && (
          <>
            : <b>{amountText(e.amount, e.heldSymbol)}</b> {e.usd ? `(≈ ${money(e.usd)})` : ''}
          </>
        )}
        {e.via?.received && e.state === 'incoming' && (
          <>
            : <b>{amountText(e.via.received, e.via.code)}</b> on its way into Monero
          </>
        )}
      </p>
    </div>
  );
}

/** What the drop-down can pick: a coin held here, or any other coin FixedFloat takes (swapped into Monero). */
type Pick = { kind: 'asset'; asset: WalletAsset } | { kind: 'other'; coin: WalletCoin };

const pickKey = (p: Pick) => (p.kind === 'asset' ? `a:${p.asset.id}` : `o:${p.coin.code}`);
const PickIcon = ({ p, size }: { p: Pick; size: number }) =>
  p.kind === 'asset' ? <AnyCoinIcon id={p.asset.id} size={size} /> : <AnyCoinIcon code={p.coin.code} network={p.coin.network} size={size} />;
const pickName = (p: Pick) => (p.kind === 'asset' ? coinName(p.asset) : p.coin.name);
const pickSub = (p: Pick) => (p.kind === 'asset' ? `${p.asset.symbol} · ${p.asset.network}` : `${p.coin.code} · ${p.coin.network}${p.coin.tag ? ' · needs a memo' : ''}`);

/** A drop-down of coins, each with its icon, searchable; the held coins first, then everything FixedFloat takes. */
function CoinSelect({ data, value, onChange }: { data: WalletData; value: Pick | null; onChange(p: Pick): void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [others, setOthers] = useState<WalletCoin[] | null>(null);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const othersOk = data.ready.monero && data.ready.fixedfloat;

  // FixedFloat's list only once someone opens the drop-down.
  useEffect(() => {
    if (!open || others || !othersOk) return;
    api
      .walletCoins()
      .then((r) => setOthers(r.coins))
      .catch((e: Error) => setError(e.message));
  }, [open, others, othersOk]);

  // Clicking anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const s = q.trim().toLowerCase();
  const match = (text: string) => !s || text.toLowerCase().includes(s);
  const held: Pick[] = data.assets.filter((a) => !a.hidden && match(`${a.id} ${a.symbol} ${a.name} ${a.network}`)).map((asset) => ({ kind: 'asset', asset }));
  const rest: Pick[] = (others ?? []).filter((c) => match(`${c.code} ${c.name} ${c.network} ${c.coin}`)).slice(0, 120).map((coin) => ({ kind: 'other', coin }));
  const all = [...held, ...rest];
  const enabled = (p: Pick) => (p.kind === 'asset' ? p.asset.ready : othersOk);
  const choose = (p: Pick) => {
    if (!enabled(p)) return;
    sfx.tap();
    onChange(p);
    setOpen(false);
    setQ('');
  };
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return setOpen(false);
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) return (e.preventDefault(), setOpen(true));
    if (!open) return;
    const step = (d: number) => {
      e.preventDefault();
      let i = active;
      for (let n = 0; n < all.length; n++) {
        i = (i + d + all.length) % all.length;
        if (enabled(all[i])) return setActive(i);
      }
    };
    if (e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowUp') step(-1);
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (all[active]) choose(all[active]);
    }
  };

  const why = (p: Pick) =>
    p.kind === 'asset' ? (p.asset.kind === 'xmr' ? 'Needs the Monero wallet (MONERO_RPC_URL)' : 'Needs the hot wallet (WALLET_KEY)') : 'Needs Monero and FixedFloat set up';
  const row = (p: Pick, i: number) => {
    const ok = enabled(p);
    const on = value !== null && pickKey(value) === pickKey(p);
    return (
      <li
        key={pickKey(p)}
        data-i={i}
        role="option"
        aria-selected={on}
        aria-disabled={!ok}
        title={ok ? undefined : why(p)}
        className={`wal-opt ${i === active ? 'is-active' : ''} ${on ? 'is-chosen' : ''} ${ok ? '' : 'is-off'}`}
        onPointerEnter={() => ok && setActive(i)}
        onClick={() => choose(p)}
      >
        <PickIcon p={p} size={24} />
        <span className="wal-opt-text">
          <span className="wal-opt-name">{pickName(p)}</span>
          <span className="wal-opt-sub">{ok ? pickSub(p) : why(p)}</span>
        </span>
      </li>
    );
  };

  return (
    <div className="wal-select" ref={box} onKeyDown={onKey}>
      <span className="lbl" id="wal-coin-lbl">
        Coin:
      </span>
      <button type="button" className="input98 wal-select-btn" aria-haspopup="listbox" aria-expanded={open} aria-labelledby="wal-coin-lbl" onClick={() => (sfx.tap(), setOpen((o) => !o))}>
        {value ? (
          <>
            <PickIcon p={value} size={28} />
            <span className="wal-opt-text">
              <span className="wal-opt-name">{pickName(value)}</span>
              <span className="wal-opt-sub">{pickSub(value)}</span>
            </span>
          </>
        ) : (
          <span className="wal-opt-text">Pick a coin</span>
        )}
        <span className="wal-caret" aria-hidden="true">
          <svg viewBox="0 0 8 4" width="8" height="4">
            <path d="M0 0h8L4 4z" fill="currentColor" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="wal-drop">
          <input className="input98 wal-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: Litecoin, Dogecoin, USDT TRC20…" aria-label="Search coins" autoFocus />
          <ul className="wal-drop-list" role="listbox" aria-label="Coins" ref={list}>
            {held.length > 0 && (
              <li className="wal-group" role="presentation">
                Held here, at an address of its own
              </li>
            )}
            {held.map((p, i) => row(p, i))}
            {othersOk && (
              <li className="wal-group" role="presentation">
                Swapped into your Monero by FixedFloat
              </li>
            )}
            {othersOk && others === null && !error && (
              <li className="wal-group is-note" role="presentation">
                Loading FixedFloat's list…
              </li>
            )}
            {error && (
              <li className="wal-group is-note" role="presentation">
                {error}
              </li>
            )}
            {rest.map((p, i) => row(p, held.length + i))}
            {!all.length && (
              <li className="wal-group is-note" role="presentation">
                No coin matches "{q}".
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function ReceiveTab({ data, onMade }: { data: WalletData; onMade(e: WalletEntry): void }) {
  const first = data.assets.find((a) => !a.hidden && a.ready);
  const [pick, setPick] = useState<Pick | null>(first ? { kind: 'asset', asset: first } : null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function make() {
    if (!pick) return;
    setBusy(true);
    setError('');
    try {
      const e = await api.walletAddress(pick.kind === 'other' ? { code: pick.coin.code, label } : { asset: pick.asset.id, label });
      sfx.open();
      setLabel('');
      onMade(e);
    } catch (err) {
      sfx.error();
      setError(err instanceof Error ? err.message : "Couldn't make the address");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => (e.preventDefault(), void make())}>
      <CoinSelect data={data} value={pick} onChange={(p) => (setPick(p), setError(''))} />
      <label className="field">
        <span className="lbl">Who's paying (optional, only you see it):</span>
        <input className="input98" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="e.g. Sam, logo job" />
      </label>
      {pick?.kind === 'other' && <p className="line-sub">FixedFloat gives this one its own deposit address. Whatever arrives is swapped into Monero, held here.</p>}
      {error && <p className="error-text">{error}</p>}
      <div className="btn-row">
        <button type="submit" className="btn98 is-default wal-new" disabled={busy || !pick}>
          {busy ? 'Making…' : `New ${pick ? pickName(pick) : ''} address`}
        </button>
      </div>
      <p className="line-sub">Every address is brand new: no history to look at, and it's never handed out again.</p>
    </form>
  );
}

/** Swap to Monero / Send to Coinbase, with the password. */
function MoveForm({ e, data, onDone }: { e: WalletEntry; data: WalletData; onDone(e: WalletEntry): void }) {
  const [to, setTo] = useState<'xmr' | 'coinbase' | null>(null);
  const [dest, setDest] = useState(data.settings.destinationId);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const asset = data.assets.find((a) => a.id === e.asset);
  const min = to ? (to === 'xmr' ? asset?.minUsd.xmr : asset?.minUsd.coinbase) : null;

  async function go() {
    if (!to) return;
    setBusy(true);
    setError('');
    try {
      onDone(await api.walletMove(e.id, to, password, to === 'coinbase' ? dest : undefined));
      sfx.swap();
      setTo(null);
      setPassword('');
    } catch (err) {
      sfx.error();
      setError(err instanceof Error ? err.message : "Couldn't start it");
    } finally {
      setBusy(false);
    }
  }

  if (e.state !== 'held') return null;
  return (
    <fieldset className="group98 wal-move">
      <legend>Move it</legend>
      <div className="btn-row">
        {e.asset !== 'XMR' && (
          <button type="button" className={`btn98 ${to === 'xmr' ? 'is-pressed' : ''}`} onClick={() => setTo('xmr')} disabled={!data.ready.monero} title={data.ready.monero ? undefined : 'Needs the Monero wallet (MONERO_RPC_URL)'}>
            Swap to Monero
          </button>
        )}
        <button type="button" className={`btn98 ${to === 'coinbase' ? 'is-pressed' : ''}`} onClick={() => setTo('coinbase')}>
          Send to Coinbase
        </button>
      </div>
      {to && (
        <form onSubmit={(ev) => (ev.preventDefault(), void go())}>
          {to === 'coinbase' && (
            <label className="field">
              <span className="lbl">As USDC on Base, to:</span>
              <select className="input98 select98" value={dest} onChange={(ev) => setDest(ev.target.value)}>
                {data.destinations.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="line-sub">
            {to === 'xmr' ? 'FixedFloat swaps all of it into a fresh Monero address of this Wallet, where it stays.' : 'FixedFloat swaps all of it to USDC on Base and pays it out.'}
            {min ? ` Minimum about $${min}.` : ''} <Tip tip="One network fee to send it, plus FixedFloat's cut (about 0.5–1%)." />
          </p>
          <PasswordField value={password} onChange={setPassword} label="Password:" />
          {error && <p className="error-text">{error}</p>}
          <div className="btn-row">
            <button type="submit" className="btn98 is-default" disabled={busy || !password}>
              {busy ? 'Starting…' : to === 'xmr' ? 'Swap to Monero' : 'Send to Coinbase'}
            </button>
            <button type="button" className="btn98" onClick={() => setTo(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </fieldset>
  );
}

function MoveList({ e }: { e: WalletEntry }) {
  if (!e.moves.length) return null;
  return (
    <ul className="wal-moves">
      {[...e.moves].reverse().map((m) => (
        <li key={m.id} className={`is-${m.step}`}>
          <b>{m.to === 'xmr' ? 'Swap to Monero' : `Send to ${m.toLabel ?? 'Coinbase'}`}</b>
          {m.by === 'openclaw' ? ' (OpenClaw)' : m.by === 'auto' ? ' (automatic)' : ''}: {STEP_TEXT[m.step]}
          {m.amount && ` · ${amountText(m.amount, e.heldSymbol)}`}
          {m.out && ` → ${amountText(m.out, m.to === 'xmr' ? 'XMR' : 'USDC')}`}
          {m.error && m.step !== 'done' && <span className={m.step === 'failed' ? 'error-text' : 'line-sub'}> · {m.error}</span>}
          {m.txUrl && (
            <>
              {' '}
              <a href={m.txUrl} target="_blank" rel="noreferrer">
                tx
              </a>
            </>
          )}
          {m.payoutUrl && (
            <>
              {' '}
              <a href={m.payoutUrl} target="_blank" rel="noreferrer">
                payout
              </a>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function HoldingsTab({ data, selected, onSelect, onChange }: { data: WalletData; selected: string | null; onSelect(id: string | null): void; onChange(e: WalletEntry): void }) {
  const [filter, setFilter] = useState<'money' | 'all'>('money');
  const [moveAll, setMoveAll] = useState<'xmr' | 'coinbase' | null>(null);
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const list = data.entries.filter((e) => filter === 'all' || e.state !== 'waiting' || e.via);
  const current = list.find((e) => e.id === selected) ?? null;
  const held = data.entries.filter((e) => e.state === 'held');

  async function all() {
    if (!moveAll) return;
    try {
      const r = await api.walletMoveAll(moveAll, password, moveAll === 'coinbase' ? data.settings.destinationId : undefined);
      sfx.swap();
      setNote(`${r.started.length} started${r.skipped.length ? `, ${r.skipped.length} skipped (${r.skipped[0].why})` : ''}.`);
      setMoveAll(null);
      setPassword('');
    } catch (err) {
      sfx.error();
      setNote(err instanceof Error ? err.message : "Couldn't start them");
    }
  }

  async function archive(e: WalletEntry) {
    try {
      onChange(await api.walletUpdate(e.id, { archived: true }));
      onSelect(null);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'That did not work');
    }
  }

  return (
    <>
      <div className="seg98 wal-filter" role="radiogroup" aria-label="Show">
        {(['money', 'all'] as const).map((f) => (
          <button key={f} type="button" role="radio" aria-checked={filter === f} className={`btn98 seg-btn ${filter === f ? 'is-pressed' : ''}`} onClick={() => setFilter(f)}>
            {f === 'money' ? 'With money' : 'All addresses'}
          </button>
        ))}
      </div>
      {!list.length && <p className="wal-empty">{filter === 'money' ? 'Nothing has arrived yet. Make an address on the Receive tab and hand it over.' : 'No addresses yet.'}</p>}
      {list.length > 0 && (
        <ul className="listbox wal-list" role="listbox" aria-label="Addresses">
          {list.map((e) => (
            <li
              key={e.id}
              role="option"
              aria-selected={e.id === current?.id}
              className={e.id === current?.id ? 'is-selected' : ''}
              tabIndex={0}
              onClick={() => onSelect(e.id === current?.id ? null : e.id)}
              onKeyDown={(ev) => ev.key === 'Enter' && onSelect(e.id)}
            >
              <EntryIcon e={e} size={20} />
              <span className="wal-row-name">
                {e.label || coinName(e)}
                <span className="wal-row-sub">
                  {e.label ? `${coinName(e)} · ` : ''}
                  {shortAddr(e.address)} · {timeAgo(e.createdAt)}
                </span>
              </span>
              <span className="wal-row-amt">
                {e.amount !== '0' ? amountText(e.amount, e.heldSymbol) : ''}
                <span className={`wal-chip is-${e.state}`}>{STATE_TEXT[e.state]}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {current && (
        <div className="wal-detail">
          <AddressCard e={current} compact />
          {current.from?.kind === 'move' && <p className="line-sub">Monero from swapping your {current.from.ccy}.</p>}
          <MoveForm e={current} data={data} onDone={onChange} />
          <MoveList e={current} />
          {current.scanError && <p className="line-sub">Last check: {current.scanError}</p>}
          <div className="btn-row">
            {current.explorer && (
              <a className="btn98 btn-link pay-link" href={current.explorer} target="_blank" rel="noreferrer">
                View on explorer
              </a>
            )}
            {(current.state === 'waiting' || current.state === 'moved') && (
              <button type="button" className="btn98" onClick={() => void archive(current)} title="Hide it from this list (it's still watched, and never handed out again)">
                Hide
              </button>
            )}
          </div>
        </div>
      )}
      {held.length > 1 && (
        <fieldset className="group98 wal-move">
          <legend>Everything held ({held.length})</legend>
          <div className="btn-row">
            <button type="button" className={`btn98 ${moveAll === 'xmr' ? 'is-pressed' : ''}`} onClick={() => setMoveAll('xmr')} disabled={!data.ready.monero}>
              Swap all to Monero
            </button>
            <button type="button" className={`btn98 ${moveAll === 'coinbase' ? 'is-pressed' : ''}`} onClick={() => setMoveAll('coinbase')}>
              Send all to Coinbase
            </button>
          </div>
          {moveAll && (
            <form onSubmit={(ev) => (ev.preventDefault(), void all())}>
              <p className="line-sub">They go one at a time per coin (FixedFloat's rule). Ones below the minimum stay.</p>
              <PasswordField value={password} onChange={setPassword} label="Password:" />
              <div className="btn-row">
                <button type="submit" className="btn98 is-default" disabled={!password}>
                  Start
                </button>
                <button type="button" className="btn98" onClick={() => setMoveAll(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </fieldset>
      )}
      {note && <p className="line-sub">{note}</p>}
    </>
  );
}

function SettingsTab({ data, onData }: { data: WalletData; onData(d: WalletData): void }) {
  const s = data.settings;
  const [arrival, setArrival] = useState(s.onArrival);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const save = async (patch: Parameters<typeof api.walletSettings>[0]) => {
    setError('');
    try {
      onData(await api.walletSettings(patch));
      sfx.tap();
      return true;
    } catch (err) {
      sfx.error();
      setError(err instanceof Error ? err.message : "Couldn't save that");
      return false;
    }
  };
  const needsPassword = arrival !== s.onArrival && arrival !== 'hold';
  return (
    <>
      <fieldset className="group98">
        <legend>When a payment is confirmed</legend>
        <div className="wal-arrivals" role="radiogroup" aria-label="When a payment is confirmed">
        {(
          [
            ['hold', 'Hold it here until I move it'],
            ['xmr', 'Swap it to Monero right away'],
            ['coinbase', 'Send it to Coinbase right away'],
          ] as const
        ).map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={arrival === v} className={`btn98 seg-btn wal-arrival ${arrival === v ? 'is-pressed' : ''}`} onClick={() => setArrival(v)}>
            {text}
          </button>
        ))}
        </div>
        {needsPassword && <PasswordField value={password} onChange={setPassword} label="Password:" />}
        {arrival !== s.onArrival && (
          <div className="btn-row">
            <button type="button" className="btn98 is-default" disabled={needsPassword && !password} onClick={() => void save({ onArrival: arrival, password }).then((ok) => ok && setPassword(''))}>
              Save
            </button>
          </div>
        )}
        <p className="line-sub">Payments below FixedFloat's minimum stay held either way.</p>
      </fieldset>
      <fieldset className="group98">
        <legend>Send to Coinbase pays</legend>
        <select className="input98 select98" value={s.destinationId} onChange={(e) => void save({ destinationId: e.target.value })} aria-label="Default destination">
          {data.destinations.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </fieldset>
      <fieldset className="group98">
        <legend>Telegram</legend>
        <label className="check98">
          <input type="checkbox" checked={s.pings} onChange={(e) => void save({ pings: e.target.checked })} />
          <span className="check98-box" aria-hidden="true" />
          <span className="check98-text">Ping me when money arrives and leaves</span>
        </label>
      </fieldset>
      <fieldset className="group98">
        <legend>Coins on the Receive tab</legend>
        <div className="wal-hide-grid">
          {data.assets.map((a) => (
            <label key={a.id} className="check98">
              <input
                type="checkbox"
                checked={!a.hidden}
                onChange={(e) => void save({ hidden: e.target.checked ? s.hidden.filter((h) => h !== a.id) : [...s.hidden, a.id] })}
              />
              <span className="check98-box" aria-hidden="true" />
              <span className="check98-text">{coinName(a)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

type Tab = 'receive' | 'holdings' | 'settings';

/** The Wallet: fresh addresses for many coins, held on the server until you swap them to Monero or send them to Coinbase. */
export function Wallet({ onClose }: { onClose(): void }) {
  const [data, setData] = useState<WalletData | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('receive');
  /** The address just made (the Receive tab shows it until another coin is picked). */
  const [made, setMade] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const states = useRef(new Map<string, WalletState>());

  const load = useCallback(async () => {
    const d = await api.wallet();
    // Ring when money starts arriving at one of them while the window is open.
    for (const e of d.entries) {
      const was = states.current.get(e.id);
      if (was && was === 'waiting' && e.state === 'incoming') sfx.ding();
      if (was && was !== 'held' && e.state === 'held' && !e.from) sfx.ding();
      states.current.set(e.id, e.state);
    }
    setData(d);
    setError('');
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      try {
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Can't reach the server");
      }
      if (alive) timer = setTimeout(loop, POLL_MS);
    };
    void loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [load]);

  const replace = (e: WalletEntry) => setData((d) => (d ? { ...d, entries: d.entries.some((x) => x.id === e.id) ? d.entries.map((x) => (x.id === e.id ? e : x)) : [e, ...d.entries] } : d));
  const fresh = data?.entries.find((e) => e.id === made) ?? null;
  const unpriced = Boolean(data?.entries.some((e) => (e.state === 'held' || e.state === 'incoming') && e.usd === null));
  const counts = data ? { held: data.entries.filter((e) => e.state === 'held' || e.state === 'incoming' || e.state === 'moving').length, waiting: data.entries.filter((e) => e.state === 'waiting').length } : null;

  return (
    <ModalLayer>
      <Window title="Wallet" icon={<WalletIcon size={16} />} onClose={onClose} className="win-wallet" role="dialog" full statusBar={counts ? <span>{counts.held} holding · {counts.waiting} waiting for payment</span> : undefined}>
        <div className="wal-lcd" aria-label="Total held">
          <span className="wal-lcd-label">Held here</span>
          <span className="wal-lcd-value">{data ? money(data.totalUsd) || '$0.00' : '…'}</span>
          <span className="wal-lcd-sub">{!data ? '' : !data.ready.wallet ? 'hot wallet locked' : unpriced ? 'some coins have no price yet' : 'swap or send any time'}</span>
        </div>
        {error && <p className="error-text">{error}</p>}
        {data && (
          <>
            {!data.ready.wallet && (
              <div className="warn-box">
                <WarnIcon size={18} /> The hot wallet is locked (WALLET_KEY), so only Monero and other coins work.
              </div>
            )}
            <div className="tabs98" role="tablist">
              {(['receive', 'holdings', 'settings'] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab98 ${tab === t ? 'is-active' : ''}`} onClick={() => setTab(t)}>
                  {t === 'receive' ? 'Receive' : t === 'holdings' ? `Holdings${counts?.held ? ` (${counts.held})` : ''}` : 'Settings'}
                </button>
              ))}
            </div>
            <div className="tab-panel wal-panel" role="tabpanel">
              {tab === 'receive' &&
                (fresh ? (
                  <>
                    <AddressCard e={fresh} />
                    <div className="btn-row">
                      <button type="button" className="btn98" onClick={() => setMade(null)}>
                        Another address
                      </button>
                      <button type="button" className="btn98" onClick={() => (setSelected(fresh.id), setTab('holdings'))}>
                        See in Holdings
                      </button>
                    </div>
                  </>
                ) : (
                  <ReceiveTab
                    data={data}
                    onMade={(e) => {
                      replace(e);
                      states.current.set(e.id, e.state);
                      setMade(e.id);
                    }}
                  />
                ))}
              {tab === 'holdings' && <HoldingsTab data={data} selected={selected} onSelect={setSelected} onChange={replace} />}
              {tab === 'settings' && <SettingsTab data={data} onData={setData} />}
            </div>
          </>
        )}
      </Window>
    </ModalLayer>
  );
}
