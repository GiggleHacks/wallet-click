import { useEffect } from 'react';
import { getPref, setPref, usePref } from './prefs';

/**
 * Animations: Retro (the default: chunky pixel art, Windows 98 style), Smooth (high-resolution glows and trails) or
 * Calm (still), whatever the computer's "reduce motion" setting says. Set from the Start menu or Themes. The choice and whether the
 * tab is hidden live on <html> as data-motion / data-anim / data-hidden, so CSS can follow without React re-rendering.
 */

export type AnimStyle = 'smooth' | 'retro' | 'calm';

export const isCalm = () => getPref('calm');
export const isRetro = () => getPref('retro');
export const animStyle = (): AnimStyle => (isCalm() ? 'calm' : isRetro() ? 'retro' : 'smooth');

export function setAnimStyle(style: AnimStyle): void {
  if (style !== 'calm') setPref('retro', style === 'retro');
  setPref('calm', style === 'calm');
  applyMotionAttr();
}

/** What the Start menu's Animations entry moves on to. */
export const nextAnimStyle = (s: AnimStyle): AnimStyle => (s === 'smooth' ? 'retro' : s === 'retro' ? 'calm' : 'smooth');

export const ANIM_LABEL: Record<AnimStyle, string> = { smooth: 'Smooth', retro: 'Retro', calm: 'Calm' };

export function applyMotionAttr(calm = isCalm(), retro = isRetro()): void {
  document.documentElement.dataset.motion = calm ? 'calm' : 'full';
  document.documentElement.dataset.anim = retro ? 'retro' : 'smooth';
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

/** Keeps data-motion and data-anim in step with the setting, and returns whether it's Calm. */
export function useCalm(): boolean {
  const calm = usePref('calm');
  const retro = usePref('retro');
  useEffect(() => applyMotionAttr(calm, retro), [calm, retro]);
  return calm;
}

/** The animation style, re-rendering when it changes. */
export function useAnimStyle(): AnimStyle {
  const calm = usePref('calm');
  const retro = usePref('retro');
  return calm ? 'calm' : retro ? 'retro' : 'smooth';
}
