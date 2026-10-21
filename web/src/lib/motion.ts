import { useEffect } from 'react';
import { getPref, usePref } from './prefs';

/**
 * Animations: Full (the default, whatever the computer's "reduce motion" setting says) or Calm (still, from the
 * Start menu). The choice and whether the tab is hidden live on <html> as data-motion / data-hidden, so CSS can
 * stop every infinite animation without React re-rendering anything.
 */

export const isCalm = () => getPref('calm');

export function applyMotionAttr(calm = isCalm()): void {
  document.documentElement.dataset.motion = calm ? 'calm' : 'full';
}

/** Hidden tabs pause their animations (CSS) and the particle canvas (JS). */
export function installVisibility(): void {
  const set = () => {
    if (document.hidden) document.documentElement.dataset.hidden = '';
    else delete document.documentElement.dataset.hidden;
  };
  set();
  document.addEventListener('visibilitychange', set);
}

/** Keeps data-motion in step with the setting, and returns whether it's Calm. */
export function useCalm(): boolean {
  const calm = usePref('calm');
  useEffect(() => applyMotionAttr(calm), [calm]);
  return calm;
}
