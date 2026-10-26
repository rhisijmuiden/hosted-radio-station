import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface FileEntry {
  /** Relative to the station's media folder, with forward slashes. */
  path: string;
  size: number;
  mtimeMs: number;
}

/** Every regular file under a folder (symbolic links and the files of mounted shares are left out). */
export async function listFiles(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const base = resolve(root);
  async function walk(dir: string, depth: number) {
    if (depth > 20) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, e.name);
      if (e.name.startsWith('.hrs-')) continue;
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile()) {
        const s = await lstat(full).catch(() => null);
        if (s?.isFile()) out.push({ path: relative(base, full).split(sep).join('/'), size: s.size, mtimeMs: Math.round(s.mtimeMs) });
      }
    }
  }
  await walk(base, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The absolute path of a relative path under root; throws when it would leave root. */
export function insideRoot(root: string, path: string) {
  const base = resolve(root);
  const full = resolve(base, path);
  if (full === base || !full.startsWith(base + sep) || path.includes('\0')) throw new Error('Invalid path');
  return full;
}

/**
 * Writes a file that arrives as a stream: into a temporary file next to it first, renamed when complete, with the
 * modification time of the original (so a library scan sees the same file and keeps its tags).
 */
export async function receiveFile(root: string, entry: FileEntry, body: Readable) {
  const full = insideRoot(root, entry.path);
  await mkdir(dirname(full), { recursive: true, mode: 0o775 });
  const tmp = join(dirname(full), `.hrs-${process.pid}-${Date.now()}.part`);
  try {
    await pipeline(body, createWriteStream(tmp, { mode: 0o664 }));
    const s = await stat(tmp);
    if (s.size !== entry.size) throw new Error(`${entry.path}: received ${s.size} of ${entry.size} bytes`);
    const t = new Date(entry.mtimeMs);
    await utimes(tmp, t, t);
    await rename(tmp, full);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Files of `want` that are missing or different under root. */
export async function missingFiles(root: string, want: FileEntry[]) {
  const have = new Map((await listFiles(root)).map((f) => [f.path, f]));
  return want.filter((f) => {
    const h = have.get(f.path);
    return !h || h.size !== f.size || Math.abs(h.mtimeMs - f.mtimeMs) > 1000;
  });
}
