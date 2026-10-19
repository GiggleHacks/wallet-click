import type { Coin } from '../types';

/** Hand-drawn SVG icons. Coins share a 32×32 box. */

interface IconProps {
  size?: number;
  className?: string;
}

const Svg = ({ size = 32, className, children, label }: IconProps & { children: React.ReactNode; label: string }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} className={className} role="img" aria-label={label}>
    {children}
  </svg>
);

/** A coin rim: a darker edge and a highlight, so flat brand colours read as metal. */
const Rim = ({ fill, edge }: { fill: string; edge: string }) => (
  <>
    <circle cx="16" cy="16.6" r="15" fill={edge} />
    <circle cx="16" cy="16" r="15" fill={fill} />
    <path d="M5.5 10.5A12.5 12.5 0 0 1 22 4.6" fill="none" stroke="#fff" strokeOpacity=".45" strokeWidth="1.6" strokeLinecap="round" />
  </>
);

export function BtcIcon(p: IconProps) {
  return (
    <Svg {...p} label="Bitcoin">
      <Rim fill="#f7931a" edge="#b8650a" />
      <g transform="rotate(14 16 16)" fill="#fff">
        <rect x="12.6" y="6.6" width="1.9" height="3.2" />
        <rect x="16" y="6.6" width="1.9" height="3.2" />
        <rect x="12.6" y="22.2" width="1.9" height="3.2" />
        <rect x="16" y="22.2" width="1.9" height="3.2" />
        <path d="M10.6 9h7.3c2.6 0 4.2 1.4 4.2 3.5 0 1.4-.8 2.5-2 3 1.6.4 2.6 1.7 2.6 3.4 0 2.5-1.9 4.1-4.8 4.1h-7.3v-2.2h1.6V11.2h-1.6zm4.5 2.3v3.6h2.4c1.1 0 1.8-.7 1.8-1.8s-.7-1.8-1.8-1.8zm0 5.8v3.9h2.8c1.3 0 2-.8 2-2s-.7-1.9-2-1.9z" />
      </g>
    </Svg>
  );
}

export function EthIcon(p: IconProps) {
  return (
    <Svg {...p} label="Ethereum">
      <Rim fill="#627eea" edge="#3c55b8" />
      <path d="M16 4.5v8.6l7.3 3.2z" fill="#fff" fillOpacity=".6" />
      <path d="M16 4.5 8.7 16.3l7.3-3.2z" fill="#fff" />
      <path d="M16 22v5.5l7.3-10.1z" fill="#fff" fillOpacity=".6" />
      <path d="M16 27.5V22l-7.3-4.6z" fill="#fff" />
      <path d="m16 20.6 7.3-4.3-7.3-3.2z" fill="#fff" fillOpacity=".2" />
      <path d="m8.7 16.3 7.3 4.3v-7.5z" fill="#fff" fillOpacity=".6" />
    </Svg>
  );
}

export function UsdtIcon(p: IconProps) {
  return (
    <Svg {...p} label="USDT">
      <Rim fill="#26a17b" edge="#167257" />
      <path d="M9 8.6h14v3.4h-5.2v2.3c3.6.2 6.3.9 6.3 1.8s-2.7 1.6-6.3 1.8v7.5h-3.6v-7.5c-3.6-.2-6.3-.9-6.3-1.8s2.7-1.6 6.3-1.8V12H9zm5.2 6.4c-2.6.1-4.6.5-4.6.9s2 .8 4.6.9v-.1c.6.1 1.2.1 1.8.1s1.2 0 1.8-.1v.1c2.6-.1 4.6-.5 4.6-.9s-2-.8-4.6-.9v1.3c-.6 0-1.2.1-1.8.1s-1.2 0-1.8-.1z" fill="#fff" />
    </Svg>
  );
}

