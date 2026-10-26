import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import type { FastifyBaseLogger } from 'fastify';
import type { OutputConfig } from '../db/schema.js';
import type { AppContext } from '../lib/context.js';
import { CONTENT_TYPES, INTERNAL_AGENT } from '../services/streaming/icecast.js';
import { splitTitle } from '../services/public/artwork.js';
import type { Mount, Output } from '../services/streaming/state.js';
import type { StationView } from './snapshot.js';

export interface RelayState {
  id: string;
  kind: 'transcode' | 'push' | 'monitor' | 'record';
  station: string;
  name: string;
  state: 'idle' | 'connecting' | 'connected' | 'error';
  message?: string;
  since?: string;
}

/** A long-running job (ffmpeg transcoder, push to an external server) that is restarted with a growing delay. */
export abstract class Relay {
  state: RelayState;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;
  /** Changes when the configuration changes, so the supervisor knows to restart. */
  abstract readonly key: string;
  /** The local mount this job reads, so its connection is not counted as a listener. */
  abstract readonly input: { stationId: string; mount: string };
  onState?: (s: RelayState) => void;

  constructor(
    readonly id: string,
    kind: RelayState['kind'],
    station: string,
    name: string,
    protected readonly log: FastifyBaseLogger,
  ) {
    this.state = { id, kind, station, name, state: 'idle' };
  }

  protected set(state: RelayState['state'], message?: string) {
    const changed = state !== this.state.state || message !== this.state.message;
    this.state = { ...this.state, state, message, since: changed ? new Date().toISOString() : this.state.since };
    if (changed) this.onState?.(this.state);
  }

  start() {
    this.stopped = false;
    void this.loop();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.halt();
    this.set('idle');
  }

  private async loop() {
    if (this.stopped) return;
    this.set('connecting');
    const started = Date.now();
    let error: string | undefined;
    try {
      await this.run();
    } catch (err) {
      error = (err as Error).message;
    }
    if (this.stopped) return;
    // A run that lasted a while resets the delay.
    this.failures = Date.now() - started > 60_000 ? 0 : this.failures + 1;
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(this.failures, 4));
    this.set('error', error ?? 'Connection ended');
    this.retry = setTimeout(() => void this.loop(), delay);
  }

  /** Runs until the connection ends; throws with a readable message on failure. */
  protected abstract run(): Promise<void>;
  protected abstract halt(): void;
}

const codecArgs: Record<Mount['format'], (kbps: number) => string[]> = {
  mp3: (k) => ['-c:a', 'libmp3lame', '-b:a', `${k}k`, '-ar', '44100', '-f', 'mp3'],
  aac: (k) => ['-c:a', 'aac', '-b:a', `${k}k`, '-ar', '44100', '-f', 'adts'],
  opus: (k) => ['-c:a', 'libopus', '-b:a', `${k}k`, '-ar', '48000', '-f', 'ogg'],
  vorbis: (k) => ['-c:a', 'libvorbis', '-b:a', `${k}k`, '-ar', '44100', '-f', 'ogg'],
};

const OGG_FORMATS: Mount['format'][] = ['opus', 'vorbis'];
/** Raw audio between the decoder and the encoder of an Ogg mount. */
const PCM = ['-f', 's16le', '-ar', '48000', '-ac', '2'];

/** Makes a converted mount (another format or bitrate) from a source mount on the same Icecast server, with ffmpeg. */
export class Transcoder extends Relay {
  readonly key: string;
  readonly input: { stationId: string; mount: string };
  /** The title playing now, so an Ogg encoder (re)started by this job carries it from its first page. */
  titleOf?: () => string | undefined;
  private children = new Set<ChildProcess>();
  private socket: net.Socket | null = null;
  /** Ogg mounts only: the encoder feeding the mount now, and the title inside its stream. */
  private encoder: { child: ChildProcess; title: string | undefined; ended: Promise<void> } | null = null;
  /** Settles the running run(). */
  private finish: (err?: Error) => void = () => undefined;

