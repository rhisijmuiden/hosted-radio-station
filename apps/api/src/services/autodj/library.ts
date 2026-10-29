import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
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
/** Library location of the news bulletin: a folder of the station of its own, never scanned, played or requested. */
export const NEWS = 'news';
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
  if (location === NEWS) return join(stationDir(ctx, stationId), NEWS);
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
  isrc: string;
  bpm: number | null;
  musicKey: string;
}

/** "Artist - Title.mp3" → artist and title; anything else → the file name as title. */
export function tagsFromFileName(path: string): { artist: string; title: string } {
  const name = path.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = name.match(/^(?:\d{1,3}[\s.-]+)?(.+?)\s+[-–]\s+(.+)$/);
  return m ? { artist: m[1]!.trim(), title: m[2]!.trim() } : { artist: '', title: name };
}

const clean = (v: unknown, max = 300) => (typeof v === 'string' ? v.replace(/\0/g, '').trim().slice(0, max) : '');

const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Camelot wheel number of each major key (C = 8B) and minor key (Am = 8A), by semitone of the root. */
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

/** A key as "Am" or "F#": the root (sharps for C#/F#, flats for the rest) with "m" for minor. */
export const keyName = (root: number, minor: boolean) => `${NOTES[((root % 12) + 12) % 12]}${minor ? 'm' : ''}`;

/**
 * The key from a tag as "Am" or "F#". Tags write it in many ways: "A minor", "Amin", "a", "Bbm", "A#m", "8A" (Camelot) or
 * "3d" (Open Key). Anything else gives an empty string.
 */
export function normaliseKey(raw: string): string {
  const v = raw.trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  if (!v) return '';
  const camelot = /^(1[0-2]|0?[1-9])\s*([ABab])$/.exec(v);
  if (camelot) {
    const n = Number(camelot[1]);
    const minor = camelot[2]!.toUpperCase() === 'A';
    return keyName((minor ? CAMELOT_MINOR : CAMELOT_MAJOR).indexOf(n), minor);
  }
  const open = /^(1[0-2]|0?[1-9])\s*([dmDM])$/.exec(v);
  if (open) {
    // Open Key 1d = C major and 1m = A minor; Camelot is Open Key moved by seven.
    const n = ((Number(open[1]) + 6) % 12) + 1;
    const minor = open[2]!.toLowerCase() === 'm';
    return keyName((minor ? CAMELOT_MINOR : CAMELOT_MAJOR).indexOf(n), minor);
  }
  const m = /^([A-Ga-g])\s*(#|b|is|es|s)?\s*(m|min|minor|moll|mineur|maj|major|dur|majeur)?$/i.exec(v.replace(/\s+/g, ' '));
  if (!m) return '';
  let root = SEMITONE[m[1]!.toUpperCase()]!;
  const acc = m[2]?.toLowerCase();
  if (acc === '#' || acc === 'is') root += 1;
  if (acc === 'b' || acc === 'es' || acc === 's') root -= 1;
  const mode = m[3]?.toLowerCase() ?? '';
  // A lower-case root on its own means minor ("a" = A minor).
  const minor = mode.startsWith('m') && !mode.startsWith('maj') ? true : !mode && m[1] === m[1]!.toLowerCase();
  return keyName(root, minor);
}

/** The Camelot code of a key ("Am" → "8A"), for mixing in key; empty when the key is unknown. */
export function camelot(key: string): string {
  const m = /^([A-G])(#|b)?(m)?$/.exec(key);
  if (!m) return '';
  const root = (SEMITONE[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return m[3] ? `${CAMELOT_MINOR[root]}A` : `${CAMELOT_MAJOR[root]}B`;
}

/** An ISRC without its dashes and spaces (e.g. NLA1R2400123), or empty when the tag is not one. */
export function normaliseIsrc(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.replace(/[\s-]/g, '').toUpperCase() : '';
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v) ? v : '';
}

const bpmOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 40 && v <= 250 ? Math.round(v * 10) / 10 : null);

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
      isrc: normaliseIsrc(c.isrc?.[0]),
      bpm: bpmOf(c.bpm),
      musicKey: normaliseKey(clean(c.key, 20)),
    };
  } catch {
    return { ...fallback, album: '', genre: '', year: null, durationSeconds: null, bitrateKbps: null, gainDb: null, isrc: '', bpm: null, musicKey: '' };
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
          isrc: sql`case when ${schema.mediaFiles.edited} then ${schema.mediaFiles.isrc} else excluded.isrc end`,
          bpm: sql`case when ${schema.mediaFiles.edited} then ${schema.mediaFiles.bpm} else excluded.bpm end`,
          musicKey: sql`case when ${schema.mediaFiles.edited} then ${schema.mediaFiles.musicKey} else excluded.music_key end`,
          // A changed file is measured again.
          analysedAt: null,
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
  await assignCodes(ctx, stationId);
  const gone = existing.filter((e) => !seen.has(e.path)).map((e) => e.id);
  for (let i = 0; i < gone.length; i += 500) {
    await ctx.db.delete(schema.mediaFiles).where(inArray(schema.mediaFiles.id, gone.slice(i, i + 500)));
  }
  p.removed += gone.length;
  if (source) {
    await ctx.db.update(schema.mediaSources).set({ fileCount: files.length, scannedAt: new Date() }).where(eq(schema.mediaSources.id, source.id));
  }
}

/** Prefix of the track codes: set in the AutoDJ settings, otherwise the initials of the station ("Harder.FM" → "HF"). */
export function codePrefix(station: { name: string; autodj: Record<string, unknown> | null }): string {
  const set = typeof station.autodj?.codePrefix === 'string' ? station.autodj.codePrefix : '';
  if (set) return set;
  const words = station.name.normalize('NFKD').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const initials = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'TRK').slice(0, 3);
  return initials.slice(0, 6) || 'TRK';
}

/**
 * Gives every track without a code the next number of the station, in the order the files were found: "HF-03007".
 * Numbers go on after the highest one so far, also when the prefix changes, so a code is never given twice.
 */
export async function assignCodes(ctx: AppContext, stationId: string) {
  const mf = schema.mediaFiles;
  const todo = await ctx.db.select({ id: mf.id }).from(mf).where(and(eq(mf.stationId, stationId), isNull(mf.code), ne(mf.location, NEWS))).orderBy(mf.createdAt, mf.path).limit(5000);
  if (!todo.length) return 0;
  const [station] = await ctx.db.select({ name: schema.stations.name, autodj: schema.stations.autodj }).from(schema.stations).where(eq(schema.stations.id, stationId));
  if (!station) return 0;
  const prefix = codePrefix(station);
  const [top] = await ctx.db
    .select({ n: sql<number | null>`max(substring(${mf.code} from '(\\d+)$')::int)` })
    .from(mf)
    .where(eq(mf.stationId, stationId));
  let next = (top?.n ?? 0) + 1;
  for (let i = 0; i < todo.length; i += 500) {
    const part = todo.slice(i, i + 500).map((r) => ({ id: r.id, code: `${prefix}-${String(next++).padStart(5, '0')}` }));
    const values = sql.join(part.map((r) => sql`(${r.id}::uuid, ${r.code})`), sql`, `);
    await ctx.db.execute(sql`update media_files set code = v.code from (values ${values}) as v(id, code) where media_files.id = v.id and media_files.code is null`);
  }
  return todo.length;
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
  // Stations on a station node are scanned there.
  const rows = await ctx.db.select({ id: schema.stations.id }).from(schema.stations).where(and(eq(schema.stations.edition, 'station'), isNull(schema.stations.nodeId)));
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
