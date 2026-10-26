import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { parseFile } from 'music-metadata';
import { schema } from '../../db/index.js';
import type { MediaSourceStatus } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { ONDEMAND_FOLDER, RECORDINGS_FOLDER } from '../public/ondemand.js';
import { mediaDir, stationDir } from '../streaming/icecast.js';

export type MediaSource = typeof schema.mediaSources.$inferSelect;
export type MediaFile = typeof schema.mediaFiles.$inferSelect;

/** The station's own media folder (uploads over SFTP/FTP and the panel). Other locations are media source ids. */
export const STORAGE = 'storage';
/** Folder in the station's storage where uploads from the panel go by default. */
export const MUSIC_FOLDER = 'music';

/** Files the AutoDJ can play, by extension. */
export const MEDIA_EXTENSIONS = new Set(['.mp3', '.aac', '.m4a', '.mp4', '.ogg', '.oga', '.opus', '.flac', '.wav']);

/** Folders of the station storage that are not music: on demand uploads and recordings of live broadcasts. */
const NOT_MUSIC = new Set([ONDEMAND_FOLDER, RECORDINGS_FOLDER]);

/** Where the system helper mounts a station's SMB and NFS shares. */
export const sourceMountDir = (ctx: AppContext, stationId: string, sourceId: string) => join(stationDir(ctx, stationId), 'sources', sourceId);

/** Status of the share mounts, written by the system helper (hrs-streams-apply). */
export const mountStatusPath = (ctx: AppContext) => join(ctx.config.DATA_DIR, 'run', 'media-mounts-status.json');

export async function readMountStatus(ctx: AppContext): Promise<Record<string, { ok: boolean; message: string; at?: string }>> {
  try {
    return JSON.parse(await readFile(mountStatusPath(ctx), 'utf8')) as Record<string, { ok: boolean; message: string }>;
  } catch {
    return {};
  }
}

/** Folder on disk of a location, or null when the source is unknown. */
export function locationRoot(ctx: AppContext, stationId: string, location: string, source?: MediaSource | null): string | null {
  if (location === STORAGE) return mediaDir(ctx, stationId);
  if (!source || source.id !== location) return null;
  if (source.type === 'local') return source.config.path ?? null;
  return sourceMountDir(ctx, stationId, source.id);
}

/** Absolute path of a library file, refusing anything that would leave its location. */
export function filePath(root: string, path: string) {
  const base = resolve(root);
  const full = resolve(base, path);
  if (full !== base && !full.startsWith(base + sep)) throw new Error('outside the library');
  return full;
}

export interface ScanProgress {
  running: boolean;
  location: string | null;
  found: number;
  added: number;
  updated: number;
  removed: number;
  startedAt: string | null;
  finishedAt: string | null;
  errors: string[];
}

const progress = new Map<string, ScanProgress>();
const pending = new Map<string, Promise<ScanProgress>>();

export const scanProgress = (stationId: string): ScanProgress =>
  progress.get(stationId) ?? { running: false, location: null, found: 0, added: 0, updated: 0, removed: 0, startedAt: null, finishedAt: null, errors: [] };

interface Found {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Every audio file under a folder (no hidden files, no symbolic links to folders outside it). */
async function walk(root: string, skipTop: Set<string>): Promise<Found[]> {
  const out: Found[] = [];
  async function visit(dir: string, depth: number) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth === 0 && skipTop.has(e.name)) continue;
        if (depth < 12) await visit(full, depth + 1);
      } else if (e.isFile() && MEDIA_EXTENSIONS.has(extname(e.name).toLowerCase())) {
        const st = await stat(full).catch(() => null);
        if (st) out.push({ path: relative(root, full).split(sep).join('/'), size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
      }
    }
  }
  await visit(root, 0);
  return out;
}

export interface Tags {
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: number | null;
  durationSeconds: number | null;
  bitrateKbps: number | null;
  gainDb: number | null;
}

/** "Artist - Title.mp3" → artist and title; anything else → the file name as title. */
export function tagsFromFileName(path: string): { artist: string; title: string } {
  const name = path.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = name.match(/^(?:\d{1,3}[\s.-]+)?(.+?)\s+[-–]\s+(.+)$/);
  return m ? { artist: m[1]!.trim(), title: m[2]!.trim() } : { artist: '', title: name };
}

const clean = (v: unknown, max = 300) => (typeof v === 'string' ? v.replace(/\0/g, '').trim().slice(0, max) : '');