export function UsdcIcon(p: IconProps) {
  return (
    <Svg {...p} label="USDC">
      <Rim fill="#2775ca" edge="#194d8c" />
      <path d="M16 6.2a9.8 9.8 0 1 0 0 19.6 9.8 9.8 0 0 0 0-19.6zm0 2.1a7.7 7.7 0 1 1 0 15.4 7.7 7.7 0 0 1 0-15.4z" fill="#fff" />
      <path d="M17.3 11.1c1.7.3 2.8 1.2 2.9 2.7h-1.7c-.1-.8-.7-1.2-1.7-1.2-1 0-1.6.4-1.6 1 0 .7.6.9 2 1.2 1.9.4 3 1 3 2.5 0 1.3-1 2.2-2.6 2.5v1.2h-1.5v-1.2c-1.8-.3-2.9-1.2-3-2.8h1.7c.1.9.8 1.4 1.9 1.4 1.1 0 1.8-.4 1.8-1.1 0-.7-.5-.9-2-1.3-1.8-.4-2.9-1-2.9-2.4 0-1.2.9-2.1 2.5-2.4V9.8h1.5z" fill="#fff" />
    </Svg>
  );
}

/** The coin a destination is paid in. */
export const StableIcon = ({ ccy, ...p }: IconProps & { ccy?: string | null }) => (ccy === 'USDT' ? <UsdtIcon {...p} /> : <UsdcIcon {...p} />);

/** A plain blue "C" coin standing in for Coinbase (not the official artwork). */
export function CoinbaseIcon(p: IconProps) {
  return (
    <Svg {...p} label="Coinbase">
      <Rim fill="#0052ff" edge="#0036a8" />
      <path d="M21.2 12.2A6.4 6.4 0 1 0 21.2 19.8" fill="none" stroke="#fff" strokeWidth="4" />
    </Svg>
  );
}

export function XmrIcon(p: IconProps) {
  return (
    <Svg {...p} label="Monero">
      {/* The official symbol, scaled into the 30px coin: a white disc, the orange top with the "M" cut out of it
          (its feet run out to the rim), and the grey base with the V notch under the M. */}
      <circle cx="16" cy="16.6" r="15" fill="#b34700" />
      <circle cx="16" cy="16" r="15" fill="#fff" />
      <path d="M16 1A15 15 0 0 0 1.76 20.74H6.25V8.12L16 17.87l9.75-9.75v12.62h4.49A15 15 0 0 0 16 1z" fill="#ff6600" />
      <path d="M3.18 23.79a15 15 0 0 0 25.64 0H22.5v-7.94L16 22.35l-6.5-6.5v7.94z" fill="#4c4c4c" />
      <path d="M5.5 10.5A12.5 12.5 0 0 1 22 4.6" fill="none" stroke="#fff" strokeOpacity=".45" strokeWidth="1.6" strokeLinecap="round" />
    </Svg>
  );
}

export const CoinIcon = ({ coin, ...p }: IconProps & { coin: Coin }) =>
  coin === 'BTC' ? <BtcIcon {...p} /> : coin === 'XMR' ? <XmrIcon {...p} /> : <EthIcon {...p} />;

/** Privacy Enhanced: a shield with a keyhole. */
export function ShieldIcon({ size = 32 }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} role="img" aria-label="Privacy Enhanced">
      <path d="M16 2.5 4.5 6.8v8.4c0 7.2 4.9 12.3 11.5 14.3 6.6-2 11.5-7.1 11.5-14.3V6.8z" fill="#3a2a6e" />
      <path d="M16 4.3 6.3 8v7.2c0 6.1 4 10.5 9.7 12.4z" fill="#6a52c4" />
      <path d="M16 4.3 25.7 8v7.2c0 6.1-4 10.5-9.7 12.4z" fill="#5240a8" />
      <circle cx="16" cy="13.6" r="2.9" fill="#ffd23a" />
      <path d="M14.6 15.4h2.8l.9 6.2h-4.6z" fill="#ffd23a" />
    </svg>
  );
}

