import { useEffect, useRef, useState } from 'react';
import { ANIM_LABEL, setAnimStyle, useAnimStyle, type AnimStyle } from '../lib/motion';
import { sfx } from '../lib/sound';
import { THEMES, isDark, type Mode, type Theme } from '../lib/themes';
import { WALLPAPERS, wallpaperById, wallpaperCss, type Wallpaper } from '../lib/wallpapers';
import { DisplayIcon } from './art';
import { ModalLayer, Window } from './Win98';

interface Props {
  theme: Theme;
  wallpaper: Wallpaper;
  mode: Mode;
  /** Applies a look straight away (the whole desktop changes behind this window). */
  onApply(theme: Theme, wallpaper: Wallpaper, mode: Mode): void;
  onClose(): void;
}

/** A tiny rendition of a theme (window, title bar, taskbar) for the picker. */
export function ThemePreview({ theme, wallpaper, dark }: { theme: Theme; wallpaper: Wallpaper; dark?: boolean }) {
  return (
    <div className={`mini mini-${theme.id} ${dark ? 'is-dark' : ''}`} style={{ background: wallpaperCss(wallpaper, Boolean(dark)) }} aria-hidden="true">
      <div className="mini-win">
        <div className="mini-title">
          <span className="mini-title-text">Wallet Click</span>
          <span className="mini-x" />
        </div>
        <div className="mini-body">
          <span className="mini-btn is-btc" />
          <span className="mini-btn is-eth" />
        </div>
      </div>
      <div className="mini-bar">
        <span className="mini-start" />
        <span className="mini-task" />
        <span className="mini-clock" />
      </div>
    </div>
  );
}

const MODES: { id: Mode; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'auto', label: 'Match device' },
];

/**
 * "Display Properties" (9x) / "Personalization" (10, 11): pick a theme, light or dark, and a background.
 * Every pick shows at once on the whole desktop; OK keeps it, Cancel puts back what you had.
 */
export function DisplayProperties({ theme, wallpaper, mode, onApply, onClose }: Props) {
  const [tab, setTab] = useState<'themes' | 'background'>('themes');
  const original = useRef({ theme, wallpaper, mode });
  const dark = isDark(mode);
  const anim = useAnimStyle();

  const chooseTheme = (t: Theme) => {
    if (t.id === theme.id) return;
    // Like Windows' desktop themes, a theme brings its own wallpaper (you can change it after).
    onApply(t, wallpaperById(t.wallpaper) ?? wallpaper, mode);
  };
  const chooseWallpaper = (w: Wallpaper) => {
    if (w.id === wallpaper.id) return;
    sfx.tap();
    onApply(theme, w, mode);
  };
  const chooseMode = (m: Mode) => {
    if (m === mode) return;
    sfx.tap();
    onApply(theme, wallpaper, m);
  };
  const cancel = () => {
    const o = original.current;
    if (o.theme.id !== theme.id || o.wallpaper.id !== wallpaper.id || o.mode !== mode) onApply(o.theme, o.wallpaper, o.mode);
    onClose();
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancelRef.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ModalLayer>
      <Window title={theme.displayTitle} icon={<DisplayIcon size={16} />} onClose={cancel} className="win-display" role="dialog">
        <div className="tabs98" role="tablist">
          {(['themes', 'background'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab98 ${tab === t ? 'is-active' : ''}`} onClick={() => setTab(t)}>
              {t === 'themes' ? 'Themes' : 'Background'}
            </button>
          ))}
        </div>
        <div className="tab-panel" role="tabpanel">
          <div className="monitor">
            <div className="monitor-screen">
              {tab === 'themes' ? <ThemePreview theme={theme} wallpaper={wallpaper} dark={dark} /> : <div className="monitor-wallpaper" style={{ background: wallpaperCss(wallpaper, dark) }} />}
            </div>
            <div className="monitor-stand" />
          </div>

          {tab === 'themes' ? (
            <>
              <span className="lbl">Theme:</span>
              <ul className="listbox" role="listbox" aria-label="Theme">
                {THEMES.map((t) => (
                  <li
                    key={t.id}
                    role="option"
                    aria-selected={t.id === theme.id}
                    className={t.id === theme.id ? 'is-selected' : ''}
                    tabIndex={0}
                    onClick={() => chooseTheme(t)}
                    onDoubleClick={() => (chooseTheme(t), onClose())}
                    onKeyDown={(e) => e.key === 'Enter' && chooseTheme(t)}
                  >
                    <span className={`swatch theme-swatch swatch-${t.id}`} />
                    {t.name}
                  </li>
                ))}
              </ul>
              <p className="theme-blurb">{theme.blurb}</p>
              <span className="lbl">Appearance:</span>
              <div className="seg98 mode98" role="radiogroup" aria-label="Appearance">
                {MODES.map((m) => (
                  <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={`btn98 seg-btn ${mode === m.id ? 'is-pressed' : ''}`} onClick={() => chooseMode(m.id)}>
                    {m.label}
                  </button>
                ))}
              </div>
              {mode === 'auto' && <p className="line-sub">Follows your phone or computer: {dark ? 'dark' : 'light'} right now.</p>}
              <span className="lbl">Animations:</span>
              <div className="seg98 mode98" role="radiogroup" aria-label="Animations">
                {(['smooth', 'retro', 'calm'] as AnimStyle[]).map((a) => (
                  <button key={a} type="button" role="radio" aria-checked={anim === a} className={`btn98 seg-btn ${anim === a ? 'is-pressed' : ''}`} onClick={() => (sfx.tap(), setAnimStyle(a))}>
                    {ANIM_LABEL[a]}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <span className="lbl">Wallpaper:</span>
              <ul className="listbox" role="listbox" aria-label="Wallpaper">
                {WALLPAPERS.map((w) => (
                  <li
                    key={w.id}
                    role="option"
                    aria-selected={w.id === wallpaper.id}
                    className={w.id === wallpaper.id ? 'is-selected' : ''}
                    tabIndex={0}
                    onClick={() => chooseWallpaper(w)}
                    onDoubleClick={() => (chooseWallpaper(w), onClose())}
                    onKeyDown={(e) => e.key === 'Enter' && chooseWallpaper(w)}
                  >
                    <span className="swatch" style={{ background: wallpaperCss(w, dark) }} />
                    {w.name}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="btn-row">
          <button type="button" className="btn98 is-default" onClick={onClose}>
            OK
          </button>
          <button type="button" className="btn98" onClick={cancel}>
            Cancel
          </button>
        </div>
      </Window>
    </ModalLayer>
  );
}