/** Tags, length and ReplayGain of a file. Never throws: unreadable files get their name as title. */
export async function readTags(full: string, path: string): Promise<Tags> {
  const fallback = tagsFromFileName(path);
  try {
    const meta = await parseFile(full, { duration: true, skipCovers: true });
    const c = meta.common;
    const gain = c.replaygain_track_gain?.dB ?? meta.format.trackGain ?? null;
    const duration = meta.format.duration;
    const bitrate = meta.format.bitrate;
    return {
      title: clean(c.title) || fallback.title,
      artist: clean(c.artist) || clean(c.albumartist) || fallback.artist,
      album: clean(c.album),
      genre: clean(c.genre?.[0], 100),
      year: c.year && c.year > 1000 && c.year < 3000 ? c.year : null,
      durationSeconds: duration && Number.isFinite(duration) && duration > 0 ? Math.round(duration * 100) / 100 : null,
      bitrateKbps: bitrate && Number.isFinite(bitrate) ? Math.round(bitrate / 1000) : null,
      gainDb: typeof gain === 'number' && Number.isFinite(gain) && Math.abs(gain) < 30 ? gain : null,
    };
  } catch {
    return { ...fallback, album: '', genre: '', year: null, durationSeconds: null, bitrateKbps: null, gainDb: null };
  }
}

/** Runs `fn` over the items with at most `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

/** A share counts as available when it is mounted (another device than its parent folder) and readable. */
async function shareAvailable(root: string) {
  try {
    const [a, b] = await Promise.all([stat(root), stat(dirname(root))]);
    if (a.dev === b.dev) return false;
    await readdir(root);
    return true;
  } catch {
    return false;
  }
}

/**
 * Brings the library rows of one location in line with the files on disk: new files are added with their tags,
 * changed files (size or time) are read again, files that are gone are removed. A location that cannot be read is
 * left alone, so a share that is briefly away does not empty the playlists.
 */
async function scanLocation(ctx: AppContext, stationId: string, location: string, source: MediaSource | null, p: ScanProgress) {
  const root = locationRoot(ctx, stationId, location, source);
  if (!root) return;
  if (source && source.type !== 'local') {
    if (!(await shareAvailable(root))) {
      p.errors.push(`${source.name}: the share is not mounted`);
      return;
    }
  } else {
    const st = await stat(root).catch(() => null);
    if (!st?.isDirectory()) {
      if (source) p.errors.push(`${source.name}: ${root} is not a readable folder`);
      return;
    }
  }
  p.location = location;
  const files = await walk(root, location === STORAGE ? NOT_MUSIC : new Set());
  p.found += files.length;
  const existing = await ctx.db
    .select({ id: schema.mediaFiles.id, path: schema.mediaFiles.path, size: schema.mediaFiles.sizeBytes, mtime: schema.mediaFiles.mtimeMs, edited: schema.mediaFiles.edited })
    .from(schema.mediaFiles)
    .where(and(eq(schema.mediaFiles.stationId, stationId), eq(schema.mediaFiles.location, location)));
  const byPath = new Map(existing.map((e) => [e.path, e]));
  const seen = new Set<string>();
  const work: Found[] = [];
  for (const f of files) {
    seen.add(f.path);
    const e = byPath.get(f.path);
    if (!e || e.size !== f.size || e.mtime !== f.mtimeMs) work.push(f);
  }
  let batch: (typeof schema.mediaFiles.$inferInsert)[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const rows = batch;
    batch = [];
    await ctx.db
      .insert(schema.mediaFiles)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.mediaFiles.stationId, schema.mediaFiles.location, schema.mediaFiles.path],
        set: {
          sizeBytes: sql`excluded.size_bytes`,
          mtimeMs: sql`excluded.mtime_ms`,
          durationSeconds: sql`excluded.duration_seconds`,
          bitrateKbps: sql`excluded.bitrate_kbps`,
          gainDb: sql`excluded.gain_db`,
          // Tags corrected in the panel win over the file's tags.
          title: sql`case when ${schema.mediaFiles.edited} then ${schema.mediaFiles.title} else excluded.title end`,
          artist: sql`case when ${schema.mediaFiles.edited} then ${schema.mediaFiles.artist} else excluded.artist end`,
          album: sql`case when ${schema.mediaFiles.edited} then ${schema.mediaFiles.album} else excluded.album end`,
          genre: sql`case when ${schema.mediaFiles.edited} then ${schema.mediaFiles.genre} else excluded.genre end`,
          year: sql`case when ${schema.mediaFiles.edited} then ${schema.mediaFiles.year} else excluded.year end`,
          updatedAt: new Date(),
        },
      });
  };
  await pool(work, 4, async (f) => {
    const tags = await readTags(filePath(root, f.path), f.path);
    batch.push({ stationId, sourceId: source?.id ?? null, location, path: f.path, sizeBytes: f.size, mtimeMs: f.mtimeMs, ...tags });
    if (byPath.has(f.path)) p.updated++;
    else p.added++;
    if (batch.length >= 200) await flush();
  });
  await flush();
  const gone = existing.filter((e) => !seen.has(e.path)).map((e) => e.id);
  for (let i = 0; i < gone.length; i += 500) {
    await ctx.db.delete(schema.mediaFiles).where(inArray(schema.mediaFiles.id, gone.slice(i, i + 500)));
  }
  p.removed += gone.length;
  if (source) {
    await ctx.db.update(schema.mediaSources).set({ fileCount: files.length, scannedAt: new Date() }).where(eq(schema.mediaSources.id, source.id));
  }
}

