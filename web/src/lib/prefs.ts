type PrefKey = 'sound' | 'remember';
const DEFAULTS: Record<PrefKey, boolean> = { sound: true, remember: true };

export function getPref(key: PrefKey): boolean {
  try {
    const v = localStorage.getItem(`wc.${key}`);
    return v === null ? DEFAULTS[key] : v === '1';
  } catch {
    return DEFAULTS[key];
  }
}

export function setPref(key: PrefKey, value: boolean): void {
  try {
    localStorage.setItem(`wc.${key}`, value ? '1' : '0');
  } catch {
    /* private mode: preference just won't persist */
  }
  window.dispatchEvent(new Event('wc:prefs'));
}

/** A remembered choice (e.g. the destination picked on the home window). */
export function getChoice(key: string): string | null {
  try {
    return localStorage.getItem(`wc.${key}`);
  } catch {
    return null;
  }
}

export function setChoice(key: string, value: string): void {
  try {
    localStorage.setItem(`wc.${key}`, value);
  } catch {
    /* private mode: the choice just won't persist */
  }
}
