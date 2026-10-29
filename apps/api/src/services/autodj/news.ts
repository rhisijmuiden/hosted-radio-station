import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/index.js';
import type { ClockItem } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import type { SecretBox } from '../../lib/crypto.js';
import { errorLine, run } from '../backup/engine.js';
import { rcloneSetup, RCLONE_REMOTE } from '../backup/targets.js';
import { anchorOf } from '../scheduler/clock.js';
import { loadSchedule } from '../scheduler/runtime.js';
import { hourStart, wallTime } from '../scheduler/time.js';
import { SECRET_MASK } from '../settings.js';
import { stationDir } from '../streaming/icecast.js';
import type { Station } from '../streaming/state.js';
import { MEDIA_EXTENSIONS, NEWS, readTags } from './library.js';

export { NEWS };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const host = z.string().trim().max(253).regex(/^[A-Za-z0-9.:[\]-]*$/, 'Invalid host name');
/** File on the server; {YYYY} {MM} {DD} {HH} {mm} are the date and time of the news in the station's time zone. */
const remoteFile = z.string().trim().max(500).regex(/^[^\n\r"'`$\\]*$/, 'Invalid file name');

/** Where a station's news bulletin comes from, and what plays when it is missing. */
export const newsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Shown in the log and in RHIS Studio. */
  name: z.string().trim().max(40).default('News'),
  source: z.enum(['url', 'ftp', 'ftps', 'sftp']).default('url'),
  /** url: an audio file over HTTP(S). */
  url: z
    .string()
    .trim()
    .max(1000)
    .regex(/^(https?:\/\/\S+)?$/, 'Use an http:// or https:// address')
    .default(''),
  host: host.default(''),
  port: z.number().int().min(0).max(65535).default(0),
  username: z.string().trim().max(200).default(''),
  password: z.string().max(500).default(''),
  /** sftp: OpenSSH or PEM private key, used instead of (or with) the password. */
  privateKey: z.string().max(20_000).default(''),
  /** sftp: optional known_hosts line so the server identity is checked. */
  hostKey: z.string().trim().max(5000).default(''),
  /** ftps: explicit = AUTH TLS on port 21, implicit = TLS from the first byte (port 990). */
  tlsMode: z.enum(['explicit', 'implicit']).default('explicit'),
  skipCertCheck: z.boolean().default(false),
  path: remoteFile.default(''),
  /** Minutes before the news that the server starts fetching it (again every minute until it has a new one). */
  leadMinutes: z.number().int().min(1).max(30).default(8),
  /** A bulletin older than this at the time of the news is not played; the spare jingle plays instead. */
  maxAgeMinutes: z.number().int().min(5).max(1440).default(60),
  /** Library track that plays when there is no fresh bulletin; none = the news item is left out. */
  fallbackMediaId: z.uuid().nullable().default(null),
});
export type NewsSettings = z.infer<typeof newsSchema>;

const SECRETS = ['password', 'privateKey'] as const;

export function newsSettings(station: Pick<Station, 'news'>): NewsSettings {
  const parsed = newsSchema.safeParse(station.news ?? {});
  return parsed.success ? parsed.data : newsSchema.parse({});
}

/** Settings with their secrets opened, for fetching (and for the package of a station node). */
export function openNews(box: SecretBox, raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out = { ...(raw ?? {}) };
  for (const f of SECRETS) {
    if (typeof out[f] === 'string' && out[f]) {
      try {
        out[f] = box.decrypt(out[f] as string);
      } catch {
        out[f] = '';
      }
    }
  }
  return out;
}

/**
 * Settings to store: secrets sealed, a masked secret keeps the stored one. `prev` is what is stored now; an unchanged
 * secret keeps its sealed form, so the station does not look changed.
 */
export function sealNews(box: SecretBox, next: Record<string, unknown>, prev: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out = { ...next };
  const before = openNews(box, prev);
  for (const f of SECRETS) {
    let v = typeof out[f] === 'string' ? (out[f] as string) : '';
    if (v === SECRET_MASK) v = (before[f] as string) ?? '';
    if (!v) out[f] = '';
    else if (before[f] === v && typeof prev?.[f] === 'string') out[f] = prev[f];
    else out[f] = box.encrypt(v);
  }
  return out;
}