/** The Monero "vault" where Privacy Enhanced funds wait between the two swaps. */
export function VaultIcon({ size = 32 }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} role="img" aria-label="Monero vault">
      <rect x="3" y="4" width="26" height="23" rx="2" fill="#5b5b5b" />
      <rect x="4.5" y="5.5" width="23" height="20" rx="1.2" fill="#8a8a8a" />
      <circle cx="16" cy="15.5" r="6.6" fill="#ff6600" stroke="#4c4c4c" strokeWidth="1.4" />
      <path d="M16 9.6v11.8M10.1 15.5h11.8M11.8 11.3l8.4 8.4M20.2 11.3l-8.4 8.4" stroke="#fff" strokeWidth="1.3" />
      <circle cx="16" cy="15.5" r="2.2" fill="#4c4c4c" />
      <rect x="6" y="27" width="4" height="2.4" fill="#3a3a3a" />
      <rect x="22" y="27" width="4" height="2.4" fill="#3a3a3a" />
    </svg>
  );
}

/** The address book: a little card file. */
export function EyeIcon({ size = 16, off = false }: IconProps & { off?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" />
      <circle cx="8" cy="8" r="2" />
      {off && <path d="M2.5 13.5l11-11" />}
    </svg>
  );
}

export function BookIcon({ size = 32 }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} role="img" aria-label="Address Book">
      <rect x="5" y="3" width="21" height="26" rx="1.5" fill="#1d5aa8" />
      <rect x="7.5" y="3" width="18.5" height="26" fill="#2f7bd8" />
      <rect x="10.5" y="7" width="12.5" height="6" fill="#fff" />
      <path d="M12 9h9.5M12 11h6" stroke="#2f7bd8" strokeWidth="1" />
      <rect x="25" y="8" width="3" height="4" fill="#ffd23a" />
      <rect x="25" y="14" width="3" height="4" fill="#ff6a3a" />
      <rect x="25" y="20" width="3" height="4" fill="#4bc46a" />
      <path d="M5 6h3M5 10h3M5 14h3M5 18h3M5 22h3M5 26h3" stroke="#0d3a73" strokeWidth="1.2" />
    </svg>
  );
}

/** A permanent address: a house with a coin slot. */
export function HouseIcon({ size = 32 }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} role="img" aria-label="My Addresses">
      <path d="M16 3 2.5 15h3.5v14h20V15h3.5z" fill="#c74d2c" />
      <path d="M6 15 16 6l10 9v14H6z" fill="#f0e2c0" />
      <rect x="13" y="19" width="6" height="10" fill="#7a4a24" />
      <rect x="9" y="17" width="14" height="2.4" rx="1" fill="#333" />
      <circle cx="16" cy="12.2" r="2.6" fill="#ffc83a" stroke="#805300" strokeWidth=".8" />
    </svg>
  );
}

/** The swap station, drawn like the Win98 "My Computer" icon: a beige CRT on a desktop case, swap arrows on screen. */
export function SwapMachine({ size = 56, spinning = false }: IconProps & { spinning?: boolean }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size} role="img" aria-label="Swap">
      {/* desktop case */}
      <path d="M4 41h48v11H4z" fill="#d4d0c8" />
      <path d="M4 52V41h48" fill="none" stroke="#fff" strokeWidth="1.5" />
      <path d="M52 41v11H4" fill="none" stroke="#404040" strokeWidth="1.5" />
      <path d="M31 45h15v2.4H31z" fill="#404040" />
      <path d="M31 47.4h15" stroke="#fff" strokeWidth=".8" />
      <rect x="8" y="45.2" width="3.2" height="2" fill={spinning ? "#2bd13a" : "#2e6b33"} />
      <rect x="13" y="45.2" width="3.2" height="2" fill={spinning ? "#ffcf3a" : "#6b5a20"} className={spinning ? "blink" : undefined} />
      {/* monitor stand */}
      <path d="M21 35.5h14l2 3.5H19z" fill="#b8b4ac" stroke="#404040" strokeWidth="1" />
      {/* monitor: bezel with a darker right side for depth */}
      <path d="M9 3h36v32H9z" fill="#d4d0c8" />
      <path d="M45 3l3 2.5v27L45 35z" fill="#a9a59d" stroke="#404040" strokeWidth="1" />
      <path d="M9 35V3h36" fill="none" stroke="#fff" strokeWidth="1.5" />
      <path d="M45 3v32H9" fill="none" stroke="#404040" strokeWidth="1.5" />
      {/* screen: the classic teal desktop */}
      <rect x="13" y="7" width="28" height="22" fill="#008080" />
      <path d="M13 29V7h28" fill="none" stroke="#404040" strokeWidth="1.2" />
      <path d="M41 7v22H13" fill="none" stroke="#fff" strokeWidth="1" />
      <g transform="translate(27 18) scale(0.7) translate(-28 -25.5)">
        <g className={spinning ? "spin" : undefined} style={{ transformOrigin: "28px 25.5px" }}>
          <path d="M20.5 22.5a8 8 0 0 1 13.6-3.4" fill="none" stroke="#fff" strokeWidth="2.8" />
          <path d="m36.6 15.5-.4 6.6-6.2-2.3z" fill="#fff" />
          <path d="M35.5 28.5a8 8 0 0 1-13.6 3.4" fill="none" stroke="#ffd23a" strokeWidth="2.8" />
          <path d="m19.4 35.5.4-6.6 6.2 2.3z" fill="#ffd23a" />
        </g>
      </g>
    </svg>
  );
}