  constructor(
    private readonly view: StationView,
    private readonly mount: Mount,
    private readonly source: Mount,
    log: FastifyBaseLogger,
  ) {
    super(`transcode:${mount.id}`, 'transcode', view.station.slug, `${source.path} → ${mount.path}`, log);
    this.key = JSON.stringify([view.station.icecastPort, view.sourcePassword, source.path, mount.path, mount.format, mount.bitrateKbps, view.station.name]);
    this.input = { stationId: view.station.id, mount: source.path };
  }

  /** The converted mount this job feeds. */
  get output() {
    return this.mount.path;
  }

  /**
   * Icecast does not take title updates over HTTP for Ogg mounts: the title has to be inside the stream. Such mounts
   * are made by a decoder and an encoder, and a new title starts a new encoder with that title in its comment header.
   * Its stream follows the old one (a chained Ogg stream, which is how Ogg radio carries titles) at the same sample.
   * Icecast 2.4 reads Vorbis titles back into its status; for Opus only the listeners' players see them.
   * Returns false for other formats, whose title goes through /admin/metadata.
   */
  setTitle(title: string) {
    if (!this.isOgg) return false;
    if (this.encoder && this.encoder.title !== title && this.socket) this.startEncoder(this.socket, title);
    return true;
  }

  private get isOgg() {
    return OGG_FORMATS.includes(this.mount.format);
  }

  protected async run() {
    const { station } = this.view;
    // ffmpeg writes to stdout and this process logs in on Icecast, so the source password never shows up in the
    // process list (ps, /proc/<pid>/cmdline) the way an icecast:// URL would.
    const target = await sourceConnection(station.icecastPort, this.mount.path, this.view.sourcePassword, {
      'Content-Type': CONTENT_TYPES[this.mount.format],
      'ice-name': this.mount.name ? `${station.name} – ${this.mount.name}` : station.name,
      'ice-public': '0',
      'ice-audio-info': `bitrate=${this.mount.bitrateKbps}`,
    });
    this.socket = target;
    const input = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-user_agent', `${INTERNAL_AGENT} transcoder`, '-i', `http://127.0.0.1:${station.icecastPort}${this.source.path}`, '-vn', '-map', '0:a:0', '-ac', '2'];
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (this.finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(up);
        this.halt();
        if (err) reject(err);
        else resolve();
      });
      const child = this.spawn(this.isOgg ? [...input, ...PCM, 'pipe:1'] : [...input, ...codecArgs[this.mount.format](this.mount.bitrateKbps), 'pipe:1'], finish);
      if (this.isOgg) {
        this.startEncoder(target, this.titleOf?.());
        child.stdout!.on('data', (pcm: Buffer) => this.encoder?.child.stdin?.write(pcm));
      } else child.stdout!.pipe(target);
      target.on('error', () => finish(new Error('local server closed the connection')));
      target.on('close', () => finish(new Error('local server closed the connection')));
      // ffmpeg prints nothing while it works; consider it connected after a few seconds without an exit.
      const up = setTimeout(() => this.set('connected'), 4000);
    });
  }

  /** Starts an ffmpeg process; it settles the run when it stops, unless it was retired on purpose. */
  private spawn(args: string[], finish: (err?: Error) => void, stdin: 'ignore' | 'pipe' = 'ignore') {
    const child = spawn('ffmpeg', args, { stdio: [stdin, 'pipe', 'pipe'] });
    this.children.add(child);
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', (err) => finish(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'ffmpeg is not installed' : err.message)));
    child.on('exit', (code) => {
      const retired = !this.children.has(child);
      this.children.delete(child);
      if (retired) return;
      const last = stderr.trim().split('\n').pop();
      finish(code === 0 ? undefined : new Error(last ?? `ffmpeg stopped (${code})`));
    });
    return child;
  }

  /** Ogg: a new encoder takes the audio from now on; the old one flushes its last pages and ends its stream first. */
  private startEncoder(target: net.Socket, title: string | undefined) {
    const meta: string[] = [];
    if (title) {
      const { artist, title: song } = splitTitle(title);
      for (const [k, v] of Object.entries({ title: song, ...(artist ? { artist } : {}) })) meta.push('-metadata', `${k}=${v}`, '-metadata:s:a:0', `${k}=${v}`);
    }
    const child = this.spawn(['-nostdin', '-hide_banner', '-loglevel', 'error', ...PCM, '-i', 'pipe:0', '-map_metadata', '-1', ...meta, ...codecArgs[this.mount.format](this.mount.bitrateKbps), 'pipe:1'], this.finish, 'pipe');
    const previous = this.encoder;
    const ended = new Promise<void>((resolve) => child.stdout!.once('close', () => resolve()));
    this.encoder = { child, title, ended };
    // Its output waits until the old stream has ended, so pages of the two streams never mix.
    void (previous?.ended ?? Promise.resolve()).then(() => {
      if (!target.destroyed) child.stdout!.pipe(target, { end: false });
    });
    if (previous) {
      this.children.delete(previous.child);
      previous.child.stdin?.end();
    }
  }

  protected halt() {
    for (const child of this.children) child.kill('SIGTERM');
    this.children.clear();
    if (this.encoder) this.encoder.child.kill('SIGTERM');
    this.encoder = null;
    this.socket?.destroy();
    this.socket = null;
  }
}