export function maskNews(s: NewsSettings): NewsSettings {
  return { ...s, password: s.password ? SECRET_MASK : '', privateKey: s.privateKey ? SECRET_MASK : '' };
}

/** What the server knows of the last bulletin, kept next to it. */
export interface NewsStatus {
  /** The bulletin on disk (null = none yet). */
  mediaId: string | null;
  path: string | null;
  durationSeconds: number | null;
  fetchedAt: string | null;
  /** Modification time of the file at the source, when the source tells it. */
  sourceAt: string | null;
  /** Time of the news it was fetched for. */
  slot: string | null;
  lastAttemptAt: string | null;
  /** Error of the last attempt; null when it worked. */
  error: string | null;
}

const EMPTY: NewsStatus = { mediaId: null, path: null, durationSeconds: null, fetchedAt: null, sourceAt: null, slot: null, lastAttemptAt: null, error: null };

export const newsDir = (ctx: AppContext, stationId: string) => join(stationDir(ctx, stationId), NEWS);
const statusPath = (ctx: AppContext, stationId: string) => join(newsDir(ctx, stationId), 'status.json');

export async function readNewsStatus(ctx: AppContext, stationId: string): Promise<NewsStatus> {
  try {
    return { ...EMPTY, ...(JSON.parse(await readFile(statusPath(ctx, stationId), 'utf8')) as Partial<NewsStatus>) };
  } catch {
    return { ...EMPTY };
  }
}

async function writeNewsStatus(ctx: AppContext, stationId: string, status: NewsStatus) {
  await mkdir(newsDir(ctx, stationId), { recursive: true });
  await writeFile(statusPath(ctx, stationId), JSON.stringify(status, null, 2));
}

/** The file name on the server for the news at `slot`: {YYYY} {MM} {DD} {HH} {mm} in the station's time zone. */
export function remotePathFor(template: string, slot: number, tz: string) {
  const w = wallTime(slot, tz);
  const two = (n: number) => String(n).padStart(2, '0');
  return template
    .replace(/\{YYYY\}/g, String(w.year))
    .replace(/\{MM\}/g, two(w.month))
    .replace(/\{DD\}/g, two(w.day))
    .replace(/\{HH\}/g, two(w.hour))
    .replace(/\{mm\}/g, two(w.minute));
}

/**
 * Whether a bulletin may play for the news at `slot`: it is there and not older than the maximum age then (by the time
 * at the source when known, else by when it was fetched).
 */
export function isFresh(status: NewsStatus, s: Pick<NewsSettings, 'maxAgeMinutes'>, slot: number) {
  if (!status.mediaId) return false;
  const at = Date.parse(status.sourceAt ?? status.fetchedAt ?? '');
  return Number.isFinite(at) && slot - at <= s.maxAgeMinutes * MINUTE;
}

const AUDIO_TYPES: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/aac': '.aac',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/flac': '.flac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
};