export function Hourglass({ size = 20 }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className="hourglass" aria-hidden="true">
      <path d="M3 1h10v1.6H12c0 2.6-1.4 4.2-3 5.4 1.6 1.2 3 2.8 3 5.4h1V15H3v-1.6h1c0-2.6 1.4-4.2 3-5.4-1.6-1.2-3-2.8-3-5.4H3z" fill="currentColor" />
      <path d="M5.4 2.6h5.2c0 2-1.1 3.4-2.6 4.4-1.5-1-2.6-2.4-2.6-4.4z" fill="#fff" />
      <path d="M5.4 13.4c0-1.6 1-2.8 2.6-3.9 1.6 1.1 2.6 2.3 2.6 3.9z" fill="#c8a24a" />
      <path d="M6.6 4.2h2.8c-.3.8-.8 1.4-1.4 1.9-.6-.5-1.1-1.1-1.4-1.9z" fill="#c8a24a" />
    </svg>
  );
}

/** Send options: a stopwatch (the wait) over three coins in a row (the pieces). */
export function ClockIcon({ size = 32 }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect x="13" y="1.5" width="6" height="3" rx="1" fill="#4c4c4c" />
      <rect x="15" y="4" width="2" height="2.5" fill="#4c4c4c" />
      <circle cx="16" cy="15" r="10" fill="#fff" stroke="#2b2b8f" strokeWidth="2.2" />
      <path d="M16 8.5V15l4.5 2.6" fill="none" stroke="#2b2b8f" strokeWidth="2" strokeLinecap="round" />
      <circle cx="16" cy="15" r="1.4" fill="#c0392b" />
      <circle cx="7" cy="28" r="3" fill="#f7931a" stroke="#a35f00" strokeWidth=".8" />
      <circle cx="16" cy="28" r="3" fill="#26a17b" stroke="#17654d" strokeWidth=".8" />
      <circle cx="25" cy="28" r="3" fill="#ff6600" stroke="#a34100" strokeWidth=".8" />
    </svg>
  );
}

/** Small app mark (a coin with a swap arrow) for the title bar, Start button and favicon. */
export function AppMark({ size = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <circle cx="7" cy="8.4" r="6" fill="#805300" />
      <circle cx="7" cy="8" r="6" fill="#ffc83a" />
      <text x="7" y="11" textAnchor="middle" fontSize="8" fontWeight="700" fontFamily="Tahoma, Arial, sans-serif" fill="#805300">
        $
      </text>
      <path d="M11.5 1.5h3v3" fill="none" stroke="#000080" strokeWidth="1.6" />
      <path d="M14.5 1.5 10 6" stroke="#000080" strokeWidth="1.6" />
    </svg>
  );
}