/** Logs in as the source of a mount on a station's own Icecast server (HTTP PUT) and returns the open connection. */
function sourceConnection(port: number, mount: string, password: string, headers: Record<string, string>): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('error', (err) => reject(new Error(`local server: ${err.message}`)));
    socket.once('connect', () => {
      const head = [
        `PUT ${mount} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Authorization: Basic ${Buffer.from(`source:${password}`).toString('base64')}`,
        `User-Agent: ${INTERNAL_AGENT} transcoder`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v.replace(/[\r\n]/g, ' ')}`),
        'Expect: 100-continue',
      ];
      socket.write(`${head.join('\r\n')}\r\n\r\n`);
      readResponse(socket, /HTTP\/1\.[01] (?!100)\d{3}[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/).then(
        (answer) => {
          const status = [...answer.matchAll(/HTTP\/1\.[01] (\d{3})([^\r\n]*)/g)].map((m) => m[1]).find((code) => code !== '100');
          if (status === '200') return resolve(socket);
          socket.destroy();
          reject(new Error(status === '403' ? `mount ${mount} is in use` : `local server answered ${status ?? '?'}`));
        },
        (err: Error) => {
          socket.destroy();
          reject(err);
        },
      );
    });
  });
}

function connectExternal(c: OutputConfig, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const opts = { host: c.host!, port, timeout: 10_000 };
    const socket = c.tls ? tls.connect({ ...opts, servername: net.isIP(c.host!) ? undefined : c.host! }) : net.connect(opts);
    const fail = (err: Error) => {
      socket.destroy();
      reject(new Error(`${c.host}:${port}: ${(err as NodeJS.ErrnoException).code ?? err.message}`));
    };
    socket.once(c.tls ? 'secureConnect' : 'connect', () => {
      socket.off('error', fail);
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once('error', fail);
    socket.once('timeout', () => fail(new Error('timeout')));
  });
}

function readResponse(socket: net.Socket, until: RegExp, max = 8192): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => done(new Error('no answer from the server')), 10_000);
    const onData = (d: Buffer) => {
      text += d.toString('latin1');
      if (until.test(text) || text.length > max) done(null);
    };
    const onClose = () => done(new Error(text.trim() ? `server said: ${text.trim().split(/\r?\n/).slice(-1)[0]}` : 'the server closed the connection'));
    function done(err: Error | null) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      if (err) reject(err);
      else resolve(text);
    }
    socket.on('data', onData);
    socket.once('close', onClose);
  });
}

/**
 * Sends a local mount unchanged to an external Icecast or Shoutcast server. Reads the mount from the station's own
 * Icecast server, logs in on the external server and passes the bytes through.
 */
export class Pusher extends Relay {
  readonly key: string;
  readonly input: { stationId: string; mount: string };
  private sockets: { destroy(): void }[] = [];

  constructor(
    private readonly ctx: AppContext,
    private readonly view: StationView,
    private readonly output: Output,
    private readonly mount: Mount,
    log: FastifyBaseLogger,
  ) {
    super(`push:${output.id}`, 'push', view.station.slug, output.name, log);
    this.key = JSON.stringify([output.type, output.config, mount.path, view.station.icecastPort, view.station.name, view.station.genre, view.station.website]);
    this.input = { stationId: view.station.id, mount: mount.path };
  }

  private password(enc?: string) {
    return enc ? this.ctx.box.decrypt(enc) : '';
  }

  protected async run() {
    // Whatever step fails, both connections are closed before the next attempt.
    try {
      await this.push();
    } finally {
      this.halt();
    }
  }

  private async push() {
    const c = this.output.config;
    const { station } = this.view;
    // 1. The local mount.
    const local = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: station.icecastPort, path: this.mount.path, headers: { 'user-agent': `${INTERNAL_AGENT} relay`, 'icy-metadata': '0' } },
        (res) => (res.statusCode === 200 ? resolve(res) : (res.resume(), reject(new Error(`local mount ${this.mount.path} is not on air`)))),
      );
      req.on('error', (err) => reject(new Error(`local server: ${err.message}`)));
      this.sockets.push(req);
    });
    this.sockets.push(local);
    const contentType = local.headers['content-type'] ?? CONTENT_TYPES[this.mount.format];
    const pass = this.password(c.password);

    // 2. Log in on the external server.
    let remote: net.Socket;
    if (this.output.type === 'icecast') {
      remote = await connectExternal(c, c.port!);
      this.sockets.push(remote);
      const head = [
        `PUT ${c.mount} HTTP/1.1`,
        `Host: ${c.host}:${c.port}`,
        `Authorization: Basic ${Buffer.from(`${c.username || 'source'}:${pass}`).toString('base64')}`,
        'User-Agent: Hosted Radio Station',
        `Content-Type: ${contentType}`,
        `ice-name: ${station.name}`,
        station.description ? `ice-description: ${station.description}` : '',
        station.genre ? `ice-genre: ${station.genre}` : '',
        station.website ? `ice-url: ${station.website}` : '',
        'ice-public: 0',
        `ice-audio-info: bitrate=${this.mount.bitrateKbps}`,
        'Expect: 100-continue',
      ].filter(Boolean);
      remote.write(`${head.join('\r\n')}\r\n\r\n`);
      const answer = await readResponse(remote, /HTTP\/1\.[01] (?!100)\d{3}[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/);
      const status = [...answer.matchAll(/HTTP\/1\.[01] (\d{3})([^\r\n]*)/g)].map((m) => m.slice(1)).find(([code]) => code !== '100');
      if (!status || status[0] !== '200') {
        throw new Error(status?.[0] === '401' ? 'wrong user name or password' : status?.[0] === '403' ? 'mount in use or not allowed' : `server answered ${status?.join('') ?? '?'}`);
      }
    } else {
      // Shoutcast takes encoders on the port after the listener port; v2 selects the stream with "password:#id".
      remote = await connectExternal(c, c.port! + 1);
      this.sockets.push(remote);
      remote.write(`${this.output.type === 'shoutcast2' ? `${pass}:#${c.streamId ?? 1}` : pass}\r\n`);
      const answer = await readResponse(remote, /\r?\n/);
      if (!/^OK/i.test(answer.trim())) throw new Error(/invalid/i.test(answer) ? 'wrong password' : `server answered ${answer.trim().slice(0, 80)}`);
      const icy = [
        `content-type:${contentType}`,
        `icy-name:${station.name}`,
        `icy-genre:${station.genre}`,
        `icy-url:${station.website}`,
        'icy-pub:0',
        `icy-br:${this.mount.bitrateKbps}`,
      ];
      remote.write(`${icy.join('\r\n')}\r\n\r\n`);
    }

    // 3. Pass the stream through until either side stops.
    this.set('connected');
    this.log.info({ station: station.slug, output: this.output.name }, 'relay connected');
    await new Promise<void>((resolve, reject) => {
      local.pipe(remote);
      remote.on('data', () => undefined);
      local.once('end', () => resolve());
      local.once('error', (err) => reject(new Error(`local server: ${err.message}`)));
      remote.once('error', (err) => reject(new Error(`${c.host}: ${err.message}`)));
      remote.once('close', () => reject(new Error('the external server closed the connection')));
    });
  }

  protected halt() {
    for (const s of this.sockets) s.destroy();
    this.sockets = [];
  }

  /** Forwards a new title to the external server. */
  async updateTitle(title: string) {
    const c = this.output.config;
    const scheme = c.tls ? 'https' : 'http';
    const pass = this.password(c.password);
    let url: string;
    const headers: Record<string, string> = { 'user-agent': 'Hosted Radio Station' };
    if (this.output.type === 'icecast') {
      url = `${scheme}://${c.host}:${c.port}/admin/metadata?${new URLSearchParams({ mount: c.mount!, mode: 'updinfo', song: title, charset: 'UTF-8' })}`;
      headers.authorization = `Basic ${Buffer.from(`${c.username || 'source'}:${pass}`).toString('base64')}`;
    } else {
      const q = new URLSearchParams({ mode: 'updinfo', song: title, pass });
      if (this.output.type === 'shoutcast2') q.set('sid', String(c.streamId ?? 1));
      url = `${scheme}://${c.host}:${c.port}/admin.cgi?${q}`;
    }
    await fetch(url, { headers, signal: AbortSignal.timeout(5000) }).then((r) => r.body?.cancel());
  }
}

