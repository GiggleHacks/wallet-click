import { useState } from 'react';
import { ClockIcon } from '../components/art';
import { SendOptionsFields } from '../components/SendOptions';
import { Tip } from '../components/Tip';
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
  /** What the destination is paid in ("USDC"). */
  sym?: string;
  /** How it works, with the options as they are in this window. */
  onExplain?(o: SendOptions): void;
  onClose(): void;
}

/** How the coin buttons send what comes in: straight or through Monero, a wait, and how many pieces. */
export function SendOptionsDialog({ value, delays, piecesMax, moneroOk, walletOk, testDelayMin, sym, onExplain, onClose }: Props) {
  const [o, setO] = useState<SendOptions>(value.route === 'monero' && !moneroOk ? { ...value, route: 'direct' } : value);
  const save = () => {
    saveSendOptions(o);
    sfx.tap();
    onClose();
  };
  return (
    <ModalLayer>
      <Window title="Send options" icon={<ClockIcon size={16} />} onClose={onClose} className="win-sendopts" role="dialog">
        <SendOptionsFields value={o} onChange={setO} delays={delays} piecesMax={piecesMax} moneroOk={moneroOk} walletOk={walletOk} sym={sym} onExplain={onExplain && (() => onExplain(o))} />
        {testDelayMin !== null && (
          <p className="line-sub">
            <Tip tip={`Every wait is ${testDelayMin} minutes, and pieces are seconds apart.`}>
              <b>Test mode</b>
            </Tip>
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
