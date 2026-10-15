/** Desktop backgrounds, all drawn in code (CSS or inline SVG), so there are no image files to ship. */

export interface Wallpaper {
  id: string;
  name: string;
  css: string;
  /** Its own dark-mode version (others are dimmed). */
  dark?: string;
}

/** The wallpaper as the desktop shows it: in dark mode its own dark version, or dimmed. */
export const wallpaperCss = (w: Wallpaper, dark: boolean) => (!dark ? w.css : (w.dark ?? `linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.45)), ${w.css}`));

const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
const VIEW = 'viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice"';

// ---------------------------------------------------------------- Windows 95: the start-up sky

function cloud95(): string {
  // Each cloud is a few blurred puffs with a faint blue shadow underneath.
  const clouds: [number, number, number][] = [
    [300, 250, 1],
    [1180, 170, 1.15],
    [720, 560, 1.25],
    [1380, 720, 0.95],
    [230, 820, 1.05],
    [980, 880, 0.8],
  ];
  const puffs = (cx: number, cy: number, s: number) =>
    [
      [0, 10, 175, 58],
      [80, -22, 120, 70],
      [-75, -8, 100, 55],
      [150, 15, 110, 45],
      [-150, 18, 90, 38],
    ]
      .map(([dx, dy, rx, ry]) => `<ellipse cx="${cx + dx * s}" cy="${cy + dy * s}" rx="${rx * s}" ry="${ry * s}"/>`)
      .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" ${VIEW}>
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c56c4"/><stop offset=".6" stop-color="#4c8ae0"/><stop offset="1" stop-color="#93c2f3"/></linearGradient>
<filter id="soft" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="16"/></filter>
<filter id="softer" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="7"/></filter>
</defs>
<rect width="1600" height="1000" fill="url(#sky)"/>
<g fill="#b9d3f3" opacity=".55" filter="url(#soft)">${clouds.map(([x, y, s]) => puffs(x + 12, y + 34 * s, s)).join('')}</g>
<g fill="#fff" opacity=".95" filter="url(#soft)">${clouds.map(([x, y, s]) => puffs(x, y, s)).join('')}</g>
<g fill="#fff" opacity=".8" filter="url(#softer)">${clouds.map(([x, y, s]) => puffs(x - 10, y - 12 * s, s * 0.7)).join('')}</g>
</svg>`;
}

// ---------------------------------------------------------------- Windows 10: a window of light

function hero10(): string {
  // The window, seen at an angle: left edge near (tall), right edge far (short).
  const TL = [1010, 270];
  const BL = [1010, 730];
  const TR = [1290, 345];
  const BR = [1290, 645];
  const lerp = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const at = (u: number, v: number) => lerp(lerp(TL, TR, u), lerp(BL, BR, u), v);
  const pane = (u0: number, u1: number, v0: number, v1: number) =>
    `<polygon points="${[at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)].map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/>`;
  const g = 0.018; // the gap between panes
  const panes = [pane(0, 0.5 - g, 0, 0.5 - g), pane(0.5 + g, 1, 0, 0.5 - g), pane(0, 0.5 - g, 0.5 + g, 1), pane(0.5 + g, 1, 0.5 + g, 1)].join('');
  const beam = (y0: number, y1: number, l0: number, l1: number, o: number) =>
    `<polygon points="1010,${y0} -200,${l0} -200,${l1} 1010,${y1}" fill="url(#beam)" opacity="${o}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" ${VIEW}>
<defs>
<radialGradient id="bg" cx=".7" cy=".5" r=".8"><stop offset="0" stop-color="#1667d4"/><stop offset=".42" stop-color="#062f6e"/><stop offset="1" stop-color="#010916"/></radialGradient>
<linearGradient id="pane" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bfe6ff"/><stop offset=".55" stop-color="#5bb2ff"/><stop offset="1" stop-color="#1e7fe6"/></linearGradient>
<linearGradient id="beam" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#8fd0ff" stop-opacity=".55"/><stop offset=".6" stop-color="#4aa3ff" stop-opacity=".12"/><stop offset="1" stop-color="#4aa3ff" stop-opacity="0"/></linearGradient>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="22"/></filter>
<filter id="b6"><feGaussianBlur stdDeviation="6"/></filter>
</defs>
<rect width="1600" height="1000" fill="url(#bg)"/>
<g filter="url(#b6)">${beam(275, 495, -40, 390, 1)}${beam(510, 720, 470, 980, 0.85)}${beam(300, 700, 180, 860, 0.35)}</g>
<g fill="#6cc0ff" opacity=".9" filter="url(#glow)">${panes}</g>
<g fill="url(#pane)">${panes}</g>
</svg>`;
}