export function Speaker({ size = 16, muted }: IconProps & { muted?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <path d="M2 6h3l4-3.5v11L5 10H2z" fill="#ffd700" stroke="#000" strokeWidth=".8" />
      {muted ? (
        <path d="m10.5 5.5 4 5m0-5-4 5" stroke="#c00000" strokeWidth="1.6" />
      ) : (
        <>
          <path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8" fill="none" stroke="#000" strokeWidth="1.1" />
          <path d="M12.3 3.9a5.8 5.8 0 0 1 0 8.2" fill="none" stroke="#000" strokeWidth="1.1" />
        </>
      )}
    </svg>
  );
}

export function KeyIcon({ size = 40 }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <circle cx="10" cy="16" r="6.5" fill="#ffd23a" stroke="#000" strokeWidth="1.2" />
      <circle cx="8.6" cy="16" r="2" fill="#c0c0c0" stroke="#000" strokeWidth="1" />
      <path d="M16 14.6h13v2.8h-2v3h-2.6v-3h-1.6v2h-2.4v-2H16z" fill="#ffd23a" stroke="#000" strokeWidth="1.2" />
    </svg>
  );
}

export function WarnIcon({ size = 32 }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path d="M16 3 30 28H2z" fill="#ffd23a" stroke="#000" strokeWidth="1.4" strokeLinejoin="round" />
      <rect x="14.6" y="11" width="2.8" height="9" fill="#000" />
      <rect x="14.6" y="22.4" width="2.8" height="2.8" fill="#000" />
    </svg>
  );
}

export function CheckBadge({ size = 18 }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <circle cx="8" cy="8" r="7.2" fill="#008a00" stroke="#003c00" strokeWidth="1" />
      <path d="m4.4 8.2 2.4 2.4 4.8-5" fill="none" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

/** Desktop icon: a monitor with colour swatches (Display Properties). */
export function DisplayIcon({ size = 32 }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path d="M3 3h24v18H3z" fill="#d4d0c8" stroke="#404040" strokeWidth="1" />
      <rect x="5.5" y="5.5" width="19" height="13" fill="#008080" />
      <path d="M5.5 18.5h19v-6c-4 3-8-2-12 1-3 2-5 1-7 0z" fill="#5fae3a" />
      <circle cx="20" cy="9" r="2" fill="#ffe27a" />
      <path d="M11 21h8l1.5 3h-11z" fill="#b8b4ac" stroke="#404040" strokeWidth="1" />
      <rect x="22" y="22" width="4" height="4" fill="#e83030" stroke="#000" strokeWidth=".8" />
      <rect x="25" y="25" width="4" height="4" fill="#2a6fd6" stroke="#000" strokeWidth=".8" />
      <rect x="19" y="25" width="4" height="4" fill="#ffd23a" stroke="#000" strokeWidth=".8" />
    </svg>
  );
}

/** Desktop icon: a little film/media player with a play button (the demo). */
export function PlayIcon({ size = 32 }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path d="M3 6h26v20H3z" fill="#d4d0c8" stroke="#404040" strokeWidth="1" />
      <path d="M3 6h26v3H3z" fill="#000080" />
      <rect x="6" y="11" width="20" height="12" fill="#000" />
      <path d="m13.5 13.5 7 3.5-7 3.5z" fill="#38ff8a" />
      <rect x="5" y="7" width="1.6" height="1.2" fill="#fff" />
    </svg>
  );
}

