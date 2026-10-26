import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { AGENT, ingestMount, mountStats, updateTitle, type IcecastSecrets } from './icecast.js';
import { log } from './log.js';
import type { AgentLive, AuthResult, IngestMountStatus, IngestOutput, IngestPlan, IngestStation, IngestTarget } from './protocol.js';
import { sourceConnection } from './relay.js';

export interface EncoderRequest {
  method: string;
  path: string;
  version: string;
  headers: Map<string, string>;
  rawHeaders: [string, string][];
  rest: Buffer;
}

interface Ctx {
  icecastPort: () => number;
  secrets: IcecastSecrets;
  nodeId: string;
  /** Asks the main server about an encoder log-in; null when it cannot be reached. */
  auth: (q: { stationId: string; mount: string; user: string | null; pass: string; ip: string; purpose: 'source' | 'metadata' }) => Promise<AuthResult | null>;
  /** Tells the main server about a broadcast (queued while it is unreachable). */
  live: (m: AgentLive) => void;
}

const CONTENT_TYPES: Record<string, string> = { mp3: 'audio/mpeg', aac: 'audio/aac', opus: 'audio/ogg', vorbis: 'audio/ogg' };

const codecArgs: Record<string, (kbps: number) => string[]> = {
  mp3: (k) => ['-c:a', 'libmp3lame', '-b:a', `${k}k`, '-ar', '44100', '-f', 'mp3'],
  aac: (k) => ['-c:a', 'aac', '-b:a', `${k}k`, '-ar', '44100', '-f', 'adts'],
  opus: (k) => ['-c:a', 'libopus', '-b:a', `${k}k`, '-ar', '48000', '-f', 'ogg'],
  vorbis: (k) => ['-c:a', 'libvorbis', '-b:a', `${k}k`, '-ar', '44100', '-f', 'ogg'],
};

