import { readFileSync } from 'node:fs';

/** The app version, from package.json (one level up when run with tsx, two when built into dist/server). */
function readVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'wallet-click' && pkg.version) return pkg.version;
    } catch {
      /* try the next place */
    }
  }
  return '0.0.0';
}

export const VERSION = readVersion();