/** The swap station for the modern themes: a flat "This PC" monitor with the swap arrows on screen. */
export function ModernPC({ size = 56, spinning = false, variant }: IconProps & { spinning?: boolean; variant: 'win10' | 'win11' }) {
  const w11 = variant === 'win11';
  return (
    <svg viewBox="0 0 56 56" width={size} height={size} role="img" aria-label="Swap">
      <rect x="6" y="3" width="42" height="31" rx={w11 ? 4 : 1} fill={w11 ? '#2b2b2b' : '#1b1b1b'} />
      <rect x="9" y="6" width="36" height="24" rx={w11 ? 2 : 0} fill={w11 ? '#cfe3fa' : '#0078d7'} />
      {w11 ? (
        <path d="M27 18c4-7 10-8 14-6-3 2-7 5-14 6zm0 0c-3-6-9-8-13-5 3 2 7 4 13 5z" fill="#3f8ff0" opacity=".45" />
      ) : (
        <path d="M9 6h36v6H9z" fill="#2b88d8" />
      )}
      <g transform="translate(27 18) scale(0.7) translate(-28 -25.5)">
        <g className={spinning ? 'spin' : undefined} style={{ transformOrigin: '28px 25.5px' }}>
          <path d="M20.5 22.5a8 8 0 0 1 13.6-3.4" fill="none" stroke={w11 ? '#005fb8' : '#fff'} strokeWidth="2.8" strokeLinecap={w11 ? 'round' : 'butt'} />
          <path d="m36.6 15.5-.4 6.6-6.2-2.3z" fill={w11 ? '#005fb8' : '#fff'} />
          <path d="M35.5 28.5a8 8 0 0 1-13.6 3.4" fill="none" stroke={w11 ? '#005fb8' : '#fff'} strokeWidth="2.8" strokeLinecap={w11 ? 'round' : 'butt'} />
          <path d="m19.4 35.5.4-6.6 6.2 2.3z" fill={w11 ? '#005fb8' : '#fff'} />
        </g>
      </g>
      <path d="M22 34h12l1.5 7h-15z" fill={w11 ? '#bdbdbd' : '#8a8a8a'} />
      <rect x="15" y="41" width="26" height="3" rx={w11 ? 1.5 : 0} fill={w11 ? '#d6d6d6' : '#b5b5b5'} />
    </svg>
  );
}

/** Start button glyphs for the modern themes: four flat panes (10) or four rounded tiles (11). */
export function StartGlyph({ variant, size = 16 }: IconProps & { variant: 'win10' | 'win11' }) {
  if (variant === 'win10') {
    return (
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="currentColor">
        <rect x="0" y="0" width="7.4" height="7.4" />
        <rect x="8.6" y="0" width="7.4" height="7.4" />
        <rect x="0" y="8.6" width="7.4" height="7.4" />
        <rect x="8.6" y="8.6" width="7.4" height="7.4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <rect x="0" y="0" width="7.4" height="7.4" rx="1.4" fill="#2b9cf2" />
      <rect x="8.6" y="0" width="7.4" height="7.4" rx="1.4" fill="#1f84e0" />
      <rect x="0" y="8.6" width="7.4" height="7.4" rx="1.4" fill="#1f84e0" />
      <rect x="8.6" y="8.6" width="7.4" height="7.4" rx="1.4" fill="#0b6cce" />
    </svg>
  );
}

/** Line-style speaker for the modern trays. */
export function LineSpeaker({ size = 16, muted }: IconProps & { muted?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.1">
      <path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z" strokeLinejoin="round" />
      {muted ? (
        <path d="m10.5 6 4 4m0-4-4 4" />
      ) : (
        <>
          <path d="M10.5 5.8a3.2 3.2 0 0 1 0 4.4" />
          <path d="M12.2 4a5.6 5.6 0 0 1 0 8" />
        </>
      )}
    </svg>
  );
}

/** The power symbol, for the modern Start menus. */
export function PowerIcon({ size = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M8 1.5v6" />
      <path d="M4.6 3.6a5.5 5.5 0 1 0 6.8 0" />
    </svg>
  );
}

/** A cartoon bomb: round, black, with a fuse (sparking when `lit`) and two wires up to the timer above it. */
export function BombIcon({ size = 48, lit = false }: IconProps & { lit?: boolean }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={`bomb-svg ${lit ? 'is-lit' : ''}`} aria-hidden="true">
      <path d="M17 0c0 6-4 8-3 14" fill="none" stroke="#d42020" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M23 0c1 5 4 7 2 12" fill="none" stroke="#1f5fd6" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="21" cy="30.6" r="15.5" fill="#000" opacity=".3" />
      <circle cx="21" cy="30" r="15.5" fill="#262626" />
      <path d="M33.4 21.6A15.5 15.5 0 0 1 9.6 41a17 17 0 0 0 23.8-19.4z" fill="#000" opacity=".45" />
      <ellipse cx="14.6" cy="23.4" rx="4.6" ry="2.8" transform="rotate(-38 14.6 23.4)" fill="#fff" opacity=".42" />
      <circle cx="11.6" cy="28.4" r="1.1" fill="#fff" opacity=".35" />
      <rect x="27.5" y="11.5" width="9" height="7" rx="1.2" transform="rotate(42 32 15)" fill="#8a8a8a" stroke="#3a3a3a" strokeWidth="1" />
      <path d="M33.8 11.4c2.4-3.4 5.6-4 7.4-2.2 1.4 1.4 1.2 3.4 2.8 4" fill="none" stroke="#c9a46a" strokeWidth="1.8" strokeLinecap="round" />
      {lit && (
        <g transform="translate(44 13)">
          <g className="bomb-spark">
            <path d="M0-6 1.4-1.8 6-2 2.2.6 4.4 5 0 2.4-4.4 5-2.2.6-6-2-1.4-1.8z" fill="#ffd23a" />
            <circle r="2" fill="#fff6c0" />
          </g>
        </g>
      )}
    </svg>
  );
}

