import fs from 'node:fs';
import path from 'node:path';

/** Writes, flushes to disk, then renames over the old file: a crash or power cut leaves the old or the new copy, never half of one. */
export function writeJsonAtomic(file: string, data: unknown, pretty = true): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const d = fs.openSync(dir, 'r');
    fs.fsyncSync(d);
    fs.closeSync(d);
  } catch {
    /* directories can't be fsynced on Windows */
  }
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
