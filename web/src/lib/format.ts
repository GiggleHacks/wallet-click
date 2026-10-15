import { getPref } from './prefs';

/** The "hide" eye on the home window: amounts and addresses turn into dots everywhere they're shown. */
export const MASK = '•••';
export const MASK_ADDR = '••••…••••';
export const figuresHidden = () => getPref('hideFigures');

export const shortAddr = (a: string) => (figuresHidden() ? MASK_ADDR : a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** "0.01500000" -> "0.015" */
export function trimAmount(v: string | null | undefined): string {
  if (!v) return '';
  if (figuresHidden()) return MASK;
  if (!v.includes('.')) return v;
  return v.replace(/0+$/, '').replace(/\.$/, '');
}

export function usdt(v: string | null | undefined): string {
  const n = Number(v);
  if (figuresHidden()) return Number.isFinite(n) ? MASK : '';
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function minutesText(min: number): string {
  if (min < 1) return 'less than a minute';
  const m = Math.round(min);
  return `about ${m} minute${m === 1 ? '' : 's'}`;
}