// ---------------------------------------------------------------- Windows 11: the bloom

function bloom11(dark = false): string {
  const cx = 930;
  const cy = 560;
  // [angle, length, width, layer]: deep petals first, lighter ones on top.
  const petals: [number, number, number, number][] = [
    [-150, 380, 120, 0],
    [-110, 440, 130, 0],
    [-70, 470, 135, 0],
    [-30, 450, 130, 0],
    [10, 420, 125, 0],
    [50, 380, 120, 0],
    [95, 340, 110, 0],
    [140, 330, 105, 0],
    [190, 350, 110, 0],
    [-130, 300, 95, 1],
    [-90, 340, 100, 1],
    [-50, 350, 100, 1],
    [-10, 320, 95, 1],
    [30, 290, 90, 1],
    [120, 250, 80, 1],
  ];
  const petal = ([a, len, w, layer]: [number, number, number, number]) =>
    `<path transform="translate(${cx} ${cy}) rotate(${a})" d="M0,0 C${len * 0.28},${-w} ${len * 0.8},${-w * 0.7} ${len},0 C${len * 0.8},${w * 0.7} ${len * 0.28},${w} 0,0Z" fill="url(#p${layer})" opacity="${layer ? 0.82 : 0.95}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" ${VIEW}>
<defs>
<radialGradient id="bg" cx=".58" cy=".56" r=".85">${
    dark
      ? '<stop offset="0" stop-color="#1d2f4d"/><stop offset=".55" stop-color="#0d1a2f"/><stop offset="1" stop-color="#060c18"/>'
      : '<stop offset="0" stop-color="#e9f3ff"/><stop offset=".55" stop-color="#b8d6f8"/><stop offset="1" stop-color="#8db8ee"/>'
  }</radialGradient>
<linearGradient id="p0" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="470" y2="0"><stop offset="0" stop-color="#062a86"/><stop offset=".55" stop-color="#1f63d6"/><stop offset="1" stop-color="#6fb9ff"/></linearGradient>
<linearGradient id="p1" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="350" y2="0"><stop offset="0" stop-color="#1a4fc0"/><stop offset=".6" stop-color="#3f8ff0"/><stop offset="1" stop-color="#a9dcff"/></linearGradient>
<radialGradient id="core" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#cfe8ff" stop-opacity="${dark ? 0.55 : 0.9}"/><stop offset="1" stop-color="#cfe8ff" stop-opacity="0"/></radialGradient>
<filter id="shadow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30"/></filter>
</defs>
<rect width="1600" height="1000" fill="url(#bg)"/>
<g opacity=".35" filter="url(#shadow)" transform="translate(20 40)">${petals.filter((p) => p[3] === 0).map(petal).join('')}</g>
${petals.map(petal).join('')}
<circle cx="${cx}" cy="${cy}" r="70" fill="url(#core)"/>
</svg>`;
}

