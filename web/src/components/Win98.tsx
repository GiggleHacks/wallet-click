import { animate, motion, useDragControls, useMotionValue } from 'motion/react';
import { createContext, useContext, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { sfx } from '../lib/sound';
import { useTheme } from '../lib/themes';

/** The area windows can be dragged around in (the desktop, or a dialog's layer). */
export const DragBounds = createContext<RefObject<HTMLElement | null> | null>(null);

interface WindowProps {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Close button in the title bar. */
  onClose?(): void;
  /** Show the decorative minimize/maximize buttons too. */
  full?: boolean;
  inactive?: boolean;
  statusBar?: ReactNode;
  role?: string;
}

type GlyphKind = 'min' | 'max' | 'close';

/** Title bar button glyphs: chunky 9x ones and thin modern ones (the stylesheet shows the right set). */
const Glyph = ({ kind }: { kind: GlyphKind }) => (
  <>
    <svg className="glyph-classic" viewBox="0 0 8 7" width="8" height="7" aria-hidden="true">
      {kind === 'min' && <rect x="1" y="5" width="6" height="2" />}
      {kind === 'max' && <path d="M0 0h8v7H0zM1 2v4h6V2z" fillRule="evenodd" />}
      {kind === 'close' && <path d="M0 0h2l2 2 2-2h2L5 3.5 8 7H6L4 5 2 7H0l3-3.5z" />}
    </svg>
    <svg className="glyph-modern" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
      {kind === 'min' && <path d="M0 5.5h10" />}
      {kind === 'max' && <rect x=".5" y=".5" width="9" height="9" rx="1" />}
      {kind === 'close' && <path d="m.5.5 9 9m0-9-9 9" />}
    </svg>
  </>
);

/** A Win98 window. Drag it by the title bar; double-click the title bar to put it back. */
export function Window({ title, icon, children, className = '', onClose, full, inactive, statusBar, role }: WindowProps) {
  const controls = useDragControls();
  const bounds = useContext(DragBounds);
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    controls.start(e);
  };
  const recenter = () => {
    void animate(x, 0, { duration: 0.2 });
    void animate(y, 0, { duration: 0.2 });
  };

  return (
    <motion.section
      className={`win ${className}`}
      role={role}
      aria-label={title}
      aria-modal={role === 'dialog' || role === 'alertdialog' ? true : undefined}
      style={{ x, y }}
      drag
      dragControls={controls}
      dragListener={false}
      dragMomentum={false}
      dragElastic={0}
      dragConstraints={bounds ?? undefined}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
    >
      <header className={`titlebar ${inactive ? 'is-inactive' : ''}`} onPointerDown={startDrag} onDoubleClick={recenter}>
        {icon && <span className="titlebar-icon">{icon}</span>}
        <span className="titlebar-text">{title}</span>
        <span className="titlebar-btns">
          {full && (
            <>
              <button type="button" className="tb-btn" tabIndex={-1} aria-hidden="true">
                <Glyph kind="min" />
              </button>
              <button type="button" className="tb-btn" tabIndex={-1} aria-hidden="true">
                <Glyph kind="max" />
              </button>
            </>
          )}
          {onClose && (
            <button type="button" className="tb-btn tb-close" onClick={() => (sfx.tap(), onClose())} aria-label="Close">
              <Glyph kind="close" />
            </button>
          )}
        </span>
      </header>
      <div className="win-body">{children}</div>
      {statusBar && <footer className="statusbar">{statusBar}</footer>}
    </motion.section>
  );
}

/** A full-screen layer for dialogs; windows inside it can be dragged anywhere on it. */
export function ModalLayer({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="modal-layer">
      <DragBounds.Provider value={ref}>{children}</DragBounds.Provider>
    </div>
  );
}

/** The segmented blue 9x progress bar, or a smooth modern one. */
export function ProgressBar({ percent, blocks = 26 }: { percent: number; blocks?: number }) {
  const theme = useTheme();
  const clamped = Math.min(100, Math.max(0, percent));
  if (theme.shell !== 'classic') {
    return (
      <div className="progress-modern" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}>
        <span style={{ width: `${clamped}%` }} />
      </div>
    );
  }
  const filled = Math.round((clamped / 100) * blocks);
  return (
    <div className="progress98" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      {Array.from({ length: blocks }, (_, i) => (
        <span key={i} className={`seg ${i < filled ? 'is-on' : ''}`} />
      ))}
    </div>
  );
}

/** The Windows 10/11 copy dialog's throughput graph: a wavy area that fills in as the transfer progresses. */
export function SpeedGraph({ percent, seed }: { percent: number; seed: string }) {
  const points = useMemo(() => {
    let h = 2166136261;
    for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
    const raw = Array.from({ length: 41 }, () => 0.3 + rnd() * 0.45);
    // A little smoothing so it looks like a throughput curve, not noise.
    return raw.map((_, i) => (raw[Math.max(0, i - 1)] + raw[i] * 2 + raw[Math.min(raw.length - 1, i + 1)]) / 4);
  }, [seed]);
  const x = Math.min(100, Math.max(0, percent));
  const upTo = points.filter((_, i) => i * 2.5 <= x);
  const line = upTo.map((v, i) => `${(i * 2.5).toFixed(1)},${(40 - v * 40).toFixed(1)}`).join(' ');
  return (
    <div className="speed-graph" aria-hidden="true">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none">
        {[10, 20, 30].map((y) => (
          <line key={y} x1="0" x2="100" y1={y} y2={y} className="grid" />
        ))}
        {upTo.length > 1 && (
          <>
            <polygon className="area" points={`0,40 ${line} ${((upTo.length - 1) * 2.5).toFixed(1)},40`} />
            <polyline className="edge" points={line} />
          </>
        )}
      </svg>
    </div>
  );
}
