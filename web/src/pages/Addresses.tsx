import { useEffect, useState } from 'react';
import { api } from '../api';
import { CoinIcon, HouseIcon, ShieldIcon, WarnIcon } from '../components/art';
import { DelaySlider } from '../components/DelaySlider';
import { QrCode } from '../components/QrCode';
import { ModalLayer, Window } from '../components/Win98';
import { shortAddr, trimAmount, usdt } from '../lib/format';
import { sfx } from '../lib/sound';
import type { Coin, Destination, Quote, Route } from '../types';

const NAMES: Record<Coin, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', XMR: 'Monero' };

/** A payment link that opens a wallet app with the address and amount filled in. */
export function payUri(r: Route, amount: string): string {
  if (r.coin === 'BTC') return `bitcoin:${r.address}?amount=${amount}`;
  if (r.coin === 'XMR') return `monero:${r.address}?tx_amount=${amount}`;
  const [w, f = ''] = amount.split('.');
  const wei = BigInt(w + f.padEnd(18, '0').slice(0, 18));
  return `ethereum:${r.address}@1?value=${wei}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function SendForm({ route }: { route: Route }) {
  const [usd, setUsd] = useState('20');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setQuote(null);
    setError('');
  }, [route.id]);

  async function go() {
    setBusy(true);
    setError('');
    try {
      setQuote(await api.quote(route.coin, Number(usd), route.mode));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't get a price");
    } finally {
      setBusy(false);
    }
  }

  const below = quote && Number(quote.amount) < Number(quote.minAmount);
  return (
    <fieldset className="group98 send98">
      <legend>Send to this address</legend>
      <form className="send-row" onSubmit={(e) => (e.preventDefault(), void go())}>
        <span>$</span>
        <input className="input98" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Amount in US dollars" />
        <button type="submit" className="btn98" disabled={busy || !(Number(usd) > 0)}>
          {busy ? '…' : 'Work it out'}
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
      {quote && (
        <>
          <p className="send-quote">
            ≈ <b>
              {trimAmount(quote.amount)} {route.coin}
            </b>{' '}
            → about <b>{usdt(quote.usdtEstimate)} USDT</b> in {route.destinationLabel}
          </p>
          {below && (
            <p className="error-text">
              FixedFloat's minimum here is {trimAmount(quote.minAmount)} {route.coin} (≈ ${usdt(String(quote.minUsd))}). Smaller payments wait at this address until they add up to it.
            </p>
          )}
          <div className="send-pay">
            <QrCode value={payUri(route, quote.amount)} size={132} logo={<CoinIcon coin={route.coin} size={24} />} />
            <div>
              <a className="btn98 is-default btn-link pay-link" href={payUri(route, quote.amount)}>
                Open in wallet
              </a>
              <p className="line-sub">Opens your wallet app with the address and amount filled in. Check both before you swipe.</p>
            </div>
          </div>
        </>
      )}
    </fieldset>
  );
}

function NewForm({
  delays,
  destinations,
  available,
  onCreated,
  onCancel,
}: {
  delays: number[];
  destinations: Destination[];
  available: Record<Coin | 'privacy', boolean>;
  onCreated(r: Route): void;
  onCancel(): void;
}) {
  const coins = (['BTC', 'ETH', 'XMR'] as Coin[]).filter((c) => available[c]);
  const [coin, setCoin] = useState<Coin>(coins[0] ?? 'XMR');
  const [mode, setMode] = useState<'direct' | 'privacy'>('direct');
  const [delay, setDelay] = useState(delays.includes(24) ? 24 : delays[0]);
  const [dest, setDest] = useState(destinations[0]?.id ?? 'coinbase');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const privacyOk = coin !== 'XMR' && available.privacy;

  async function go() {
    setBusy(true);
    setError('');
    try {
      onCreated(await api.createAddress({ coin, mode: privacyOk ? mode : 'direct', delayHours: privacyOk && mode === 'privacy' ? delay : null, destinationId: dest, label }));
      sfx.open();
    } catch (e) {
      sfx.error();
      setError(e instanceof Error ? e.message : "Couldn't make the address");
    } finally {
      setBusy(false);
    }
  }

  if (!coins.length) {
    return (
      <div className="warn-box">
        <WarnIcon size={20} /> No hot wallet is set up on the server yet (MONERO_RPC_URL for Monero; WALLET_KEY and wallet:init for Bitcoin/Ethereum).
      </div>
    );
  }
  return (
    <form onSubmit={(e) => (e.preventDefault(), void go())}>
      <fieldset className="group98">
        <legend>New permanent address</legend>
        <div className="seg98" role="radiogroup" aria-label="Coin">
          {coins.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={coin === c} className={`btn98 seg-btn ${coin === c ? 'is-pressed' : ''}`} onClick={() => setCoin(c)}>
              <CoinIcon coin={c} size={20} /> {NAMES[c]}
            </button>
          ))}
        </div>
        {privacyOk && (
          <div className="seg98" role="radiogroup" aria-label="Route">
            <button type="button" role="radio" aria-checked={mode === 'direct'} className={`btn98 seg-btn ${mode === 'direct' ? 'is-pressed' : ''}`} onClick={() => setMode('direct')}>
              Straight to USDT
            </button>
            <button type="button" role="radio" aria-checked={mode === 'privacy'} className={`btn98 seg-btn ${mode === 'privacy' ? 'is-pressed' : ''}`} onClick={() => setMode('privacy')}>
              <ShieldIcon size={18} /> Privacy Enhanced
            </button>
          </div>
        )}
        {privacyOk && mode === 'privacy' && (
          <>
            <span className="lbl">
              Wait in Monero: <b>{delay} hours</b> (you can change it later)
            </span>
            <DelaySlider value={delay} delays={delays} onChange={setDelay} />
            <p className="line-sub">Payments collect here until they reach FixedFloat's ≈ $110 minimum for swapping into Monero.</p>
          </>
        )}
        <label className="field">
          <span className="lbl">USDT goes to (fixed for this address):</span>
          <select className="input98 select98" value={dest} onChange={(e) => setDest(e.target.value)}>
            {destinations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label} ({shortAddr(d.address)})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Name (optional):</span>
          <input className="input98" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Rent → Coinbase" />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="btn-row">
          <button type="submit" className="btn98 is-default" disabled={busy}>
            {busy ? 'Making…' : 'Make address'}
          </button>
          <button type="button" className="btn98" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}

interface Props {
  delays: number[];
  destinations: Destination[];
  seedBackupPending?: boolean;
  onClose(): void;
}

/** Permanent addresses: save one in your phone wallet once, pay it any time. */
export function Addresses({ delays, destinations, seedBackupPending, onClose }: Props) {
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [available, setAvailable] = useState<Record<Coin | 'privacy', boolean>>({ BTC: false, ETH: false, XMR: false, privacy: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .addresses()
      .then((r) => {
        setRoutes(r.addresses);
        setAvailable(r.available);
        setSelected(r.addresses.find((a) => !a.archived)?.id ?? null);
        if (!r.addresses.length) setMaking(true);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const shown = (routes ?? []).filter((r) => !r.archived);
  const current = shown.find((r) => r.id === selected) ?? null;
  const replace = (r: Route) => setRoutes((list) => (list ?? []).map((x) => (x.id === r.id ? r : x)));

  async function update(patch: { delayHours?: number; archived?: boolean }) {
    if (!current) return;
    try {
      const r = await api.updateAddress(current.id, patch);
      replace(r);
      if (patch.archived) setSelected(shown.find((x) => x.id !== r.id)?.id ?? null);
    } catch (e) {
      sfx.error();
      setError(e instanceof Error ? e.message : 'That did not work');
    }
  }

  return (
    <ModalLayer>
      <Window title="My Addresses" icon={<HouseIcon size={16} />} onClose={onClose} className="win-addresses" role="dialog">
        <p className="line-sub book-intro">
          Save one of these in your phone wallet once. Whatever you send to it is swapped and delivered automatically; its destination never changes.
        </p>
        {seedBackupPending && (
          <div className="warn-box">
            <WarnIcon size={20} /> The hot wallet's 24 words are still in data/seed-backup.txt on the server. Write them down, then delete that file.
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
        {routes === null && !error && <p>Loading…</p>}

        {shown.length > 0 && (
          <ul className="listbox book-list" role="listbox" aria-label="Permanent addresses">
            {shown.map((r) => (
              <li
                key={r.id}
                role="option"
                aria-selected={r.id === current?.id}
                className={r.id === current?.id ? 'is-selected' : ''}
                tabIndex={0}
                onClick={() => (setSelected(r.id), setMaking(false), setCopied(false))}
                onKeyDown={(e) => e.key === 'Enter' && setSelected(r.id)}
              >
                <CoinIcon coin={r.coin} size={18} />
                <span className="book-name">{r.label}</span>
                {r.mode === 'privacy' && <ShieldIcon size={16} />}
                <code className="book-addr">{shortAddr(r.address)}</code>
              </li>
            ))}
          </ul>
        )}

        {making && routes !== null && (
          <NewForm
            delays={delays}
            destinations={destinations}
            available={available}
            onCancel={() => setMaking(false)}
            onCreated={(r) => {
              setRoutes((list) => [...(list ?? []), r]);
              setSelected(r.id);
              setMaking(false);
            }}
          />
        )}

        {!making && current && (
          <div className="route-detail">
            <div className="receive-grid">
              <div className="qr-box">
                <QrCode value={current.address} size={150} logo={<CoinIcon coin={current.coin} size={30} />} />
              </div>
              <div className="receive-info">
                <span className="lbl">
                  {NAMES[current.coin]} → {current.mode === 'privacy' ? `Monero (${current.delayHours} h) → ` : ''}USDT in <b>{current.destinationLabel}</b>
                </span>
                <div className="address-box" onClick={() => void copyText(current.address).then((ok) => ok && (sfx.copy(), setCopied(true)))} title="Click to copy">
                  {current.address}
                </div>
                <button type="button" className="btn98" onClick={() => void copyText(current.address).then((ok) => ok && (sfx.copy(), setCopied(true)))}>
                  {copied ? 'Copied!' : 'Copy address'}
                </button>
                {current.mode === 'privacy' && (
                  <div className="route-delay">
                    <span className="lbl">Wait in Monero for the next payments:</span>
                    <DelaySlider value={current.delayHours ?? delays[0]} delays={delays} onChange={(h) => void update({ delayHours: h })} />
                  </div>
                )}
              </div>
            </div>
            <SendForm route={current} />
          </div>
        )}

        <div className="btn-row">
          {!making && routes !== null && (
            <button type="button" className="btn98" onClick={() => setMaking(true)}>
              New address…
            </button>
          )}
          {!making && current && (
            <button type="button" className="btn98" onClick={() => void update({ archived: true })} title="Hide it from this list (payments to it still go through)">
              Hide
            </button>
          )}
          <button type="button" className="btn98 is-default" onClick={onClose}>
            Close
          </button>
        </div>
      </Window>
    </ModalLayer>
  );
}
