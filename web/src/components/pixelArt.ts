/**
 * Retro animations: the coin art turned into little Windows 98-style sprites. Each one is shrunk to a few pixels,
 * its edges made hard (no half-transparent pixels), its colours snapped to the 216-colour web-safe palette of the
 * time, and outlined; a "ghost" copy has every other pixel knocked out (a dither) for after-images.
 * They're drawn on a canvas at half resolution and scaled up without smoothing, so every pixel is a chunky 2×2 block.
 */

/** How many screen pixels each retro pixel covers. */
export const PX = 2;

export interface Sprite {
  img: HTMLCanvasElement;
  ghost: HTMLCanvasElement;
  /** Width and height, outline included. */
  n: number;
}

const sprites = new Map<string, Sprite>();

const snap = (v: number) => Math.round(v / 51) * 51;

function canvas(n: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  return [c, c.getContext('2d', { willReadFrequently: true })];
}

/** A coin `size` pixels across (plus a 1px outline), from its full-size art. */
export function pixelSprite(key: string, art: HTMLCanvasElement, size: number, outline: string): Sprite | null {
  const id = `${key}:${size}`;
  const have = sprites.get(id);
  if (have) return have;
  const n = size + 2;
  const [src, sg] = canvas(size);
  const [out, og] = canvas(n);
  const [ghost, gg] = canvas(n);
  if (!sg || !og || !gg) return null;
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(art, 0, 0, size, size);
  try {
    const from = sg.getImageData(0, 0, size, size).data;
    const img = og.createImageData(n, n);
    const d = img.data;
    const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size && from[(y * size + x) * 4 + 3] >= 110;
    const [or, ogr, ob] = [1, 3, 5].map((i) => parseInt(outline.slice(i, i + 2), 16));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const sx = x - 1;
        const sy = y - 1;
        const o = (y * n + x) * 4;
        if (solid(sx, sy)) {
          const i = (sy * size + sx) * 4;
          d[o] = snap(from[i]);
          d[o + 1] = snap(from[i + 1]);
          d[o + 2] = snap(from[i + 2]);
          d[o + 3] = 255;
        } else if (solid(sx - 1, sy) || solid(sx + 1, sy) || solid(sx, sy - 1) || solid(sx, sy + 1)) {
          d[o] = or;
          d[o + 1] = ogr;
          d[o + 2] = ob;
          d[o + 3] = 255;
        }
      }
    }
    og.putImageData(img, 0, 0);
    for (let i = 0; i < d.length; i += 4) {
      const p = i / 4;
      if (((p % n) + Math.floor(p / n)) % 2) d[i + 3] = 0;
    }
    gg.putImageData(img, 0, 0);
  } catch {
    // A canvas the browser won't let us read back: plain shrunken art will do.
    og.drawImage(src, 1, 1);
    gg.globalAlpha = 0.5;
    gg.drawImage(src, 1, 1);
  }
  const s = { img: out, ghost, n };
  sprites.set(id, s);
  return s;
}

/** Darker, for outlines: "#3c55b8" → "#1e2a5c". */
export function darker(hex: string, k = 0.5): string {
  const c = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** A plus-shaped twinkle: big, then small, then a single pixel (no fading in retro: it steps). */
export function pixelTwinkle(g: CanvasRenderingContext2D, x: number, y: number, f: number, color: string) {
  g.fillStyle = color;
  const arm = f < 0.34 ? 2 : f < 0.67 ? 1 : 0;
  g.fillRect(x, y - arm, 1, arm * 2 + 1);
  g.fillRect(x - arm, y, arm * 2 + 1, 1);
}