/** Updates the stored status of the station's shares from the system helper's report. */
export async function refreshSourceStatus(ctx: AppContext, stationId: string) {
  const sources = await ctx.db.select().from(schema.mediaSources).where(eq(schema.mediaSources.stationId, stationId));
  const report = await readMountStatus(ctx);
  for (const s of sources) {
    let status: MediaSourceStatus;
    if (!s.enabled) status = { state: 'pending', message: 'Switched off' };
    else if (s.type === 'local') {
      const st = s.config.path ? await stat(s.config.path).catch(() => null) : null;
      status = st?.isDirectory() ? { state: 'ok' } : { state: 'error', message: `${s.config.path} is not a readable folder` };
    } else {
      const r = report[s.id];
      status = !r ? { state: 'pending', message: 'Waiting for the system to mount the share' } : r.ok ? { state: 'ok', message: r.message } : { state: 'error', message: r.message };
    }
    status.checkedAt = new Date().toISOString();
    if (JSON.stringify({ ...s.status, checkedAt: undefined }) !== JSON.stringify({ ...status, checkedAt: undefined })) {
      await ctx.db.update(schema.mediaSources).set({ status }).where(eq(schema.mediaSources.id, s.id));
    }
    s.status = status;
  }
  return sources;
}

/**
 * Scans the whole library of a station (its storage and every enabled source). Calls while a scan runs return that
 * scan. `only` limits the scan to one location.
 */
export function scanLibrary(ctx: AppContext, stationId: string, only?: string): Promise<ScanProgress> {
  const running = pending.get(stationId);
  if (running) return running;
  const p: ScanProgress = { running: true, location: null, found: 0, added: 0, updated: 0, removed: 0, startedAt: new Date().toISOString(), finishedAt: null, errors: [] };
  progress.set(stationId, p);
  const job = (async () => {
    try {
      const sources = (await refreshSourceStatus(ctx, stationId)).filter((s) => s.enabled);
      if (!only || only === STORAGE) await scanLocation(ctx, stationId, STORAGE, null, p);
      for (const s of sources) if (!only || only === s.id) await scanLocation(ctx, stationId, s.id, s, p);
    } catch (err) {
      p.errors.push((err as Error).message);
    } finally {
      p.running = false;
      p.location = null;
      p.finishedAt = new Date().toISOString();
      pending.delete(stationId);
    }
    return p;
  })();
  pending.set(stationId, job);
  return job;
}

/** Scans the libraries of all Radio stations, one after the other (every half hour). */
export async function scanAllLibraries(ctx: AppContext) {
  const rows = await ctx.db.select({ id: schema.stations.id }).from(schema.stations).where(eq(schema.stations.edition, 'station'));
  for (const r of rows) await scanLibrary(ctx, r.id);
}

/** Rescans a station's storage shortly after uploads stop, so a burst of files triggers one scan. */
export function libraryRescanner(ctx: AppContext) {
  const timers = new Map<string, NodeJS.Timeout>();
  return (stationId: string) => {
    clearTimeout(timers.get(stationId));
    timers.set(
      stationId,
      setTimeout(() => {
        timers.delete(stationId);
        void ctx.db
          .select({ edition: schema.stations.edition })
          .from(schema.stations)
          .where(eq(schema.stations.id, stationId))
          .then(([s]) => (s?.edition === 'station' ? scanLibrary(ctx, stationId, STORAGE) : null))
          .catch(() => undefined);
      }, 15_000).unref(),
    );
  };
}
