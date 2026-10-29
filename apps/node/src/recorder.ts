import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { dataPath } from './config.js';
import { log } from './log.js';
import type { RecorderPlan, RecorderStatus, RecordingFile } from './protocol.js';

const AGENT = 'Hosted Radio Station';
const FFMPEG = process.env.HRS_NODE_FFMPEG ?? '/usr/bin/ffmpeg';

/** "2026-10-29_21-00-00Z_64k.mp3": when the file starts (UTC) and its bitrate, so its length follows from its size. */
const LOG_FILE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})Z_(\d{2,3})k\.mp3$/;
const STATION_DIR = /^[0-9a-f-]{36}$/;
/** Files of a station that is no longer in the plan are kept this long, then removed like any other. */
const ORPHAN_DAYS = 31;
/** The disk keeps at least this much room: below it the oldest logging files go first. */
const MIN_FREE_BYTES = 1024 ** 3;
const MIN_FREE_SHARE = 0.05;

export const recordingsDir = () => dataPath('recordings');

/** Where a file of the recorder lives, or null for a name that is not one of its files. */
export function recordingPath(file: string): string | null {
  const [station, kind, name, ...rest] = file.split('/');
  if (rest.length || !station || !STATION_DIR.test(station) || kind !== 'log' || !name || !LOG_FILE.test(name)) return null;
  return join(recordingsDir(), station, kind, name);
}

/** The start (UTC) and bitrate of a logging file, from its name. */
export function parseLogFile(name: string): { startedAt: Date; kbps: number } | null {
  const m = LOG_FILE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, k] = m.map(Number) as number[];
  return { startedAt: new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!)), kbps: k! };
}

type LogPlan = NonNullable<RecorderPlan['stations'][number]['logging']>;

