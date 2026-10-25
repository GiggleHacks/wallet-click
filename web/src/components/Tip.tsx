import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The explanation, on hover. `<Tip tip="…">label</Tip>` dots the label's underline; `<Tip tip="…" />` is a small (i).
 * It shows on hover or keyboard focus (and on tap, for fingers), in a yellow Win98 tooltip laid over everything,
 * so a window's edge never cuts it off. Screen readers get the explanation inline.
 */
export function Tip({ tip, children }: { tip: ReactNode; children?: ReactNode }) {
  const at = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !at.current) return setPos(null);
    const r = at.current.getBoundingClientRect();
    const w = box.current?.offsetWidth ?? 260;
    const h = box.current?.offsetHeight ?? 40;
    const above = r.bottom + h + 10 > window.innerHeight && r.top > h + 10;
    const left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
    setPos({ left, top: above ? r.top - h - 6 : r.bottom + 6 });
  }, [open]);

  // A tap elsewhere closes it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !at.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);

  return (
    <span
      ref={at}
      className={children ? 'tip-text' : 'tip-dot'}
      tabIndex={0}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={(e) => (e.stopPropagation(), setOpen((o) => !o))}
    >
      {children ?? <span aria-hidden="true">i</span>}
      {/* the explanation for screen readers (the yellow box is for eyes) */}
      <span className="sr-only"> ({tip})</span>
      {open &&
        createPortal(
          <span ref={box} className="tip-box" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}>
            {tip}
          </span>,
          document.body,
        )}
    </span>
  );
}
