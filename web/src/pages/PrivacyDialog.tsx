import { useState } from 'react';
import { api } from '../api';
import { CoinIcon, ShieldIcon, VaultIcon } from '../components/art';
import { DelaySlider } from '../components/DelaySlider';
import { ModalLayer, Window } from '../components/Win98';
import { sfx } from '../lib/sound';
import type { Coin, Destination, Transfer } from '../types';

interface Props {
  delays: number[];
  destinations: Destination[];
  destinationId: string;
  /** The Monero wallet isn't connected on the server. */
  unavailable: boolean;
  testDelayMin: number | null;
  onCreated(t: Transfer): void;
  onClose(): void;
}

/** Privacy Enhanced with a fresh address: BTC/ETH → Monero → wait → USDT. */
export function PrivacyDialog({ delays, destinations, destinationId, unavailable, testDelayMin, onCreated, onClose }: Props) {
  const [coin, setCoin] = useState<Coin>('BTC');
  const [delay, setDelay] = useState(delays.includes(24) ? 24 : delays[0]);
  const [dest, setDest] = useState(destinationId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const label = destinations.find((d) => d.id === dest)?.label ?? 'Coinbase';

  async function go() {
    setBusy(true);
    setError('');
    document.body.classList.add('busy');
    try {
      onCreated(await api.createPrivacy(coin, delay, dest));
      sfx.open();
    } catch (e) {
      sfx.error();
      setError(e instanceof Error ? e.message : "Couldn't get an address");
    } finally {
      setBusy(false);
      document.body.classList.remove('busy');
    }
  }

  return (
    <ModalLayer>
      <Window title="Privacy Enhanced" icon={<ShieldIcon size={16} />} onClose={onClose} className="win-privacy" role="dialog">
        <div className="privacy-head">
          <ShieldIcon size={40} />
          <p>
            Your payment is swapped to <b>Monero</b> first and held in your own wallet. After the wait it's swapped to <b>USDT</b> and sent to <b>{label}</b>.
          </p>
        </div>

        <fieldset className="group98">
          <legend>Pay with</legend>
          <div className="seg98" role="radiogroup" aria-label="Pay with">
            {(['BTC', 'ETH'] as const).map((c) => (
              <button key={c} type="button" role="radio" aria-checked={coin === c} className={`btn98 seg-btn ${coin === c ? 'is-pressed' : ''}`} onClick={() => setCoin(c)}>
                <CoinIcon coin={c} size={22} /> {c === 'BTC' ? 'Bitcoin' : 'Ethereum'}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="group98">
          <legend>
            Wait in Monero: <b>{delay} hours</b>
          </legend>
          <DelaySlider value={delay} delays={delays} onChange={setDelay} />
          <p className="line-sub">
            <VaultIcon size={14} /> The wait starts once the Monero has arrived and unlocked (about 20 minutes after the first swap), plus a random extra of up to 30 minutes.
            {testDelayMin !== null && <b> Test mode on this server: the wait is {testDelayMin} minutes.</b>}
          </p>
        </fieldset>

        {destinations.length > 1 && (
          <label className="field">
            <span className="lbl">USDT goes to:</span>
            <select className="input98 select98" value={dest} onChange={(e) => setDest(e.target.value)}>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <ul className="hints">
          <li>
            FixedFloat only swaps <b>about $110 or more</b> into Monero. A smaller payment can't go through this way (it's sent back).
          </li>
          <li>Two swaps means two FixedFloat fees (0.5% each) plus small network fees.</li>
          <li>It hides the link from outside observers. FixedFloat still sees both swaps.</li>
        </ul>
        {unavailable && <p className="error-text">The VPS Monero wallet isn't connected (MONERO_RPC_URL), so this is off.</p>}
        {error && <p className="error-text">{error}</p>}
        <div className="btn-row">
          <button type="button" className="btn98 is-default" onClick={() => void go()} disabled={busy || unavailable}>
            {busy ? 'Getting address…' : 'Get address'}
          </button>
          <button type="button" className="btn98" onClick={onClose}>
            Cancel
          </button>
        </div>
      </Window>
    </ModalLayer>
  );
}
