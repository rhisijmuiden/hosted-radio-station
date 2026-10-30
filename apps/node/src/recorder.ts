import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { dataPath } from './config.js';
import { log } from './log.js';
import type { RecorderPlan, RecorderShow, RecorderStatus, RecordingFile } from './protocol.js';

const AGENT = 'Hosted Radio Station';
const FFMPEG = process.env.HRS_NODE_FFMPEG ?? '/usr/bin/ffmpeg';
const FFPROBE = process.env.HRS_NODE_FFPROBE ?? '/usr/bin/ffprobe';

/**
 * The length of a finished show in seconds, read by ffprobe: a DJ may send another bitrate than the mount says, so
 * the size alone does not tell. Null when ffprobe cannot tell.
 */
function probeSeconds(path: string): Promise<number | null> {
  return new Promise((resolve) =>
    execFile(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: 30_000 }, (err, out) => {
      const n = Number(String(out).trim());
      resolve(err || !Number.isFinite(n) ? null : Math.round(n));
    }),
  );
}

/** "2026-10-29_21-00-00Z_64k.mp3": when the file starts (UTC) and its bitrate, so its length follows from its size. */
const LOG_FILE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})Z_(\d{2,3})k\.mp3$/;
const STATION_DIR = /^[0-9a-f-]{36}$/;
/** Files of a station that is no longer in the plan are kept this long, then removed like any other. */
const ORPHAN_DAYS = 31;
/** The disk keeps at least this much room: below it the oldest logging files go first. */
const MIN_FREE_BYTES = 1024 ** 3;
const MIN_FREE_SHARE = 0.05;

export const recordingsDir = () => dataPath('recordings');

/** "2026-10-29_21-04-13Z_192k_<session id>.mp3": a live show, as it was sent (step 2). */
const SHOW_FILE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})Z_(\d{2,3})k_([0-9a-f-]{36})\.(mp3|aac|opus|ogg)$/;
const KINDS = { log: LOG_FILE, show: SHOW_FILE } as const;
type Kind = keyof typeof KINDS;

/** Where a file of the recorder lives, or null for a name that is not one of its files. */
export function recordingPath(file: string): string | null {
  const [station, kind, name, ...rest] = file.split('/');
  if (rest.length || !station || !STATION_DIR.test(station) || (kind !== 'log' && kind !== 'show') || !name || !KINDS[kind].test(name)) return null;
  return join(recordingsDir(), station, kind, name);
}

/** The start (UTC) and bitrate of a recording, from its name, and the live broadcast of a show. */
export function parseLogFile(name: string): { startedAt: Date; kbps: number; sessionId?: string } | null {
  const m = LOG_FILE.exec(name) ?? SHOW_FILE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s, k] = m.slice(1, 8).map(Number) as number[];
  return { startedAt: new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!)), kbps: k!, ...(m[8] ? { sessionId: m[8] } : {}) };
}

type LogPlan = NonNullable<RecorderPlan['stations'][number]['logging']>;