/** The comic-book "BOOM!" when a countdown runs out. */
export function BoomBurst({ size = 48 }: IconProps) {
  const spikes = Array.from({ length: 24 }, (_, i) => {
    const r = i % 2 ? 11 : 23;
    const a = (i / 24) * Math.PI * 2;
    return `${(24 + Math.cos(a) * r).toFixed(1)},${(24 + Math.sin(a) * r * 0.86).toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className="boom-svg" role="img" aria-label="Boom">
      <polygon points={spikes} fill="#ffd23a" stroke="#d42020" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="24" cy="24" r="10.5" fill="#ff7a1a" />
      <text x="24" y="28" textAnchor="middle" fontSize="11" fontWeight="900" fill="#fff" stroke="#8a1010" strokeWidth=".8" paintOrder="stroke" fontFamily="Impact, 'Arial Black', sans-serif">
        BOOM!
      </text>
    </svg>
  );
}

/** Desktop icon: a text file with a blue title band and lines (the Logs window). */
export function LogIcon({ size = 32 }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path d="M6 2h15l6 6v22H6z" fill="#fff" stroke="#404040" strokeWidth="1" />
      <path d="M21 2v6h6" fill="#d4d0c8" stroke="#404040" strokeWidth="1" />
      <rect x="8.5" y="5" width="10" height="3" fill="#000080" />
      {[11, 14, 17, 20, 23, 26].map((y, i) => (
        <rect key={y} x="8.5" y={y} width={[15, 12, 16, 9, 14, 11][i]} height="1.4" fill={i === 3 ? '#d42020' : '#5a5a5a'} />
      ))}
    </svg>
  );
}

/** A log line's level: blue "i", yellow warning, red cross. */
export function LevelIcon({ level, size = 14 }: IconProps & { level: 'debug' | 'info' | 'warn' | 'error' }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} role="img" aria-label={level === 'error' ? 'Error' : level === 'warn' ? 'Warning' : 'Info'}>
      {level === 'error' ? (
        <>
          <circle cx="8" cy="8" r="7" fill="#d42020" stroke="#7a0000" />
          <path d="m5.2 5.2 5.6 5.6m0-5.6-5.6 5.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </>
      ) : level === 'warn' ? (
        <>
          <path d="M8 1.2 15.2 14.4H.8z" fill="#ffd23a" stroke="#000" strokeWidth=".9" strokeLinejoin="round" />
          <rect x="7.2" y="5.4" width="1.6" height="5" fill="#000" />
          <rect x="7.2" y="11.4" width="1.6" height="1.6" fill="#000" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="7" fill="#2a6fd6" stroke="#0b3a8a" />
          <rect x="7.1" y="7" width="1.8" height="5" fill="#fff" />
          <circle cx="8" cy="4.6" r="1.1" fill="#fff" />
        </>
      )}
    </svg>
  );
}