const extFrom = (name: string) => {
  const e = extname(name.split(/[?#]/)[0] ?? '').toLowerCase();
  return MEDIA_EXTENSIONS.has(e) ? e : null;
};

/** Downloads the bulletin into `dest`. Returns its extension and the time at the source. */
async function download(s: NewsSettings, remote: string, dest: string): Promise<{ ext: string; sourceAt: string | null }> {
  if (s.source === 'url') {
    if (!remote) throw new Error('No address set');
    const url = remote;
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000), redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`The server answered ${res.status} ${res.statusText}`.trim());
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const ext = extFrom(new URL(res.url || url).pathname) ?? AUDIO_TYPES[type] ?? '.mp3';
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
    const modified = Date.parse(res.headers.get('last-modified') ?? '');
    return { ext, sourceAt: Number.isFinite(modified) ? new Date(modified).toISOString() : null };
  }
  if (!s.host || !s.username || !remote) throw new Error('Set the server, the user name and the file');
  const work = await mkdtemp(join(tmpdir(), 'hrs-news-'));
  try {
    const type = s.source;
    const port = s.port || (type === 'sftp' ? 22 : type === 'ftps' && s.tlsMode === 'implicit' ? 990 : 21);
    const cfg = { host: s.host, port, username: s.username, password: s.password, privateKey: s.privateKey, keyPassphrase: '', hostKey: s.hostKey, tlsMode: s.tlsMode, skipCertCheck: s.skipCertCheck, path: '' };
    const setup = rcloneSetup(type, cfg as never, join(work, 'known_hosts'));
    await writeFile(join(work, 'rclone.conf'), setup.conf, { mode: 0o600 });
    if (setup.knownHosts) await writeFile(join(work, 'known_hosts'), setup.knownHosts, { mode: 0o600 });
    const env = { ...process.env, RCLONE_CONFIG: join(work, 'rclone.conf') };
    const from = `${RCLONE_REMOTE}:${remote}`;
    const res = await run('rclone', ['copyto', '--retries', '1', '--low-level-retries', '2', '--contimeout', '20s', '--timeout', '60s', from, dest], { env, timeoutMs: 120_000 });
    if (res.code !== 0) throw new Error(errorLine(res));
    let sourceAt: string | null = null;
    const info = await run('rclone', ['lsjson', from], { env, timeoutMs: 30_000 }).catch(() => null);
    try {
      const mod = (JSON.parse(info?.stdout ?? '[]') as { ModTime?: string }[])[0]?.ModTime;
      if (mod && Number.isFinite(Date.parse(mod))) sourceAt = new Date(mod).toISOString();
    } catch {
      /* no time from the server */
    }
    return { ext: extFrom(remote) ?? '.mp3', sourceAt };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Fetches the bulletin for the news at `slot` (now when not given) and makes it the station's bulletin. A failed fetch
 * keeps the bulletin there was; the error is kept in the status.
 */
export async function fetchNews(ctx: AppContext, station: Station, slot = Date.now()): Promise<NewsStatus> {
  const s = newsSchema.parse(openNews(ctx.box, station.news));
  const tz = (await loadSchedule(ctx.db, station)).settings.timezone;
  const dir = newsDir(ctx, station.id);
  await mkdir(dir, { recursive: true });
  const status = await readNewsStatus(ctx, station.id);
  status.lastAttemptAt = new Date().toISOString();
  const tmp = join(dir, `incoming-${process.pid}.part`);
  try {
    const remote = s.source === 'url' ? remotePathFor(s.url, slot, tz) : remotePathFor(s.path, slot, tz);
    const got = await download(s, remote, tmp);
    const tags = await readTags(tmp, `bulletin${got.ext}`);
    if (!tags.durationSeconds) throw new Error('The file is not audio that can be played');
    const name = `bulletin${got.ext}`;
    for (const f of await readdir(dir)) if (f.startsWith('bulletin.') && f !== name) await rm(join(dir, f), { force: true });
    await rename(tmp, join(dir, name));
    const st = await stat(join(dir, name));
    const w = wallTime(slot, tz);
    const title = `${s.name || 'News'} ${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
    const mf = schema.mediaFiles;
    const values = {
      stationId: station.id,
      location: NEWS,
      path: name,
      sizeBytes: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      title,
      artist: s.name || 'News',
      durationSeconds: tags.durationSeconds,
      bitrateKbps: tags.bitrateKbps,
      gainDb: tags.gainDb,
      // Never in a playlist, a request or the library list: only the news item plays it.
      enabled: false,
      edited: true,
      analysedAt: new Date(),
      updatedAt: new Date(),
    };
    const [row] = await ctx.db
      .insert(mf)
      .values(values)
      .onConflictDoUpdate({ target: [mf.stationId, mf.location, mf.path], set: values })
      .returning({ id: mf.id });
    await ctx.db.delete(mf).where(and(eq(mf.stationId, station.id), eq(mf.location, NEWS), ne(mf.path, name)));
    Object.assign(status, {
      mediaId: row!.id,
      path: name,
      durationSeconds: tags.durationSeconds,
      fetchedAt: new Date().toISOString(),
      sourceAt: got.sourceAt,
      slot: new Date(slot).toISOString(),
      error: null,
    });
    // The spare jingle may already wait in the queue for this news: the bulletin takes its place.
    if (s.fallbackMediaId && isFresh(status, s, slot)) {
      await ctx.db
        .update(schema.queueItems)
        .set({ mediaId: row!.id })
        .where(
          and(
            eq(schema.queueItems.stationId, station.id),
            eq(schema.queueItems.state, 'queued'),
            eq(schema.queueItems.origin, 'clock'),
            eq(schema.queueItems.mediaId, s.fallbackMediaId),
          ),
        );
    }
  } catch (err) {
    status.error = ((err as Error).message || String(err)).slice(0, 300);
  } finally {
    await rm(tmp, { force: true });
  }
  await writeNewsStatus(ctx, station.id, status);
  return status;
}

/**
 * The times of the news in the hours from `from` on, from the news items of the hour clocks. A news item without a
 * minute of its own counts at the minute of the timed item before it.
 */
export async function newsSlots(ctx: AppContext, station: Pick<Station, 'id' | 'scheduler'>, from = Date.now(), hours = 2): Promise<number[]> {
  const plan = await loadSchedule(ctx.db, station);
  if (!plan.settings.enabled) return [];
  const tz = plan.settings.timezone;
  const out: number[] = [];
  const first = hourStart(from, tz);
  for (let h = 0; h <= hours; h++) {
    const hour = first + h * HOUR;
    const clock = plan.clockAt(hour);
    let at = hour;
    (clock?.items ?? []).forEach((item: ClockItem, i) => {
      const a = anchorOf(clock!.items, i);
      if (a !== null) at = hour + a * MINUTE;
      if (item.kind === 'news' && at >= from - 5 * MINUTE && !out.includes(at)) out.push(at);
    });
  }
  return out.sort((a, b) => a - b);
}

const tried = new Map<string, number>();

/**
 * Every minute: fetches the bulletin of each station whose news comes within its lead time, until it has one for that
 * news. Only for the Radio stations this server plays.
 */
export async function newsTick(ctx: AppContext, now = Date.now()) {
  const stations = await ctx.db
    .select()
    .from(schema.stations)
    .where(and(eq(schema.stations.edition, 'station'), isNull(schema.stations.nodeId), eq(schema.stations.enabled, true)));
  for (const station of stations) {
    const s = newsSettings(station);
    if (!s.enabled) continue;
    const slot = (await newsSlots(ctx, station, now, 1)).find((t) => t >= now - MINUTE && t - now <= s.leadMinutes * MINUTE);
    if (slot === undefined) continue;
    const status = await readNewsStatus(ctx, station.id);
    // Done for this news: fetched after the lead time started.
    if (status.slot === new Date(slot).toISOString() && !status.error && Date.parse(status.fetchedAt ?? '') >= slot - s.leadMinutes * MINUTE) continue;
    if (now - (tried.get(station.id) ?? 0) < 55_000) continue;
    tried.set(station.id, now);
    await fetchNews(ctx, station, slot);
  }
}

/**
 * The track for a news item of the clock at `slot`: the bulletin when it is fresh, else the spare jingle; null when the
 * news is off or neither is there.
 */
export async function newsTrack(ctx: AppContext, tx: Pick<AppContext['db'], 'select'>, station: Station, slot: number) {
  const s = newsSettings(station);
  if (!s.enabled) return null;
  const status = await readNewsStatus(ctx, station.id);
  const ids = [isFresh(status, s, slot) ? status.mediaId : null, s.fallbackMediaId].filter((x): x is string => !!x);
  if (!ids.length) return null;
  const rows = await tx.select().from(schema.mediaFiles).where(and(eq(schema.mediaFiles.stationId, station.id), inArray(schema.mediaFiles.id, ids)));
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (row) return { media: row, label: s.name || 'News', bulletin: id === status.mediaId };
  }
  return null;
}