const input = (url: string, nodeId: string) => [
  ...['-nostdin', '-hide_banner', '-loglevel', 'warning'],
  ...['-user_agent', `${AGENT} ${nodeId} recorder`],
  // A short drop is bridged by ffmpeg itself; a longer one ends it and the recorder starts again (through the listen
  // route, so possibly on another relay).
  ...['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '10', '-rw_timeout', '20000000'],
  ...['-i', url],
];

/** The ffmpeg command of a logging recording: the stream in, MP3 files of one clock hour out. */
export function loggingArgs(url: string, kbps: number, dir: string, nodeId: string) {
  return [
    ...input(url, nodeId),
    ...['-vn', '-map', '0:a:0', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`],
    // Every packet is written at once, so the file of the running hour can be played back almost live.
    ...['-f', 'segment', '-segment_format', 'mp3', '-segment_format_options', 'flush_packets=1', '-segment_time', '3600', '-segment_atclocktime', '1', '-reset_timestamps', '1', '-strftime', '1'],
    join(dir, `%Y-%m-%d_%H-%M-%SZ_${kbps}k.mp3`),
  ];
}

const SHOW_FORMATS: Record<RecorderShow['format'], { ext: string; muxer: string }> = { mp3: { ext: 'mp3', muxer: 'mp3' }, aac: { ext: 'aac', muxer: 'adts' }, opus: { ext: 'opus', muxer: 'ogg' }, vorbis: { ext: 'ogg', muxer: 'ogg' } };
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');

/** The name of a show file that starts now. */
export const showFileName = (show: RecorderShow, at = new Date()) => `${stamp(at)}Z_${Math.min(999, Math.max(10, Math.round(show.kbps)))}k_${show.sessionId}.${SHOW_FORMATS[show.format].ext}`;

/** The ffmpeg command of a live show: the stream as it is sent (no new encoding), into one file. */
export function showArgs(show: RecorderShow, path: string, nodeId: string) {
  return [...input(show.url, nodeId), '-vn', '-map', '0:a:0', '-c:a', 'copy', '-flush_packets', '1', '-f', SHOW_FORMATS[show.format].muxer, path];
}

type State = 'starting' | 'recording' | 'waiting' | 'error';

/**
 * One ffmpeg recording that starts again by itself, a little later each time it fails: the logging of a station, or
 * a live show (a new file for every start, so a show that broke off has more than one part).
 */
class Recording {
  state: State = 'starting';
  message: string | undefined;
  since = new Date();
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;
  private closed: Promise<void> = Promise.resolve();
  /** A show: shorter than this when it ends = thrown away (from the plans while it was on air). */
  minSeconds = 0;

  constructor(
    readonly stationId: string,
    readonly kind: Kind,
    readonly plan: LogPlan | RecorderShow,
    private readonly nodeId: string,
    /** Called when a new file starts growing, so the server hears of it at once. */
    private readonly onFile: () => void = () => undefined,
  ) {}

  get dir() {
    return join(recordingsDir(), this.stationId, this.kind);
  }

  get sessionId() {
    return this.kind === 'show' ? (this.plan as RecorderShow).sessionId : undefined;
  }

  private set(state: State, message?: string) {
    if (state !== this.state) this.since = new Date();
    this.state = state;
    this.message = message;
  }

  private args() {
    if (this.kind === 'log') return loggingArgs((this.plan as LogPlan).url, (this.plan as LogPlan).kbps, this.dir, this.nodeId);
    const show = this.plan as RecorderShow;
    return showArgs(show, join(this.dir, showFileName(show)), this.nodeId);
  }

  async start() {
    if (this.stopped) return;
    if (!existsSync(FFMPEG)) {
      this.set('error', 'ffmpeg is not installed yet');
      this.retry();
      return;
    }
    await mkdir(this.dir, { recursive: true });
    if (this.stopped) return;
    this.set('starting');
    const startedAt = Date.now();
    const child = spawn(FFMPEG, this.args(), { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TZ: 'UTC' } });
    this.child = child;
    let last = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      const line = chunk.trim().split('\n').pop();
      if (line) last = line.slice(0, 300);
    });
    // ffmpeg says nothing while it records: once a file has grown it is recording.
    const watch = setInterval(() => {
      if (this.child === child && this.state === 'starting') void this.newestSize().then((n) => {
        if (n <= 0 || this.child !== child) return;
        this.set('recording');
        this.onFile();
      });
    }, 3000);
    child.on('error', (err) => {
      last = err.message;
    });
    this.closed = new Promise((resolve) =>
      child.on('close', (code) => {
        clearInterval(watch);
        resolve();
        if (this.child !== child) return;
        this.child = null;
        if (this.stopped) return;
        // A recording that ran a while was fine: the next try starts at once.
        if (Date.now() - startedAt > 60_000) this.failures = 0;
        this.set(this.failures ? 'error' : 'waiting', last || `ffmpeg stopped (${code})`);
        log.warn('recording stopped', { station: this.stationId, kind: this.kind, code, message: last });
        this.retry();
      }),
    );
  }

  private retry() {
    const delay = Math.min(60_000, 5000 * 2 ** Math.min(this.failures, 4));
    this.failures++;
    this.timer = setTimeout(() => void this.start().catch((err) => log.warn('starting a recording failed', { err })), delay);
  }

  /** The files of this recording: all logging files, or the parts of this show. */
  async names() {
    const all = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => KINDS[this.kind].test(n));
    return (this.kind === 'show' ? all.filter((n) => n.includes(`_${this.sessionId}.`)) : all).sort();
  }

  private async newestSize() {
    const last = (await this.names()).at(-1);
    return last ? ((await stat(join(this.dir, last)).catch(() => null))?.size ?? 0) : 0;
  }

  get running() {
    return !!this.child;
  }

  /** Stops ffmpeg (it closes the file it writes properly on SIGTERM) and waits until it is gone. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.child?.kill('SIGTERM');
    this.child = null;
    await Promise.race([this.closed, new Promise((r) => setTimeout(r, 5000))]);
  }
}

/**
 * The recorder role (phase 21): a logging recording per station and a recording of every live show while it is on
 * air, files removed after the station's retention (and the oldest logging files first when the disk runs full), the
 * list of files for the server, and a file (or part of it) sent to the server when someone listens or downloads.
 */
export class RecorderManager {
  private plan: RecorderPlan | null = null;
  /** "log:<station id>" and "show:<session id>". */
  private recordings = new Map<string, Recording>();
  private sweeper: NodeJS.Timeout | null = null;
  private disk: RecorderStatus['disk'] = null;
  private diskAt = 0;
  private sentKey = '';
  /** Lengths of finished shows by path and size, so ffprobe reads each one once. */
  private lengths = new Map<string, number>();
  private sentAt = 0;

  constructor(
    private readonly nodeId: string,
    private readonly onEvent: (kind: string, level: 'info' | 'warning' | 'error', details: Record<string, string | number | null>) => void = () => undefined,
    /** The list of files changed (a recording started, a show ended): the agent reports it now instead of in 30 s. */
    private readonly onChange: () => void = () => undefined,
  ) {}

  apply(plan: RecorderPlan | null) {
    this.plan = plan;
    const wanted = new Map<string, { stationId: string; kind: Kind; plan: LogPlan | RecorderShow; minSeconds: number }>();
    for (const st of plan?.stations ?? []) {
      if (st.logging) wanted.set(`log:${st.stationId}`, { stationId: st.stationId, kind: 'log', plan: st.logging, minSeconds: 0 });
      for (const show of st.shows?.live ?? []) wanted.set(`show:${show.sessionId}`, { stationId: st.stationId, kind: 'show', plan: show, minSeconds: (st.shows?.minMinutes ?? 0) * 60 });
    }
    for (const [key, r] of this.recordings) {
      const want = wanted.get(key);
      if (want && JSON.stringify(want.plan) === JSON.stringify(r.plan)) {
        r.minSeconds = want.minSeconds;
        continue;
      }
      this.recordings.delete(key);
      // A show that went off air: its file is complete. One that was only a test is thrown away.
      void r
        .stop()
        .then(() => (r.kind === 'show' && !want ? this.dropShort(r) : undefined))
        .then(() => this.onChange())
        .catch((err) => log.warn('stopping a recording failed', { err }));
    }
    for (const [key, want] of wanted) {
      if (this.recordings.has(key)) continue;
      const r = new Recording(want.stationId, want.kind, want.plan, this.nodeId, () => this.onChange());
      r.minSeconds = want.minSeconds;
      this.recordings.set(key, r);
      if (want.kind === 'show') log.info('recording a live show', { station: want.stationId, dj: (want.plan as RecorderShow).dj });
      void r.start().catch((err) => log.warn('starting a recording failed', { err }));
    }
    if (plan && !this.sweeper) {
      this.sweeper = setInterval(() => void this.sweep().catch((err) => log.warn('cleaning up recordings failed', { err })), 5 * 60_000);
      setTimeout(() => void this.sweep().catch(() => undefined), 10_000);
    } else if (!plan && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  stop() {
    this.apply(null);
  }

  /** Removes the parts of a show that ended when together they are shorter than the station wants to keep. */
  private async dropShort(r: Recording) {
    const min = r.minSeconds;
    const names = await r.names();
    let seconds = 0;
    for (const n of names) seconds += ((await stat(join(r.dir, n)).catch(() => null))?.size ?? 0) * 8 / ((parseLogFile(n)?.kbps ?? 128) * 1000);
    if (seconds >= min) return;
    for (const n of names) await unlink(join(r.dir, n)).catch(() => undefined);
    log.info('a live show was too short to keep', { station: r.stationId, seconds: Math.round(seconds) });
  }

  /** Every recording on disk, oldest first, with whether ffmpeg is still writing it. */
  async files(): Promise<(RecordingFile & { path: string; startMs: number })[]> {
    const out: (RecordingFile & { path: string; startMs: number })[] = [];
    const stations = (await readdir(recordingsDir()).catch(() => [] as string[])).filter((n) => STATION_DIR.test(n));
    for (const stationId of stations) {
      for (const kind of ['log', 'show'] as const) {
        const dir = join(recordingsDir(), stationId, kind);
        const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => KINDS[kind].test(n)).sort();
        for (const [i, name] of names.entries()) {
          const st = await stat(join(dir, name)).catch(() => null);
          const p = parseLogFile(name);
          if (!st || !p) continue;
          const writer = this.recordings.get(kind === 'log' ? `log:${stationId}` : `show:${p.sessionId}`);
          // The newest file of a running recording, while it still grows.
          const newest = kind === 'log' ? i === names.length - 1 : !names.slice(i + 1).some((n) => n.includes(`_${p.sessionId}.`));
          const open = !!writer?.running && newest && Date.now() - st.mtimeMs < 60_000;
          let seconds = Math.round((st.size * 8) / (p.kbps * 1000));
          if (kind === 'show' && !open && existsSync(FFPROBE)) {
            const key = `${join(dir, name)}:${st.size}`;
            if (!this.lengths.has(key)) this.lengths.set(key, (await probeSeconds(join(dir, name))) ?? seconds);
            seconds = this.lengths.get(key)!;
          }
          out.push({
            stationId,
            kind,
            ...(p.sessionId ? { sessionId: p.sessionId } : {}),
            file: `${stationId}/${kind}/${name}`,
            startedAt: p.startedAt.toISOString(),
            seconds,
            bytes: st.size,
            open,
            path: join(dir, name),
            startMs: p.startedAt.getTime(),
          });
        }
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  /** The list for the bulk report: when a file came, went or was closed, and every ten minutes. Undefined = no news. */
  async report(): Promise<RecordingFile[] | undefined> {
    if (!this.plan && !this.sentKey) return undefined;
    const files = (await this.files()).map(({ path: _p, startMs: _s, ...f }) => f);
    const key = files.map((f) => `${f.file}:${f.open ? 1 : 0}`).join('|');
    if (key === this.sentKey && Date.now() - this.sentAt < 10 * 60_000) return undefined;
    return files.slice(-20_000);
  }

  /** The report with the list was accepted. */
  reported(files: RecordingFile[] | undefined) {
    if (!files) return;
    this.sentKey = files.map((f) => `${f.file}:${f.open ? 1 : 0}`).join('|');
    this.sentAt = Date.now();
  }

  /** Removes files past their station's retention, then the oldest ones while the disk is too full. */
  async sweep(now = Date.now()) {
    const days = new Map((this.plan?.stations ?? []).map((s) => [s.stationId, s.logging?.days ?? ORPHAN_DAYS]));
    const showDays = new Map((this.plan?.stations ?? []).map((s) => [s.stationId, s.shows?.days ?? ORPHAN_DAYS]));
    const files = await this.files();
    const gone = new Set<string>();
    for (const f of files) {
      if (f.open) continue;
      const keep = ((f.kind === 'show' ? showDays : days).get(f.stationId) ?? ORPHAN_DAYS) * 86400_000;
      if (f.startMs + f.seconds * 1000 < now - keep) {
        await unlink(f.path).catch(() => undefined);
        gone.add(f.file);
      }
    }
    const disk = await this.diskUsage(true);
    if (disk && disk.freeBytes < Math.max(MIN_FREE_BYTES, disk.totalBytes * MIN_FREE_SHARE)) {
      let need = Math.max(MIN_FREE_BYTES, disk.totalBytes * MIN_FREE_SHARE) - disk.freeBytes;
      let removed = 0;
      for (const f of files) {
        if (need <= 0) break;
        // Shows are kept: only logging makes room.
        if (f.open || f.kind !== 'log' || gone.has(f.file)) continue;
        await unlink(f.path).catch(() => undefined);
        need -= f.bytes;
        removed++;
      }
      if (removed) {
        this.onEvent('recorder_disk_full', 'warning', { removed, freeMb: Math.round(disk.freeBytes / 1048576) });
        await this.diskUsage(true);
      }
    }
    // Folders of stations that left the plan and have no files any more.
    for (const stationId of (await readdir(recordingsDir()).catch(() => [] as string[])).filter((n) => STATION_DIR.test(n))) {
      if (days.has(stationId)) continue;
      const left = [...(await readdir(join(recordingsDir(), stationId, 'log')).catch(() => [] as string[])), ...(await readdir(join(recordingsDir(), stationId, 'show')).catch(() => [] as string[]))];
      if (!left.length) await rm(join(recordingsDir(), stationId), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async diskUsage(fresh = false): Promise<RecorderStatus['disk']> {
    if (!fresh && Date.now() - this.diskAt < 30_000) return this.disk;
    this.diskAt = Date.now();
    try {
      await mkdir(recordingsDir(), { recursive: true });
      const s = await statfs(recordingsDir());
      const totalBytes = s.blocks * s.bsize;
      const freeBytes = s.bavail * s.bsize;
      this.disk = { totalBytes, freeBytes, usedBytes: totalBytes - s.bfree * s.bsize };
    } catch {
      this.disk = null;
    }
    return this.disk;
  }

  async status(): Promise<RecorderStatus | null> {
    if (!this.plan) return null;
    return {
      stations: [...this.recordings.values()].map((r) => ({ stationId: r.stationId, kind: r.kind, ...(r.sessionId ? { sessionId: r.sessionId } : {}), state: r.state, message: r.message, since: r.since.toISOString() })),
      disk: await this.diskUsage(),
    };
  }

  get problems(): string[] {
    const names = new Map((this.plan?.stations ?? []).map((s) => [s.stationId, s.name]));
    return [...this.recordings.values()].filter((r) => r.state === 'error').map((r) => `Recording ${r.kind === 'show' ? 'the live show of ' : ''}${names.get(r.stationId) ?? r.stationId}: ${r.message ?? 'failed'}`);
  }

  /**
   * Sends bytes start..end of a file to the server, which passes them on to the panel. Throws with a message for the
   * panel when the file is not there.
   */
  async send(server: string, auth: string, id: string, file: string, start: number, end: number | null) {
    const path = recordingPath(file);
    if (!path) throw new Error('Not a recording');
    const st = await stat(path).catch(() => null);
    if (!st) throw new Error('The recording is no longer on the recorder');
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(st.size, end === null ? st.size : Math.floor(end));
    if (from > to || (from === to && st.size > 0)) throw new Error('Outside the recording');
    const body = to > from ? Readable.toWeb(createReadStream(path, { start: from, end: to - 1 })) : null;
    const res = await fetch(`${server}/api/nodes/agent/recordings/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(to - from), authorization: auth, 'user-agent': `${AGENT} node`, 'x-hrs-size': String(st.size), 'x-hrs-start': String(from) },
      body: body as never,
      duplex: 'half',
    } as RequestInit);
    await res.body?.cancel();
    if (!res.ok && res.status !== 410) throw new Error(`The server answered ${res.status}`);
  }
}
