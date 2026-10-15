import { useState } from 'react';
import { api } from '../api';
import { BookIcon, CoinbaseIcon, UsdtIcon } from '../components/art';
import { PasswordField } from '../components/PasswordField';
import { ModalLayer, Window } from '../components/Win98';
import { shortAddr } from '../lib/format';
import { sfx } from '../lib/sound';
import type { Destination } from '../types';

interface Props {
  destinations: Destination[];
  onChange(list: Destination[]): void;
  onClose(): void;
}

/** Saved USDT payout addresses. Adding and removing ask for the password again. */
export function AddressBook({ destinations, onChange, onClose }: Props) {
  const [selected, setSelected] = useState(destinations[0]?.id ?? 'coinbase');
  const [mode, setMode] = useState<'list' | 'add' | 'remove'>('list');
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = destinations.find((d) => d.id === selected) ?? destinations[0];

  const back = () => {
    setMode('list');
    setError('');
    setPassword('');
  };

  async function run(fn: () => Promise<{ destinations: Destination[] }>, after: (list: Destination[]) => void) {
    setBusy(true);
    setError('');
    try {
      const { destinations: list } = await fn();
      onChange(list);
      after(list);
      setPassword('');
      setMode('list');
    } catch (e) {
      sfx.error();
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(
      () => api.addDestination(label, address, password),
      (list) => {
        setSelected(list[list.length - 1]?.id ?? 'coinbase');
        setLabel('');
        setAddress('');
      },
    );
  const remove = () => run(() => api.removeDestination(current.id, password), () => setSelected('coinbase'));

  return (
    <ModalLayer>
      <Window title="Address Book" icon={<BookIcon size={16} />} onClose={onClose} className="win-book" role="dialog">
        <p className="line-sub book-intro">
          Swaps pay out <b>USDT on Ethereum (ERC-20)</b> to one of these. A permanent address always pays the destination it was made with.
        </p>
        <ul className="listbox book-list" role="listbox" aria-label="Destinations">
          {destinations.map((d) => (
            <li
              key={d.id}
              role="option"
              aria-selected={d.id === current?.id}
              className={d.id === current?.id ? 'is-selected' : ''}
              tabIndex={0}
              onClick={() => (setSelected(d.id), mode === 'remove' && back())}
              onKeyDown={(e) => e.key === 'Enter' && setSelected(d.id)}
            >
              {d.builtIn ? <CoinbaseIcon size={18} /> : <UsdtIcon size={18} />}
              <span className="book-name">{d.label}</span>
              <code className="book-addr">{shortAddr(d.address)}</code>
            </li>
          ))}
        </ul>

        {mode === 'list' && current && (
          <div className="book-detail">
            <span className="lbl">
              {current.label}
              <span className="line-sub"> · {current.builtIn ? 'built in' : `added ${new Date(current.createdAt).toLocaleDateString()}`}</span>
            </span>
            <div className="address-box">{current.address}</div>
          </div>
        )}

        {mode === 'add' && (
          <form onSubmit={(e) => (e.preventDefault(), void add())}>
            <fieldset className="group98 book-form">
            <legend>New destination</legend>
            <label className="field">
              <span className="lbl">Name:</span>
              <input className="input98" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Kraken" autoFocus />
            </label>
            <label className="field">
              <span className="lbl">USDT (ERC-20) deposit address:</span>
              <input className="input98 mono" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} autoComplete="off" placeholder="0x…" />
            </label>
            <PasswordField value={password} onChange={setPassword} label="Your password:" />
            {error && <p className="error-text">{error}</p>}
            <div className="btn-row">
              <button type="submit" className="btn98 is-default" disabled={busy || !label.trim() || !address.trim() || !password}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="btn98" onClick={back}>
                Cancel
              </button>
            </div>
            </fieldset>
          </form>
        )}

        {mode === 'remove' && current && (
          <form onSubmit={(e) => (e.preventDefault(), void remove())}>
            <fieldset className="group98 book-form">
            <legend>Remove "{current.label}"?</legend>
            <PasswordField value={password} onChange={setPassword} label="Your password:" autoFocus />
            {error && <p className="error-text">{error}</p>}
            <div className="btn-row">
              <button type="submit" className="btn98 is-default" disabled={busy || !password}>
                {busy ? 'Removing…' : 'Remove'}
              </button>
              <button type="button" className="btn98" onClick={back}>
                Cancel
              </button>
            </div>
            </fieldset>
          </form>
        )}

        {mode === 'list' && (
          <div className="btn-row">
            <button type="button" className="btn98" onClick={() => (setMode('add'), setError(''))}>
              Add…
            </button>
            <button type="button" className="btn98" onClick={() => (setMode('remove'), setError(''))} disabled={!current || current.builtIn}>
              Remove…
            </button>
            <button type="button" className="btn98 is-default" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </Window>
    </ModalLayer>
  );
}