function reply(socket: net.Socket, status: string, body = '', extra: string[] = []) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.0 ${status}\r\nServer: Hosted Radio Station node\r\nContent-Type: text/plain; charset=utf-8\r\n${extra.map((h) => `${h}\r\n`).join('')}Connection: close\r\n\r\n${body}`);
}

function basicAuth(h: string | undefined): { user: string; pass: string } | null {
  if (!h?.toLowerCase().startsWith('basic ')) return null;
  const raw = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  return i < 0 ? { user: '', pass: raw } : { user: raw.slice(0, i), pass: raw.slice(i + 1) };
}

function announcedBitrate(headers: Map<string, string>): number | null {
  const m = headers.get('ice-audio-info')?.match(/(?:^|;)\s*(?:ice-)?bitrate=(\d+)/i);
  const v = m?.[1] ?? headers.get('ice-bitrate') ?? headers.get('icy-br');
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Waits for the final HTTP status line of an answer (skipping "100 Continue"). */
function readStatus(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => done(new Error('no answer')), 10_000);
    const onData = (d: Buffer) => {
      text += d.toString('latin1');
      const code = [...text.matchAll(/HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/g)].map((m) => m[1]).find((c) => c !== '100');
      if (code) done(null, code);
      else if (text.length > 8192) done(new Error('answer too long'));
    };
    const onClose = () => done(new Error('closed'));
    function done(err: Error | null, code = '') {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      if (err) reject(err);
      else resolve(code);
    }
    socket.on('data', onData);
    socket.once('close', onClose);
  });
}

/** A job that runs again and again with a growing pause until it is stopped. */
abstract class Job {
  state: 'idle' | 'connecting' | 'connected' | 'error' = 'idle';
  message = '';
  private stopped = false;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  abstract readonly key: string;

  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.halt();
    this.state = 'idle';
  }

  private async loop() {
    if (this.stopped) return;
    this.state = 'connecting';
    const started = Date.now();
    try {
      await this.run();
      this.message = 'The stream ended';
    } catch (err) {
      this.message = (err as Error).message;
    }
    this.halt();
    if (this.stopped) return;
    this.state = 'error';
    this.failures = Date.now() - started > 60_000 ? 0 : this.failures + 1;
    // An ingest without a source is tried often, so the relays get it within seconds when the DJ starts.
    this.timer = setTimeout(() => void this.loop(), Math.min(10_000, 1000 * 2 ** Math.min(this.failures, 3)));
  }

  protected abstract run(): Promise<void>;
  protected abstract halt(): void;
}

/** Reads a mount of the node's own Icecast. */
function readLocal(port: number, path: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: { 'user-agent': `${AGENT} ingest` } }, (res) => {
      if (res.statusCode === 200) return resolve(res);
      res.resume();
      reject(new Error(res.statusCode === 404 ? 'Not on air' : `local Icecast answered ${res.statusCode}`));
    });
    req.on('error', (err) => reject(new Error(`local Icecast: ${err.message}`)));
  });
}

/**
 * Pushes one mount of the ingest straight to a relay node (or an external Icecast server): reads it from the node's
 * own Icecast and logs in on the other side like an Icecast source.
 */
class Pusher extends Job {
  readonly key: string;
  private sockets: { destroy(): void }[] = [];

  constructor(
    private readonly ctx: Ctx,
    readonly station: IngestStation,
    readonly mountPath: string,
    readonly to: { kind: 'relay'; target: IngestTarget; token: string } | { kind: 'output'; output: IngestOutput },
  ) {
    super();
    this.key = JSON.stringify([station.slug, station.priority, mountPath, to]);
  }

  /** The title playing now, sent once the push is up. */
  titleOf?: () => string | null | undefined;

  get relayId() {
    return this.to.kind === 'relay' ? this.to.target.nodeId : null;
  }

  private get remote() {
    if (this.to.kind === 'relay') {
      const t = this.to.target;
      return { host: t.host, port: t.port, tls: true, insecure: t.insecureTls, mount: `/listen/${this.station.slug}${this.mountPath}`, user: 'source', pass: this.to.token, priority: this.station.priority as number | null };
    }
    const o = this.to.output;
    return { host: o.host, port: o.port, tls: o.tls, insecure: false, mount: o.mount, user: o.username, pass: o.password, priority: null };
  }

  protected async run() {
    const local = await readLocal(this.ctx.icecastPort(), ingestMount(this.station.slug, this.mountPath));
    this.sockets.push(local);
    const r = this.remote;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const opts = { host: r.host, port: r.port, timeout: 10_000 };
      const s = r.tls ? tls.connect({ ...opts, servername: net.isIP(r.host) ? undefined : r.host, rejectUnauthorized: !r.insecure }) : net.connect(opts);
      this.sockets.push(s);
      s.once(r.tls ? 'secureConnect' : 'connect', () => {
        s.setTimeout(0);
        resolve(s);
      });
      s.once('error', (err) => reject(new Error(`${r.host}:${r.port}: ${(err as NodeJS.ErrnoException).code ?? err.message}`)));
      s.once('timeout', () => s.destroy(new Error('timeout')));
    });
    socket.setNoDelay(true);
    const m = this.station.mounts.find((x) => x.path === this.mountPath);
    const head = [
      `PUT ${r.mount} HTTP/1.1`,
      `Host: ${r.host}:${r.port}`,
      `Authorization: Basic ${Buffer.from(`${r.user}:${r.pass}`).toString('base64')}`,
      `User-Agent: ${AGENT} ${this.ctx.nodeId}`,
      `Content-Type: ${String(local.headers['content-type'] ?? CONTENT_TYPES[m?.format ?? 'mp3'])}`,
      `Ice-Name: ${(m?.name ? `${this.station.name} – ${m.name}` : this.station.name).replace(/[\r\n]/g, ' ')}`,
      'Ice-Public: 0',
      m ? `Ice-Audio-Info: bitrate=${m.bitrateKbps}` : '',
      r.priority !== null ? `X-Hrs-Priority: ${r.priority}` : '',
      'Expect: 100-continue',
    ].filter(Boolean);
    socket.write(`${head.join('\r\n')}\r\n\r\n`);
    const code = await readStatus(socket);
    if (code !== '200') throw new Error(code === '401' ? 'The relay refused the token' : code === '403' ? 'The mount is in use' : `The other side answered ${code}`);
    this.state = 'connected';
    this.message = '';
    setTimeout(() => {
      const t = this.titleOf?.();
      if (t) void this.title(t);
    }, 500);
    log.info('pushing', { mount: `${this.station.slug}${this.mountPath}`, to: this.to.kind === 'relay' ? this.to.target.name : r.host });
    await new Promise<void>((resolve, reject) => {
      local.pipe(socket);
      socket.on('data', () => undefined);
      local.once('end', () => resolve());
      local.once('error', reject);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('The other side closed the connection')));
    });
  }

  protected halt() {
    for (const s of this.sockets) s.destroy();
    this.sockets = [];
  }

  /** Sends a new title along (Icecast's /admin/metadata). */
  async title(song: string) {
    if (this.state !== 'connected') return;
    const r = this.remote;
    const q = new URLSearchParams({ mount: r.mount, mode: 'updinfo', song, charset: 'UTF-8' });
    const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`${r.user}:${r.pass}`).toString('base64')}`, 'user-agent': AGENT };
    if (r.priority !== null) headers['x-hrs-priority'] = String(r.priority);
    await new Promise<void>((resolve) => {
      const mod = r.tls ? https : http;
      const req = mod.get({ host: r.host, port: r.port, path: `/admin/metadata?${q}`, headers, timeout: 5000, rejectUnauthorized: !r.insecure, servername: r.tls && !net.isIP(r.host) ? r.host : undefined }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve());
    });
  }
}