/** Listener count (and whether a source is connected) on an external server. */
export async function externalListeners(ctx: AppContext, output: Output): Promise<{ listeners: number | null; live: boolean; title?: string }> {
  const c = output.config;
  const base = `${c.tls ? 'https' : 'http'}://${c.host}:${c.port}`;
  const get = (path: string) => fetch(`${base}${path}`, { headers: { 'user-agent': 'Mozilla/5.0 (Hosted Radio Station)' }, signal: AbortSignal.timeout(5000) });
  if (output.type === 'icecast') {
    const res = await get('/status-json.xsl');
    if (!res.ok) throw new Error(`status page answered ${res.status}`);
    const json = JSON.parse((await res.text()).replace(/"title":\s*-,/g, '"title":null,')) as { icestats?: { source?: unknown } };
    const raw = json.icestats?.source;
    const sources = (Array.isArray(raw) ? raw : raw ? [raw] : []) as { listenurl?: string; listeners?: number; title?: string }[];
    const mine = c.mount ? sources.filter((s) => s.listenurl?.endsWith(c.mount!)) : sources;
    return { listeners: mine.reduce((n, s) => n + (s.listeners ?? 0), 0), live: mine.length > 0, title: mine[0]?.title };
  }
  if (output.type === 'shoutcast1') {
    const body = await (await get('/7.html')).text();
    const csv = body.replace(/<[^>]+>/g, '').split(',');
    return { listeners: Number(csv[0]) || 0, live: csv[1] === '1', title: csv.slice(6).join(',') || undefined };
  }
  const q = new URLSearchParams({ sid: String(c.streamId ?? 1), json: '1' });
  if (c.adminPassword) q.set('pass', ctx.box.decrypt(c.adminPassword));
  const res = await get(`/stats?${q}`);
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'enter the admin password to read listener counts' : `stats answered ${res.status}`);
  const s = (await res.json()) as { currentlisteners?: number; streamstatus?: number; songtitle?: string };
  return { listeners: s.currentlisteners ?? 0, live: s.streamstatus === 1, title: s.songtitle };
}
