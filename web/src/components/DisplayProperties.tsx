import { useState } from 'react';
import { sfx } from '../lib/sound';
import { THEMES, type Theme } from '../lib/themes';
import { WALLPAPERS, wallpaperById, type Wallpaper } from '../lib/wallpapers';
import { DisplayIcon } from './art';
import { ModalLayer, Window } from './Win98';

interface Props {
  theme: Theme;
  wallpaper: Wallpaper;
  onApply(theme: Theme, wallpaper: Wallpaper): void;
  onClose(): void;
}

/** A tiny rendition of a theme (window, title bar, taskbar) for the picker. */
export function ThemePreview({ theme, wallpaper }: { theme: Theme; wallpaper: Wallpaper }) {
  return (
    <div className={`mini mini-${theme.id}`} style={{ background: wallpaper.css }} aria-hidden="true">
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

/** "Display Properties" (9x) / "Personalization" (10, 11): pick a theme and a background. */
export function DisplayProperties({ theme, wallpaper, onApply, onClose }: Props) {
  const [tab, setTab] = useState<'themes' | 'background'>('themes');
  const [pickedTheme, setPickedTheme] = useState(theme);
  const [pickedWallpaper, setPickedWallpaper] = useState(wallpaper);
  const changed = pickedTheme.id !== theme.id || pickedWallpaper.id !== wallpaper.id;

  const chooseTheme = (t: Theme) => {
    sfx.tap();
    setPickedTheme(t);
    // Like Windows' desktop themes, a theme brings its own wallpaper (you can change it after).
    setPickedWallpaper(wallpaperById(t.wallpaper) ?? pickedWallpaper);
  };
  const ok = () => {
    if (changed) onApply(pickedTheme, pickedWallpaper);
    onClose();
  };

  return (
    <ModalLayer>
      <Window title={theme.displayTitle} icon={<DisplayIcon size={16} />} onClose={onClose} className="win-display" role="dialog">
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
              {tab === 'themes' ? (
                <ThemePreview theme={pickedTheme} wallpaper={pickedWallpaper} />
              ) : (
                <div className="monitor-wallpaper" style={{ background: pickedWallpaper.css }} />
              )}
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
                    aria-selected={t.id === pickedTheme.id}
                    className={t.id === pickedTheme.id ? 'is-selected' : ''}
                    tabIndex={0}
                    onClick={() => chooseTheme(t)}
                    onDoubleClick={() => {
                      onApply(t, wallpaperById(t.wallpaper) ?? pickedWallpaper);
                      onClose();
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && chooseTheme(t)}
                  >
                    <span className={`swatch theme-swatch swatch-${t.id}`} />
                    {t.name}
                    {t.id === theme.id && <em className="current"> (current)</em>}
                  </li>
                ))}
              </ul>
              <p className="theme-blurb">{pickedTheme.blurb}</p>
            </>
          ) : (
            <>
              <span className="lbl">Wallpaper:</span>
              <ul className="listbox" role="listbox" aria-label="Wallpaper">
                {WALLPAPERS.map((w) => (
                  <li
                    key={w.id}
                    role="option"
                    aria-selected={w.id === pickedWallpaper.id}
                    className={w.id === pickedWallpaper.id ? 'is-selected' : ''}
                    tabIndex={0}
                    onClick={() => (sfx.tap(), setPickedWallpaper(w))}
                    onDoubleClick={() => {
                      onApply(pickedTheme, w);
                      onClose();
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && setPickedWallpaper(w)}
                  >
                    <span className="swatch" style={{ background: w.css }} />
                    {w.name}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="btn-row">
          <button type="button" className="btn98 is-default" onClick={ok}>
            OK
          </button>
          <button type="button" className="btn98" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn98" onClick={() => onApply(pickedTheme, pickedWallpaper)} disabled={!changed}>
            Apply
          </button>
        </div>
      </Window>
    </ModalLayer>
  );
}