/** Makes a converted mount on the ingest node with ffmpeg, from another mount of the same station. */
class Transcoder extends Job {
  readonly key: string;
  private child: ChildProcess | null = null;
  private socket: net.Socket | null = null;

  constructor(
    private readonly ctx: Ctx,
    readonly station: IngestStation,
    readonly mount: IngestStation['mounts'][number],
  ) {
    super();
    this.key = JSON.stringify([station.slug, mount]);
  }

  protected async run() {
    const port = this.ctx.icecastPort();
    // ffmpeg writes to a pipe and the agent logs in on Icecast, so the password never shows up in the process list.
    await readLocal(port, ingestMount(this.station.slug, this.mount.sourcePath!)).then((r) => r.destroy());
    const target = await sourceConnection(port, ingestMount(this.station.slug, this.mount.path), this.ctx.secrets.source, {
      'Content-Type': CONTENT_TYPES[this.mount.format] ?? 'audio/mpeg',
      'Ice-Name': this.mount.name ? `${this.station.name} – ${this.mount.name}` : this.station.name,
      'Ice-Public': '0',
      'Ice-Audio-Info': `bitrate=${this.mount.bitrateKbps}`,
    });
    this.socket = target;
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-user_agent', `${AGENT} transcoder`,
      '-i', `http://127.0.0.1:${port}${ingestMount(this.station.slug, this.mount.sourcePath!)}`,
      '-vn', '-map', '0:a:0', '-ac', '2', ...(codecArgs[this.mount.format] ?? codecArgs.mp3!)(this.mount.bitrateKbps), 'pipe:1',
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let stderr = '';
      child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
      child.stdout!.pipe(target);
      const up = setTimeout(() => (this.state = 'connected'), 4000);
      child.on('error', (err) => reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'ffmpeg is not installed' : err.message)));
      child.on('exit', (code) => {
        clearTimeout(up);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg stopped (${code})`));
      });
      target.once('close', () => child.kill('SIGTERM'));
    });
  }

  protected halt() {
    this.child?.kill('SIGTERM');
    this.child = null;
    this.socket?.destroy();
    this.socket = null;
  }
}

interface Broadcast {
  sessionId: string;
  stationId: string;
  mount: string;
  socket: net.Socket;
  bytesIn: number;
}

/**
 * The ingest role (phase 13): encoders of the stations routed to this node deliver here, the audio goes into the node's
 * own Icecast (/ingest/<station>/<mount>), converted mounts are made here, and every public mount is pushed straight to
 * the station's relays. The main server only checks log-ins and keeps the books; no audio goes through it.
 */
export class IngestManager {
  private plan: IngestPlan | null = null;
  private jobs = new Map<string, Job>();
  private broadcasts = new Map<string, Broadcast>();
  private titles = new Map<string, string | null>();
  private onAir: IngestMountStatus[] = [];
  /** Log-ins that worked lately, for when the main server cannot be reached (hash of the log-in → answer). */
  private recent = new Map<string, { at: number; r: AuthResult }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: Ctx) {}

  apply(plan: IngestPlan | null) {
    this.plan = plan?.stations.length ? plan : null;
    const wanted = new Map<string, Job>();
    for (const s of this.plan?.stations ?? []) {
      for (const m of s.mounts) {
        if (m.kind === 'transcode' && m.sourcePath) wanted.set(`t:${s.slug}${m.path}`, new Transcoder(this.ctx, s, m));
        if (!m.isPublic) continue;
        for (const t of s.targets) {
          const token = t.tokens[`${s.slug}${m.path}`];
          if (token) wanted.set(`p:${t.nodeId}:${s.slug}${m.path}`, new Pusher(this.ctx, s, m.path, { kind: 'relay', target: t, token }));
        }
      }
      for (const o of s.outputs) wanted.set(`o:${o.id}`, new Pusher(this.ctx, s, o.mountPath, { kind: 'output', output: o }));
    }
    for (const [id, job] of this.jobs) {
      const next = wanted.get(id);
      if (!next || next.key !== job.key) {
        job.stop();
        this.jobs.delete(id);
      }
    }
    for (const [id, job] of wanted) {
      if (this.jobs.has(id)) continue;
      if (job instanceof Pusher) job.titleOf = () => this.titles.get(ingestMount(job.station.slug, job.mountPath));
      this.jobs.set(id, job);
      job.start();
    }
    // Encoders of stations that are no longer routed here go off air.
    for (const b of [...this.broadcasts.values()]) if (!this.plan?.stations.some((s) => s.stationId === b.stationId)) b.socket.destroy();
    if (this.plan && !this.timer) this.timer = setInterval(() => void this.watch(), 3000);
    if (!this.plan && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.onAir = [];
    }
  }

  stop() {
    this.apply(null);
  }

  get encoders() {
    return this.broadcasts.size;
  }

  get needsFfmpeg() {
    return !!this.plan?.stations.some((s) => s.mounts.some((m) => m.kind === 'transcode'));
  }

  /** Mounts on air, for the stats to the main server. */
  status(): IngestMountStatus[] {
    return this.onAir;
  }

  /** Broadcasts on air, sent again after a reconnect. */
  sessionIds() {
    return [...this.broadcasts.keys()];
  }

  problems(): string[] {
    const bad = [...this.jobs.values()].filter((j) => j.state === 'error' && j.message && j.message !== 'Not on air');
    return bad.slice(0, 3).map((j) => j.message);
  }

  /** The station and mount an encoder means: "/<station>/<mount>", or "/<mount>" on a customer's own name. */
  resolve(path: string, host: string | null): { station: IngestStation; mount: IngestStation['mounts'][number] } | null {
    if (!this.plan) return null;
    const parts = path.split('?')[0]!.replace(/\/+$/, '').split('/').filter(Boolean);
    const source = (s: IngestStation | undefined, p: string) => {
      const mount = s?.mounts.find((m) => m.path === p && m.kind === 'source');
      return s && mount ? { station: s, mount } : null;
    };
    if (parts.length >= 2) {
      const hit = source(
        this.plan.stations.find((s) => s.slug === parts[0]),
        `/${parts.slice(1).join('/')}`,
      );
      if (hit) return hit;
    }
    const tenant = host ? this.plan.hosts[host.toLowerCase().replace(/:\d+$/, '')] : undefined;
    if (tenant && parts.length) {
      const hits = this.plan.stations.filter((s) => s.tenantId === tenant).map((s) => source(s, `/${parts.join('/')}`)).filter((x) => !!x);
      if (hits.length === 1) return hits[0]!;
    }
    return null;
  }

  /** Whether this node takes the encoder itself (else it is passed on to the main server as before). */
  takes(req: EncoderRequest, host: string | null) {
    if (!this.plan) return false;
    if (req.method === 'SOURCE' || req.method === 'PUT') return !!this.resolve(req.path, host);
    if (req.method === 'GET' && req.path.startsWith('/admin/metadata')) return !!this.resolve(new URL(req.path, 'http://x').searchParams.get('mount') ?? '', host);
    return false;
  }

  private async login(stationId: string, mount: string, user: string | null, pass: string, ip: string, purpose: 'source' | 'metadata'): Promise<AuthResult | { ok: false; message: string }> {
    const key = createHash('sha256').update(JSON.stringify([stationId, mount, user, pass])).digest('hex');
    const r = await this.ctx.auth({ stationId, mount, user, pass, ip, purpose });
    if (r) {
      if (r.ok) this.recent.set(key, { at: Date.now(), r });
      else this.recent.delete(key);
      return r;
    }
    // The main server is unreachable: a log-in that worked in the last 12 hours still works, so a DJ can reconnect.
    const known = this.recent.get(key);
    if (known && Date.now() - known.at < 12 * 3600_000) return known.r;
    return { ok: false, message: 'The log-in cannot be checked right now. Try again in a minute.' };
  }

  /** An encoder (SOURCE/PUT) or a title update for a station routed here. */
  async handle(socket: net.Socket, req: EncoderRequest, via: 'tls' | 'plain', ip: string, host: string | null) {
    if (req.method === 'GET') return this.metadata(socket, req, ip, host);
    const target = this.resolve(req.path, host)!;
    const creds = basicAuth(req.headers.get('authorization'));
    if (!creds) return reply(socket, '401 Unauthorized', 'Log-in required', ['WWW-Authenticate: Basic realm="Icecast2 Server"']);
    const r = await this.login(target.station.stationId, target.mount.path, creds.user || null, creds.pass, ip, 'source');
    if (!r.ok) {
      await new Promise((res) => setTimeout(res, 1000));
      return reply(socket, r.message?.startsWith('Invalid') ? '401 Unauthorized' : '403 Forbidden', r.message ?? 'Refused', ['WWW-Authenticate: Basic realm="Icecast2 Server"']);
    }
    const auth = r as AuthResult;
    const bitrate = announcedBitrate(req.headers);
    if (bitrate && auth.limitKbps && bitrate > auth.limitKbps) return reply(socket, '403 Forbidden', `Bitrate ${bitrate} kbps is above the limit of ${auth.limitKbps} kbps for this mount.`);
    const port = this.ctx.icecastPort();
    const upstream = net.connect({ host: '127.0.0.1', port });
    upstream.setNoDelay(true);
    let b: Broadcast | null = null;
    let finished = false;
    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      upstream.destroy();
      if (!b) return;
      this.broadcasts.delete(b.sessionId);
      this.ctx.live({ t: 'live', action: 'end', sessionId: b.sessionId, stationId: b.stationId, mount: b.mount, bytesIn: b.bytesIn, reason });
      log.info('encoder disconnected', { mount: `${target.station.slug}${target.mount.path}`, account: auth.accountName });
    };
    socket.on('close', () => finish('disconnected'));
    upstream.on('close', () => finish('disconnected'));
    upstream.on('error', () => {
      if (!b) reply(socket, '503 Service Unavailable', 'The ingest is not ready right now. Try again in a minute.');
      finish('error');
    });
    upstream.once('connect', () => {
      const keep = req.rawHeaders.filter(([k]) => !['authorization', 'host', 'x-forwarded-for'].includes(k.toLowerCase()));
      const head = [
        `${req.method} ${ingestMount(target.station.slug, target.mount.path)} ${req.version}`,
        `Host: 127.0.0.1:${port}`,
        `Authorization: Basic ${Buffer.from(`source:${this.ctx.secrets.source}`).toString('base64')}`,
        ...keep.map(([k, v]) => `${k}: ${v}`),
      ];
      upstream.write(`${head.join('\r\n')}\r\n\r\n`);
      let bytes = req.rest.length;
      if (req.rest.length) upstream.write(req.rest);
      let answer = Buffer.alloc(0);
      const onAnswer = (chunk: Buffer) => {
        answer = Buffer.concat([answer, chunk]);
        const statuses = [...answer.toString('latin1').matchAll(/HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/g)];
        const final = statuses.find((x) => x[1] !== '100');
        if (!final && answer.length < 8192) return;
        upstream.off('data', onAnswer);
        socket.write(answer);
        upstream.pipe(socket);
        if (final?.[1] !== '200') return;
        b = { sessionId: randomUUID(), stationId: target.station.stationId, mount: target.mount.path, socket, bytesIn: bytes };
        this.broadcasts.set(b.sessionId, b);
        this.ctx.live({
          t: 'live',
          action: 'start',
          sessionId: b.sessionId,
          stationId: b.stationId,
          mount: b.mount,
          accountId: auth.accountId ?? null,
          accountName: auth.accountName,
          via,
          ip,
          userAgent: req.headers.get('user-agent') ?? null,
          bitrateKbps: bitrate,
          startedAt: new Date().toISOString(),
        });
        log.info('encoder on air', { mount: `${target.station.slug}${target.mount.path}`, account: auth.accountName, via, ip });
      };
      upstream.on('data', onAnswer);
      socket.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (b) b.bytesIn = bytes;
        if (!upstream.write(chunk)) socket.pause();
      });
      upstream.on('drain', () => socket.resume());
      socket.resume();
    });
  }

  /** Title updates from encoders: GET /admin/metadata?mount=…&song=… with the DJ's log-in. */
  private async metadata(socket: net.Socket, req: EncoderRequest, ip: string, host: string | null) {
    const url = new URL(req.path, 'http://x');
    const target = this.resolve(url.searchParams.get('mount') ?? '', host);
    const creds = basicAuth(req.headers.get('authorization'));
    if (!target || !creds) return reply(socket, '401 Unauthorized', 'Log-in required');
    const r = await this.login(target.station.stationId, target.mount.path, creds.user || null, creds.pass, ip, 'metadata');
    if (!r.ok) return reply(socket, '401 Unauthorized', r.message ?? 'Refused');
    const song = url.searchParams.get('song') ?? '';
    await updateTitle(this.ctx.icecastPort(), this.ctx.secrets.admin, ingestMount(target.station.slug, target.mount.path), song).catch(() => undefined);
    if (!socket.destroyed) socket.end('HTTP/1.0 200 OK\r\nContent-Type: text/xml\r\nConnection: close\r\n\r\n<?xml version="1.0"?>\n<iceresponse><message>Metadata update successful</message><return>1</return></iceresponse>\n');
  }

  /**
   * Every few seconds: which mounts are on air and their titles. New titles go to the converted mounts here and to the
   * relays and external servers (their streams carry no titles of their own).
   */
  private async watch() {
    if (!this.plan) return;
    let stats: Awaited<ReturnType<typeof mountStats>>;
    try {
      stats = await mountStats(this.ctx.icecastPort(), this.ctx.secrets.admin);
    } catch {
      return;
    }
    const by = new Map(stats.map((s) => [s.mount, s]));
    const onAir: IngestMountStatus[] = [];
    for (const s of this.plan.stations) {
      for (const m of s.mounts) {
        const name = ingestMount(s.slug, m.path);
        const st = by.get(name);
        if (!st) {
          this.titles.delete(name);
          continue;
        }
        // The title of a converted mount is the one of its source.
        const title = m.kind === 'transcode' && m.sourcePath ? (by.get(ingestMount(s.slug, m.sourcePath))?.title ?? st.title) : st.title;
        const pushing = [...this.jobs.values()].filter((j): j is Pusher => j instanceof Pusher && j.station.stationId === s.stationId && j.mountPath === m.path && j.state === 'connected' && !!j.relayId).map((j) => j.relayId!);
        onAir.push({ stationId: s.stationId, mount: m.path, title: title || null, bitrateKbps: st.bitrateKbps, contentType: st.contentType, pushing });
        if (!title || this.titles.get(name) === title) continue;
        this.titles.set(name, title);
        if (m.kind === 'transcode') await updateTitle(this.ctx.icecastPort(), this.ctx.secrets.admin, name, title).catch(() => undefined);
        for (const j of this.jobs.values()) if (j instanceof Pusher && j.station.stationId === s.stationId && j.mountPath === m.path) void j.title(title);
      }
    }
    this.onAir = onAir;
  }
}
