import { useState } from 'react';
import { ClockIcon } from '../components/art';
import { SendOptionsFields } from '../components/SendOptions';
import { ModalLayer, Window } from '../components/Win98';
import { saveSendOptions, type SendOptions } from '../lib/sendOptions';
import { sfx } from '../lib/sound';

interface Props {
  value: SendOptions;
  delays: number[];
  piecesMax?: number;
  /** The VPS Monero wallet is connected. */
  moneroOk: boolean;
  /** The Bitcoin/Ethereum hot wallet is unlocked. */
  walletOk: boolean;
  testDelayMin: number | null;
  /** What the destination is paid in ("USDT", "USDC"). */
  sym?: string;
  onClose(): void;
}

/** How the coin buttons send what comes in: straight or through Monero, a wait, and how many pieces. */
export function SendOptionsDialog({ value, delays, piecesMax, moneroOk, walletOk, testDelayMin, sym, onClose }: Props) {
  const [o, setO] = useState<SendOptions>(value.route === 'monero' && !moneroOk ? { ...value, route: 'direct' } : value);
  const save = () => {
    saveSendOptions(o);
    sfx.tap();
    onClose();
  };
  return (
    <ModalLayer>
      <Window title="Send options" icon={<ClockIcon size={16} />} onClose={onClose} className="win-sendopts" role="dialog">
        <div className="privacy-head">
          <ClockIcon size={36} />
          <p>How the coin buttons send what you're paid. Your choice stays until you change it; each permanent address keeps its own.</p>
        </div>
        <SendOptionsFields value={o} onChange={setO} delays={delays} piecesMax={piecesMax} moneroOk={moneroOk} walletOk={walletOk} sym={sym} />
        {testDelayMin !== null && (
          <p className="line-sub">
            <b>Test mode on this server:</b> every wait is {testDelayMin} minutes, and pieces are seconds apart.
          </p>
        )}
        <div className="btn-row">
          <button type="button" className="btn98 is-default" onClick={save}>
            OK
          </button>
          <button type="button" className="btn98" onClick={onClose}>
            Cancel
          </button>
        </div>
      </Window>
    </ModalLayer>
  );
}