/** The ffmpeg command of a logging recording: the stream in, MP3 files of one clock hour out. */
export function loggingArgs(url: string, kbps: number, dir: string, nodeId: string) {
  return [
    ...['-nostdin', '-hide_banner', '-loglevel', 'warning'],
    ...['-user_agent', `${AGENT} ${nodeId} recorder`],
    // A short drop is bridged by ffmpeg itself; a longer one ends it and the recorder starts again (through the listen
    // route, so possibly on another relay).
    ...['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '10', '-rw_timeout', '20000000'],
    ...['-i', url],
    ...['-vn', '-map', '0:a:0', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`],
    // Every packet is written at once, so the file of the running hour can be played back almost live.
    ...['-f', 'segment', '-segment_format', 'mp3', '-segment_format_options', 'flush_packets=1', '-segment_time', '3600', '-segment_atclocktime', '1', '-reset_timestamps', '1', '-strftime', '1'],
    join(dir, `%Y-%m-%d_%H-%M-%SZ_${kbps}k.mp3`),
  ];
}

/** The continuous recording of one station. Starts again by itself, a little later each time it fails. */
class Logging {
  state: 'starting' | 'recording' | 'waiting' | 'error' = 'starting';
  message: string | undefined;
  since = new Date();
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;

  constructor(
    readonly stationId: string,
    readonly plan: LogPlan,
    private readonly nodeId: string,
  ) {}

  get dir() {
    return join(recordingsDir(), this.stationId, 'log');
  }

  private set(state: Logging['state'], message?: string) {
    if (state !== this.state) this.since = new Date();
    this.state = state;
    this.message = message;
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
    const child = spawn(FFMPEG, loggingArgs(this.plan.url, this.plan.kbps, this.dir, this.nodeId), { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TZ: 'UTC' } });
    this.child = child;
    let last = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      const line = chunk.trim().split('\n').pop();
      if (line) last = line.slice(0, 300);
    });
    // ffmpeg says nothing while it records: once a file has grown it is recording.
    const watch = setInterval(() => {
      if (this.child === child && this.state === 'starting') void this.newestSize().then((n) => n > 0 && this.child === child && this.set('recording'));
    }, 3000);
    child.on('error', (err) => {
      last = err.message;
    });
    child.on('close', (code) => {
      clearInterval(watch);
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      // A recording that ran a while was fine: the next try starts at once.
      if (Date.now() - startedAt > 60_000) this.failures = 0;
      this.set(this.failures ? 'error' : 'waiting', last || `ffmpeg stopped (${code})`);
      log.warn('logging recording stopped', { station: this.stationId, code, message: last });
      this.retry();
    });
  }

  private retry() {
    const delay = Math.min(60_000, 5000 * 2 ** Math.min(this.failures, 4));
    this.failures++;
    this.timer = setTimeout(() => void this.start().catch((err) => log.warn('starting a logging recording failed', { err })), delay);
  }

  private async newestSize() {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => LOG_FILE.test(n)).sort();
    const last = names.at(-1);
    return last ? ((await stat(join(this.dir, last)).catch(() => null))?.size ?? 0) : 0;
  }

  get running() {
    return !!this.child;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // ffmpeg closes the file it writes properly on SIGTERM.
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}

/**
 * The recorder role (phase 21): a logging recording per station, files removed after the station's retention (and
 * the oldest first when the disk runs full), the list of files for the server, and a file (or part of it) sent to
 * the server when someone listens or downloads in the panel.
 */
export class RecorderManager {
  private plan: RecorderPlan | null = null;
  private loggings = new Map<string, Logging>();
  private sweeper: NodeJS.Timeout | null = null;
  private disk: RecorderStatus['disk'] = null;
  private diskAt = 0;
  private sentKey = '';
  private sentAt = 0;

  constructor(
    private readonly nodeId: string,
    private readonly onEvent: (kind: string, level: 'info' | 'warning' | 'error', details: Record<string, string | number | null>) => void = () => undefined,
  ) {}

  apply(plan: RecorderPlan | null) {
    this.plan = plan;
    const wanted = new Map((plan?.stations ?? []).filter((s) => s.logging).map((s) => [s.stationId, s.logging!]));
    for (const [id, l] of this.loggings) {
      const want = wanted.get(id);
      if (want && JSON.stringify(want) === JSON.stringify(l.plan)) continue;
      l.stop();
      this.loggings.delete(id);
    }
    for (const [id, want] of wanted) {
      if (this.loggings.has(id)) continue;
      const l = new Logging(id, want, this.nodeId);
      this.loggings.set(id, l);
      void l.start().catch((err) => log.warn('starting a logging recording failed', { err }));
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

  /** Every logging file on disk, oldest first, with whether ffmpeg is still writing it. */
  async files(): Promise<(RecordingFile & { path: string; startMs: number })[]> {
    const out: (RecordingFile & { path: string; startMs: number })[] = [];
    const stations = (await readdir(recordingsDir()).catch(() => [] as string[])).filter((n) => STATION_DIR.test(n));
    for (const stationId of stations) {
      const dir = join(recordingsDir(), stationId, 'log');
      const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => LOG_FILE.test(n)).sort();
      const writing = this.loggings.get(stationId)?.running ?? false;
      for (const [i, name] of names.entries()) {
        const st = await stat(join(dir, name)).catch(() => null);
        const p = parseLogFile(name);
        if (!st || !p) continue;
        out.push({
          stationId,
          kind: 'log',
          file: `${stationId}/log/${name}`,
          startedAt: p.startedAt.toISOString(),
          seconds: Math.round((st.size * 8) / (p.kbps * 1000)),
          bytes: st.size,
          open: writing && i === names.length - 1 && Date.now() - st.mtimeMs < 60_000,
          path: join(dir, name),
          startMs: p.startedAt.getTime(),
        });
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
    const files = await this.files();
    const gone = new Set<string>();
    for (const f of files) {
      if (f.open) continue;
      const keep = (days.get(f.stationId) ?? ORPHAN_DAYS) * 86400_000;
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
        if (f.open || gone.has(f.file)) continue;
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
      const left = await readdir(join(recordingsDir(), stationId, 'log')).catch(() => [] as string[]);
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
      stations: [...this.loggings.values()].map((l) => ({ stationId: l.stationId, kind: 'log' as const, state: l.state, message: l.message, since: l.since.toISOString() })),
      disk: await this.diskUsage(),
    };
  }

  get problems(): string[] {
    const names = new Map((this.plan?.stations ?? []).map((s) => [s.stationId, s.name]));
    return [...this.loggings.values()].filter((l) => l.state === 'error').map((l) => `Recording ${names.get(l.stationId) ?? l.stationId}: ${l.message ?? 'failed'}`);
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
