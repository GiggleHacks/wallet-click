import QRCode from 'qrcode';
import { useMemo, type ReactNode } from 'react';

/** Square-module QR with a logo in the middle (error correction H keeps it scannable). */
export function QrCode({ value, size = 232, logo }: { value: string; size?: number; logo?: ReactNode }) {
  const { n, modules, logoStart, logoCells } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'H' });
    const count = qr.modules.size;
    const cells = (Math.ceil(count * 0.24) | 1) + 0;
    return { n: count, modules: qr.modules, logoStart: (count - cells) / 2, logoCells: cells };
  }, [value]);

  const inFinder = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  const inLogo = (r: number, c: number) =>
    logo !== undefined && r >= logoStart - 0.5 && r < logoStart + logoCells + 0.5 && c >= logoStart - 0.5 && c < logoStart + logoCells + 0.5;

  const cells: ReactNode[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules.get(r, c) && !inFinder(r, c) && !inLogo(r, c)) {
        cells.push(<rect key={`${r}-${c}`} x={c} y={r} width={1.02} height={1.02} />);
      }
    }
  }

  const eye = (x: number, y: number) => (
    <g key={`eye-${x}-${y}`}>
      <rect x={x + 0.5} y={y + 0.5} width={6} height={6} fill="none" stroke="currentColor" strokeWidth={1} />
      <rect x={x + 2} y={y + 2} width={3} height={3} />
    </g>
  );

  return (
    <div className="qr" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" role="img" aria-label="QR code of the address">
        <g fill="currentColor">
          {cells}
          {eye(0, 0)}
          {eye(n - 7, 0)}
          {eye(0, n - 7)}
        </g>
      </svg>
      {logo && <div className="qr-logo">{logo}</div>}
    </div>
  );
}
