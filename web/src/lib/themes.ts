import { createContext, useContext, useEffect, useState } from 'react';

/**
 * Four desktop themes. Each changes the whole look: fonts, colours, window chrome, controls,
 * taskbar and Start menu layout, sign-in screen, transfer dialog, sounds and default wallpaper.
 */

export type ThemeId = 'win95' | 'win98' | 'win10' | 'win11';
/** Layout family: the classic 9x shell, or the modern 10 / 11 shells. */
export type Shell = 'classic' | 'win10' | 'win11';

export interface Theme {
  id: ThemeId;
  name: string;
  /** Short year/version used in labels, e.g. the Start menu banner. */
  version: string;
  shell: Shell;
  wallpaper: string;
  /** What the background/theme dialog is called in this version of Windows. */
  displayTitle: string;
  blurb: string;
}

export const THEMES: Theme[] = [
  {
    id: 'win95',
    name: 'Windows 95',
    version: '95',
    shell: 'classic',
    wallpaper: 'clouds',
    displayTitle: 'Display Properties',
    blurb: 'Solid navy title bars, the Start-up sky and the original chord.',
  },
  {
    id: 'win98',
    name: 'Windows 98',
    version: '98',
    shell: 'classic',
    wallpaper: 'teal',
    displayTitle: 'Display Properties',
    blurb: 'Gradient title bars on the classic teal desktop. The original.',
  },
  {
    id: 'win10',
    name: 'Windows 10',
    version: '10',
    shell: 'win10',
    wallpaper: 'hero10',
    displayTitle: 'Personalization',
    blurb: 'Flat and sharp: dark taskbar, live tiles, a green copy graph.',
  },
  {
    id: 'win11',
    name: 'Windows 11',
    version: '11',
    shell: 'win11',
    wallpaper: 'bloom11',
    displayTitle: 'Personalization',
    blurb: 'Rounded glass windows, a centred taskbar and the blue bloom.',
  },
];

export const DEFAULT_THEME: ThemeId = 'win98';
const KEY = 'wc.theme';

export const themeById = (id: string | null | undefined): Theme => THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;

export function savedTheme(): Theme {
  try {
    return themeById(localStorage.getItem(KEY));
  } catch {
    return themeById(DEFAULT_THEME);
  }
}

export function saveTheme(id: ThemeId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode: just won't be remembered */
  }
}

/** Light, dark, or whatever the phone/computer is set to ('auto', the default). */
export type Mode = 'auto' | 'light' | 'dark';
const MODE_KEY = 'wc.mode';

export function savedMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === 'light' || m === 'dark' ? m : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* private mode: just won't be remembered */
  }
}

const darkQuery = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);

/** Whether a mode means dark right now ('auto' follows the device). */
export const isDark = (mode: Mode): boolean => mode === 'dark' || (mode === 'auto' && Boolean(darkQuery()?.matches));

/** Follows the device's light/dark setting live while the mode is 'auto'. */
export function useDark(mode: Mode): boolean {
  const [dark, setDark] = useState(() => isDark(mode));
  useEffect(() => {
    setDark(isDark(mode));
    const q = darkQuery();
    if (mode !== 'auto' || !q) return;
    const onChange = () => setDark(q.matches);
    q.addEventListener?.('change', onChange);
    return () => q.removeEventListener?.('change', onChange);
  }, [mode]);
  return dark;
}

/** Puts the theme (and light/dark) on <html> so the stylesheets can switch everything at once. */
export function applyThemeAttr(theme: Theme, dark = isDark(savedMode())): void {
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.dataset.shell = theme.shell;
  document.documentElement.dataset.mode = dark ? 'dark' : 'light';
  const color = dark ? (theme.shell === 'win11' ? '#202020' : theme.shell === 'win10' ? '#101010' : '#1f2b2b') : theme.shell === 'classic' ? '#008080' : theme.shell === 'win10' ? '#101010' : '#f3f3f3';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

export const ThemeContext = createContext<Theme>(themeById(DEFAULT_THEME));
export const useTheme = () => useContext(ThemeContext);