export const WALLPAPERS: Wallpaper[] = [
  {
    id: 'teal',
    name: '(None) Teal',
    css: 'radial-gradient(ellipse at 50% 40%, rgba(255,255,255,0.07), transparent 60%), #008080',
    dark: 'radial-gradient(ellipse at 50% 40%, rgba(255,255,255,0.05), transparent 60%), #0b3b3b',
  },
  { id: 'clouds', name: 'Windows 95 Sky', css: `${svgUrl(cloud95())} center / cover no-repeat, #4c8ae0` },
  { id: 'hero10', name: 'Windows 10 Light', css: `${svgUrl(hero10())} center / cover no-repeat, #062f6e`, dark: `${svgUrl(hero10())} center / cover no-repeat, #062f6e` },
  { id: 'bloom11', name: 'Windows 11 Bloom', css: `${svgUrl(bloom11())} center / cover no-repeat, #b8d6f8`, dark: `${svgUrl(bloom11(true))} center / cover no-repeat, #0d1a2f` },
  {
    id: 'hill',
    name: 'Green Hill',
    css: [
      'radial-gradient(ellipse 90% 40% at 35% 100%, #5fae3a 0 60%, transparent 61%)',
      'radial-gradient(ellipse 80% 35% at 85% 100%, #4c9a2c 0 60%, transparent 61%)',
      'radial-gradient(ellipse 14% 6% at 20% 20%, rgba(255,255,255,0.9), transparent 70%)',
      'radial-gradient(ellipse 18% 6% at 70% 15%, rgba(255,255,255,0.85), transparent 70%)',
      'linear-gradient(#1d63d8, #6fb0f2 70%, #b7dcf9)',
    ].join(', '),
  },
  {
    id: 'stars',
    name: 'Midnight',
    css: [
      'radial-gradient(1.5px 1.5px at 12% 18%, #fff, transparent)',
      'radial-gradient(1px 1px at 28% 42%, #fff, transparent)',
      'radial-gradient(1.5px 1.5px at 46% 12%, #fff, transparent)',
      'radial-gradient(1px 1px at 63% 31%, #fff, transparent)',
      'radial-gradient(2px 2px at 78% 16%, #fff, transparent)',
      'radial-gradient(1px 1px at 88% 52%, #fff, transparent)',
      'radial-gradient(1.5px 1.5px at 18% 72%, #fff, transparent)',
      'radial-gradient(1px 1px at 52% 64%, #fff, transparent)',
      'radial-gradient(1px 1px at 72% 82%, #fff, transparent)',
      'radial-gradient(1.5px 1.5px at 36% 88%, #fff, transparent)',
      'radial-gradient(ellipse at 50% 120%, #2a2a7a, transparent 60%)',
      '#0b0b2e',
    ].join(', '),
  },
  {
    id: 'sunset',
    name: 'Sunset',
    css: 'radial-gradient(circle at 50% 78%, #ffe27a 0 6%, #ff9f43 7%, transparent 32%), linear-gradient(#2b1055 0%, #7b2a8b 40%, #e8576a 70%, #ffb26b 100%)',
  },
  {
    id: 'weave',
    name: 'Weave',
    css: 'repeating-linear-gradient(45deg, rgba(0,0,0,0.12) 0 6px, transparent 6px 12px), repeating-linear-gradient(-45deg, rgba(255,255,255,0.1) 0 6px, transparent 6px 12px), #3a6ea5',
  },
  { id: 'tiles', name: 'Tiles', css: 'repeating-conic-gradient(#7b7bb8 0% 25%, #6262a3 0% 50%) 0 0 / 48px 48px' },
  { id: 'plum', name: 'Plum', css: '#5a2d5a' },
  { id: 'black', name: 'Black', css: '#000000', dark: '#000000' },
];

const KEY = 'wc.wallpaper';

export const wallpaperById = (id: string | null | undefined): Wallpaper | undefined => WALLPAPERS.find((w) => w.id === id);

/** The saved wallpaper, else the theme's own. */
export function savedWallpaper(fallbackId: string): Wallpaper {
  let id: string | null = null;
  try {
    id = localStorage.getItem(KEY);
  } catch {
    /* private mode */
  }
  return wallpaperById(id) ?? wallpaperById(fallbackId) ?? WALLPAPERS[0];
}

export function saveWallpaper(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode: just won't be remembered */
  }
}
