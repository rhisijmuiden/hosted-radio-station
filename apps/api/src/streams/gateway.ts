import { readdir, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { authenticateSource, type Account, type OutsideShow } from '../services/streaming/sources.js';
import type { LiveBroadcast } from './recorder.js';
import { PREAMBLE_PREFIX, verifyPreamble } from '../services/nodes/preamble.js';
import { serves } from '../services/nodes/dedication.js';
import { resolveMount, type Snapshot, type StationView } from './snapshot.js';

type SourceNode = Snapshot['sourceNodes'] extends Map<string, infer N> ? N : never;

const HEADER_LIMIT = 16 * 1024;
const HEADER_TIMEOUT = 15_000;

type Via = 'tls' | 'plain' | 'shoutcast';

interface Head {
  method: string;
  path: string;
  version: string;
  headers: Map<string, string>;
  rawHeaders: [string, string][];
  rest: Buffer;
}

export interface PortState {
  port: number;
  ok: boolean;
  error?: string;
}

/** Reads bytes until the end of the HTTP header (or the first line, for Shoutcast). */
function readUntil(socket: net.Socket, marker: string): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('header timeout')), HEADER_TIMEOUT);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const i = buf.indexOf(marker);
      if (i >= 0) return done(null, i);
      if (buf.length > HEADER_LIMIT) done(new Error('header too large'));
    };
    const onEnd = () => done(new Error('closed'));
    function done(err: Error | null, i = 0) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onEnd);
      socket.pause();
      if (err) reject(err);
      else resolve({ head: buf.subarray(0, i).toString('latin1'), rest: buf.subarray(i + marker.length) });
    }
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onEnd);
    socket.resume();
  });
}

function parseHead(head: string, rest: Buffer): Head | null {
  const lines = head.split(/\r?\n/);
  const m = lines[0]!.match(/^([A-Z]+) (\S+) (HTTP\/1\.[01])$/);
  if (!m) return null;
  const headers = new Map<string, string>();
  const rawHeaders: [string, string][] = [];
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    rawHeaders.push([k, v]);
    headers.set(k.toLowerCase(), v);
  }
  return { method: m[1]!, path: m[2]!, version: m[3]!, headers, rawHeaders, rest };
}

function basicAuth(h: string | undefined): { user: string; pass: string } | null {
  if (!h?.toLowerCase().startsWith('basic ')) return null;
  const raw = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  return i < 0 ? { user: '', pass: raw } : { user: raw.slice(0, i), pass: raw.slice(i + 1) };
}

/** The bitrate an encoder says it sends, in kbps. */
function announcedBitrate(headers: Map<string, string>): number | null {
  const info = headers.get('ice-audio-info');
  const m = info?.match(/(?:^|;)\s*(?:ice-)?bitrate=(\d+)/i);
  const v = m?.[1] ?? headers.get('ice-bitrate') ?? headers.get('icy-br');
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function reply(socket: net.Socket, status: string, body = '', extra: string[] = []) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.0 ${status}\r\nServer: Hosted Radio Station\r\nContent-Type: text/plain; charset=utf-8\r\n${extra.map((h) => `${h}\r\n`).join('')}Connection: close\r\n\r\n${body}`);
}

const auth64 = (user: string, pass: string) => Buffer.from(`${user}:${pass}`).toString('base64');

/** Slows down password guessing: after 10 failures in 10 minutes an address is refused for 15 minutes. */
class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  blocked(ip: string) {
    const now = Date.now();
    const list = (this.failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    this.failures.set(ip, list);
    return list.filter((t) => now - t < 10 * 60_000).length >= 10;
  }
  fail(ip: string) {
    this.failures.set(ip, [...(this.failures.get(ip) ?? []), Date.now()]);
  }
}

/**
 * The ingest gateway: every encoder connects here, never to Icecast directly. It checks the DJ account, the mount and
 * the bitrate, logs the broadcast, and forwards the stream to the station's Icecast server on 127.0.0.1 with the
 * internal password. It speaks the Icecast protocol (SOURCE/PUT, with or without TLS) and legacy Shoutcast v1.
 */
export class IngestGateway {
  private snap: Snapshot | null = null;
  private servers = new Map<string, { server: net.Server; port: number; state: PortState; stationId?: string }>();
  private secure = new Map<string, tls.SecureContext>();
  private certStamp = '';
  private readonly limiter = new FailureLimiter();
  private readonly active = new Set<net.Socket>();
  /** Encoders on air right now. */
  liveCount = 0;
  /** Broadcasts on air, by live session id (for recordings and now playing). */
  readonly broadcasts = new Map<string, LiveBroadcast>();
  /** Called when a broadcast starts or ends. */
  onBroadcast?: (b: LiveBroadcast, on: boolean) => void;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
  ) {}

  get certificateHosts() {
    return [...this.secure.keys()].sort();
  }

  portStates() {
    const tlsS = this.servers.get('tls')?.state ?? null;
    const plain = this.servers.get('plain')?.state ?? null;
    const legacy = [...this.servers.entries()]
      .filter(([k]) => k.startsWith('legacy:'))
      .map(([, v]) => ({ ...v.state, station: this.snap?.stations.get(v.stationId!)?.station.slug ?? '' }));
    return { tls: tlsS, plain, legacy };
  }

  /** Applies a new snapshot: (re)binds listening ports that changed and keeps running connections. */
  async configure(snap: Snapshot) {
    this.snap = snap;
    await this.loadCertificates();
    const wanted = new Map<string, { port: number; kind: 'tls' | 'plain' | 'legacy'; stationId?: string }>();
    // Orchestrator only (phase 18): no encoder port is open on this server at all.
    if (this.secure.has('default') && !snap.orchestratorOnly) wanted.set('tls', { port: snap.streaming.ingestTlsPort, kind: 'tls' });
    else this.servers.get('tls')?.server.close();
    if (snap.streaming.ingestPlainPort && !snap.orchestratorOnly) wanted.set('plain', { port: snap.streaming.ingestPlainPort, kind: 'plain' });
    for (const v of snap.stations.values()) {
      if (!v.active || v.onNode || !v.ingest.local || !v.station.legacyPort) continue;
      wanted.set(`legacy:${v.station.id}:0`, { port: v.station.legacyPort, kind: 'legacy', stationId: v.station.id });
      wanted.set(`legacy:${v.station.id}:1`, { port: v.station.legacyPort + 1, kind: 'legacy', stationId: v.station.id });
    }
    for (const [key, cur] of this.servers) {
      const want = wanted.get(key);
      if (!want || want.port !== cur.port) {
        cur.server.close();
        this.servers.delete(key);
      }
    }
    if (!this.secure.has('default') || snap.orchestratorOnly) this.servers.delete('tls');
    for (const [key, want] of wanted) {
      if (this.servers.has(key)) continue;
      const handler = (socket: net.Socket) => void this.handle(socket, want.kind === 'tls' ? 'tls' : want.kind === 'plain' ? 'plain' : 'shoutcast', want.stationId);
      const server =
        want.kind === 'tls'
          ? tls.createServer({ SNICallback: (name, cb) => cb(null, this.contextFor(name)), ...this.defaultCert() }, handler)
          : net.createServer(handler);
      const state: PortState = { port: want.port, ok: false };
      this.servers.set(key, { server, port: want.port, state, stationId: want.stationId });
      server.on('error', (err) => {
        state.ok = false;
        state.error = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${want.port} is already in use` : err.message;
        this.log.error({ err, port: want.port }, 'ingest port failed');
        // Try again on the next snapshot.
        if (this.servers.get(key)?.server === server) this.servers.delete(key);
      });
      if (want.kind === 'tls') (server as tls.Server).on('tlsClientError', () => undefined);
      server.listen(want.port, () => {
        state.ok = true;
        delete state.error;
        this.log.info({ port: want.port, kind: want.kind }, 'ingest listening');
      });
    }
  }

  async close() {
    for (const { server } of this.servers.values()) server.close();
    this.servers.clear();
    for (const s of this.active) s.destroy();
  }

  // Certificates: copied from the web server by the system helper into DATA_DIR/certs/<host>.crt|key.

  private defaultCert() {
    const d = this.secureRaw.get('default');
    return d ? { cert: d.cert, key: d.key } : {};
  }
  private secureRaw = new Map<string, { cert: Buffer; key: Buffer }>();

  private contextFor(name: string) {
    return this.secure.get(name.toLowerCase()) ?? this.secure.get('default');
  }

  private async loadCertificates() {
    const dir = join(this.ctx.config.DATA_DIR, 'certs');
    const files = await readdir(dir).catch(() => [] as string[]);
    const hosts = files.filter((f) => f.endsWith('.crt')).map((f) => f.slice(0, -4));
    const stamps = await Promise.all(hosts.map(async (h) => `${h}:${(await stat(join(dir, `${h}.crt`)).catch(() => null))?.mtimeMs ?? 0}`));
    const stamp = stamps.join(',');
    if (stamp === this.certStamp) return;
    const secure = new Map<string, tls.SecureContext>();
    const raw = new Map<string, { cert: Buffer; key: Buffer }>();
    for (const h of hosts) {
      try {
        const cert = await readFile(join(dir, `${h}.crt`));
        const key = await readFile(join(dir, `${h}.key`));
        secure.set(h, tls.createSecureContext({ cert, key }));
        raw.set(h, { cert, key });
      } catch (err) {
        this.log.warn({ err, host: h }, 'certificate could not be loaded');
      }
    }
    this.secure = secure;
    this.secureRaw = raw;
    this.certStamp = stamp;
    // A running TLS server picks up the new default certificate for clients without SNI.
    const d = raw.get('default');
    const t = this.servers.get('tls')?.server as tls.Server | undefined;
    if (d && t) t.setSecureContext({ cert: d.cert, key: d.key });
  }

  // Connections

  private async handle(socket: net.Socket, via: Via, legacyStationId?: string) {
    this.active.add(socket);
    socket.on('close', () => this.active.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setNoDelay(true);
    let ip = (socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    try {
      if (this.limiter.blocked(ip)) return reply(socket, '403 Forbidden', 'Too many failed log-ins. Try again later.');
      if (via === 'shoutcast') return await this.handleLegacy(socket, ip, legacyStationId!);
      let { head, rest } = await readUntil(socket, '\r\n\r\n');
      // A source node in front: its signed first line carries the encoder's real address.
      let node: SourceNode | null = null;
      let sni = via === 'tls' ? (socket as tls.TLSSocket).servername || null : null;
      if (head.startsWith(PREAMBLE_PREFIX)) {
        const nl = head.indexOf('\n');
        const pre = verifyPreamble(head.slice(0, nl < 0 ? head.length : nl), (id) => this.snap?.sourceNodes.get(id)?.secret ?? null);
        if (!pre) {
          this.limiter.fail(ip);
          return reply(socket, '403 Forbidden', 'Unknown node');
        }
        node = this.snap!.sourceNodes.get(pre.nodeId)!;
        head = nl < 0 ? '' : head.slice(nl + 1);
        if (!head) ({ head, rest } = await readUntil(socket, '\r\n\r\n'));
        ip = pre.ip;
        via = pre.via;
        sni = pre.host;
        if (this.limiter.blocked(ip)) return reply(socket, '403 Forbidden', 'Too many failed log-ins. Try again later.');
      }
      const req = parseHead(head, rest);
      if (!req) return reply(socket, '400 Bad Request', 'Not an Icecast source request');
      const host = sni || req.headers.get('host')?.replace(/:\d+$/, '') || null;
      await this.handleHttp(socket, req, via, ip, host, null, node);
    } catch (err) {
      if ((err as Error).message !== 'closed') this.log.debug({ err, ip }, 'ingest connection failed');
      socket.destroy();
    }
  }

  private async handleHttp(socket: net.Socket, req: Head, via: Via, ip: string, host: string | null, fixed: StationView | null, node: SourceNode | null = null) {
    const snap = this.snap!;
    if (req.method === 'SOURCE' || req.method === 'PUT') {
      // Every refused encoder is logged with its reason: the encoder may not show it (journalctl -u hosted-radio-streams).
      const deny = (status: string, body: string, extra: string[] = []) => {
        this.log.info({ ip, host, path: req.path, via, status, reason: body }, 'encoder refused');
        return deny(status, body, extra);
      };
      const target = fixed ? this.legacyTarget(fixed, req.path) : resolveMount(snap, host, req.path);
      if (!target) {
        // A station whose encoders go to an ingest node (phase 13).
        const elsewhere = snap.bySlug.get(req.path.split('/').filter(Boolean)[0] ?? '');
        if (elsewhere?.active && !elsewhere.ingest.local) return deny('403 Forbidden', 'This station takes encoders on its ingest node. See the connection details in the panel.');
        return deny('404 Not Found', `Unknown mount ${req.path}. Use /<station>/<mount>, for example /my-station/live.`);
      }
      // A dedicated node (a customer's own, or one set to one customer or station) only delivers to those stations.
      if (node && !serves(node, { id: target.view.station.id, tenantId: target.view.tenantId })) return deny('403 Forbidden', 'This node cannot deliver to this station.');
      const creds = basicAuth(req.headers.get('authorization'));
      if (!creds) return deny('401 Unauthorized', 'Log-in required', ['WWW-Authenticate: Basic realm="Icecast2 Server"']);
      let outside: OutsideShow | null = null;
      const account = await authenticateSource(this.ctx, target.view.station.id, target.mount.id, creds.user, creds.pass, (refusal, who) => {
        outside = refusal;
        this.log.info({ station: target.view.station.slug, account: who.username, opensAt: refusal.opensAt && new Date(refusal.opensAt).toISOString() }, 'DJ refused outside their show');
      });
      if (!account && outside) {
        const { opensAt, timezone } = outside as OutsideShow;
        const when = opensAt && new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(opensAt);
        return deny('403 Forbidden', when ? `You can only broadcast during your show. You can connect from ${when} (${timezone}).` : 'You can only broadcast during your show.');
      }
      if (!account) {
        this.log.info({ ip, host, path: req.path, via, station: target.view.station.slug, user: creds.user }, 'encoder refused: wrong user name or password');
        return this.refuse(socket, ip);
      }
      const bitrate = announcedBitrate(req.headers);
      const limit = Math.min(target.mount.bitrateKbps, target.view.maxBitrateKbps);
      if (bitrate && bitrate > limit) return deny('403 Forbidden', `Bitrate ${bitrate} kbps is above the limit of ${limit} kbps for this mount.`);
      const headers = req.rawHeaders.filter(([k]) => !['authorization', 'host', 'x-forwarded-for'].includes(k.toLowerCase()));
      return this.forwardSource(socket, { view: target.view, mountPath: target.mount.path, mountId: target.mount.id }, account, {
        method: req.method,
        version: req.version,
        headers,
        rest: req.rest,
        via,
        ip,
        bitrate,
        userAgent: req.headers.get('user-agent') ?? null,
        nodeId: node?.id ?? null,
      });
    }
    if (req.method === 'GET' && /^\/admin\/metadata(\.xsl)?(\?|$)/.test(req.path)) return this.metadata(socket, req, ip, host, fixed);
    if (req.method === 'GET' && fixed && req.path.startsWith('/admin.cgi')) return this.legacyMetadata(socket, req, ip, fixed);
    if (req.method === 'GET' && fixed) return this.legacyListener(socket, req, ip, fixed);
    if (req.method === 'GET') return reply(socket, '200 OK', 'Hosted Radio Station source ingest. Point your encoder here.\n');
    return reply(socket, '405 Method Not Allowed', 'Use SOURCE or PUT');
  }

  private legacyTarget(view: StationView, path: string) {
    const clean = path.split('?')[0]!;
    const mount =
      view.mounts.find((m) => m.path === clean && m.kind === 'source') ??
      view.mounts.find((m) => m.id === view.station.legacyMountId) ??
      view.mounts.find((m) => m.kind === 'source');
    return mount && view.active && !view.onNode && view.ingest.local ? { view, mount } : null;
  }

  private async refuse(socket: net.Socket, ip: string) {
    this.limiter.fail(ip);
    await new Promise((r) => setTimeout(r, 1000));
    reply(socket, '401 Unauthorized', 'Invalid user name or password', ['WWW-Authenticate: Basic realm="Icecast2 Server"']);
  }

  /** Connects to the station's Icecast server and passes the stream through, keeping track of the broadcast. */
  private forwardSource(
    client: net.Socket,
    target: { view: StationView; mountPath: string; mountId: string },
    account: Account,
    req: { method: string; version: string; headers: [string, string][]; rest: Buffer; via: Via; ip: string; bitrate: number | null; userAgent: string | null; nodeId: string | null },
  ) {
    const { station } = target.view;
    const upstream = net.connect({ host: '127.0.0.1', port: station.icecastPort });
    upstream.setNoDelay(true);
    let sessionId: string | null = null;
    let bytesIn = 0;
    let finished = false;
    const finish = async (reason: string) => {
      if (finished) return;
      finished = true;
      client.destroy();
      upstream.destroy();
      if (!sessionId) return;
      this.liveCount--;
      const b = this.broadcasts.get(sessionId);
      this.broadcasts.delete(sessionId);
      if (b) this.onBroadcast?.(b, false);
      await this.ctx.db
        .update(schema.liveSessions)
        .set({ endedAt: new Date(), bytesIn, endReason: sql`coalesce(${schema.liveSessions.endReason}, ${reason})` })
        .where(eq(schema.liveSessions.id, sessionId))
        .catch((err) => this.log.error({ err }, 'ending live session failed'));
      this.log.info({ station: station.slug, mount: target.mountPath, account: account.username, bytesIn }, 'encoder disconnected');
    };
    client.on('close', () => void finish('disconnected'));
    upstream.on('close', () => void finish('disconnected'));
    upstream.on('error', () => {
      if (!sessionId) reply(client, '503 Service Unavailable', 'The station is not running right now. Try again in a minute.');
      void finish('error');
    });

    upstream.once('connect', () => {
      const head = [
        `${req.method} ${target.mountPath} ${req.version}`,
        `Host: 127.0.0.1:${station.icecastPort}`,
        `Authorization: Basic ${auth64('source', target.view.sourcePassword)}`,
        `X-Forwarded-For: ${req.ip}`,
        ...req.headers.map(([k, v]) => `${k}: ${v}`),
      ].join('\r\n');
      upstream.write(`${head}\r\n\r\n`);
      if (req.rest.length) {
        bytesIn += req.rest.length;
        upstream.write(req.rest);
      }
      // Wait for Icecast's verdict (skipping "100 Continue") before counting it as a broadcast.
      let answer = Buffer.alloc(0);
      const onAnswer = (chunk: Buffer) => {
        answer = Buffer.concat([answer, chunk]);
        const text = answer.toString('latin1');
        const statuses = [...text.matchAll(/HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/g)];
        const final = statuses.find((s) => s[1] !== '100');
        if (!final && answer.length < 8192) return;
        upstream.off('data', onAnswer);
        client.write(answer);
        upstream.pipe(client);
        if (final?.[1] === '200') void this.startSession(target, account, req).then((id) => {
            sessionId = id;
            // The encoder left while the broadcast was being logged.
            if (finished) {
              finished = false;
              void finish('disconnected');
            }
          });
      };
      upstream.on('data', onAnswer);
      client.on('data', (chunk: Buffer) => {
        bytesIn += chunk.length;
        if (!upstream.write(chunk)) client.pause();
      });
      upstream.on('drain', () => client.resume());
      client.resume();
    });
  }

  private async startSession(
    target: { view: StationView; mountPath: string; mountId: string },
    account: Account,
    req: { via: Via; ip: string; bitrate: number | null; userAgent: string | null; nodeId: string | null },
  ) {
    this.liveCount++;
    const [row] = await this.ctx.db
      .insert(schema.liveSessions)
      .values({
        stationId: target.view.station.id,
        mountId: target.mountId,
        mountPath: target.mountPath,
        accountId: account.id,
        accountName: account.displayName || account.username,
        via: req.via,
        ip: req.ip,
        userAgent: req.userAgent?.slice(0, 200) ?? null,
        bitrateKbps: req.bitrate,
        nodeId: req.nodeId,
      })
      .returning({ id: schema.liveSessions.id, startedAt: schema.liveSessions.startedAt });
    const b: LiveBroadcast = { sessionId: row!.id, stationId: target.view.station.id, mountPath: target.mountPath, accountName: account.displayName || account.username, startedAt: row!.startedAt };
    this.broadcasts.set(b.sessionId, b);
    this.onBroadcast?.(b, true);
    await this.ctx.db.update(schema.stationAccounts).set({ lastUsedAt: new Date() }).where(eq(schema.stationAccounts.id, account.id));
    this.log.info({ station: target.view.station.slug, mount: target.mountPath, account: account.username, via: req.via, ip: req.ip }, 'encoder on air');
    return row!.id;
  }

  /** Title updates from Icecast encoders: GET /admin/metadata?mount=…&mode=updinfo&song=… with the DJ's log-in. */
  private async metadata(socket: net.Socket, req: Head, ip: string, host: string | null, fixed: StationView | null) {
    const url = new URL(req.path, 'http://x');
    const mountParam = url.searchParams.get('mount') ?? '';
    const target = fixed ? this.legacyTarget(fixed, mountParam) : resolveMount(this.snap!, host, mountParam);
    if (!target) return reply(socket, '404 Not Found', 'Unknown mount');
    const creds = basicAuth(req.headers.get('authorization'));
    const account = creds && (await authenticateSource(this.ctx, target.view.station.id, target.mount.id, creds.user, creds.pass));
    if (!account) return this.refuse(socket, ip);
    url.searchParams.set('mount', target.mount.path);
    if (!url.searchParams.get('mode')) url.searchParams.set('mode', 'updinfo');
    await this.sendMetadata(socket, target.view, url.searchParams);
  }

  private async sendMetadata(socket: net.Socket, view: StationView, params: URLSearchParams) {
    try {
      const res = await fetch(`http://127.0.0.1:${view.station.icecastPort}/admin/metadata?${params}`, {
        headers: { authorization: `Basic ${auth64('source', view.sourcePassword)}` },
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.text();
      if (socket.destroyed) return;
      socket.end(`HTTP/1.0 ${res.status} ${res.statusText}\r\nContent-Type: text/xml\r\nConnection: close\r\n\r\n${body}`);
    } catch {
      reply(socket, '503 Service Unavailable', 'The station is not running right now.');
    }
  }

  // Legacy Shoutcast v1: the encoder sends "password\r\n", gets "OK2", sends icy-* headers and then audio.

  private async handleLegacy(socket: net.Socket, ip: string, stationId: string) {
    const view = this.snap!.stations.get(stationId);
    if (!view?.active || view.onNode) return socket.destroy();
    const first = await readUntil(socket, '\n');
    const line = first.head.replace(/\r$/, '');
    if (/^[A-Z]+ \S+ HTTP\/1\.[01]$/.test(line)) {
      // An HTTP request on the legacy port: a title update, a listener or an Icecast-style encoder.
      let headText: string;
      let rest: Buffer;
      const buf = first.rest;
      const i = buf.indexOf('\r\n\r\n');
      if (buf.subarray(0, 2).toString('latin1') === '\r\n') {
        headText = '';
        rest = buf.subarray(2);
      } else if (i >= 0) {
        headText = buf.subarray(0, i).toString('latin1');
        rest = buf.subarray(i + 4);
      } else {
        socket.unshift(buf);
        ({ head: headText, rest } = await readUntil(socket, '\r\n\r\n'));
      }
      const req = parseHead(`${line}\r\n${headText}`, rest);
      if (!req) return reply(socket, '400 Bad Request');
      return this.handleHttp(socket, req, 'shoutcast', ip, null, view);
    }
    const target = this.legacyTarget(view, '');
    if (!target) return socket.end('invalid password\r\n');
    const account = await authenticateSource(this.ctx, view.station.id, target.mount.id, null, line);
    if (!account) {
      this.limiter.fail(ip);
      await new Promise((r) => setTimeout(r, 1000));
      return socket.end('invalid password\r\n');
    }
    socket.write('OK2\r\nicy-caps:11\r\n\r\n');
    socket.unshift(first.rest);
    const icy = await readUntil(socket, '\r\n\r\n').catch(() => ({ head: '', rest: Buffer.alloc(0) }));
    const icyHeaders = new Map<string, string>();
    for (const l of icy.head.split(/\r?\n/)) {
      const i = l.indexOf(':');
      if (i > 0) icyHeaders.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
    }
    const bitrate = announcedBitrate(icyHeaders);
    const limit = Math.min(target.mount.bitrateKbps, view.maxBitrateKbps);
    if (bitrate && bitrate > limit) return socket.end(`bitrate ${bitrate} above limit ${limit}\r\n`);
    const headers: [string, string][] = [['Content-Type', icyHeaders.get('content-type') ?? 'audio/mpeg']];
    const map: Record<string, string> = { 'icy-name': 'ice-name', 'icy-genre': 'ice-genre', 'icy-url': 'ice-url', 'icy-pub': 'ice-public', 'icy-description': 'ice-description' };
    for (const [k, v] of Object.entries(map)) if (icyHeaders.get(k)) headers.push([v, icyHeaders.get(k)!]);
    if (bitrate) headers.push(['ice-audio-info', `bitrate=${bitrate}`]);
    this.forwardSource(socket, { view, mountPath: target.mount.path, mountId: target.mount.id }, account, {
      method: 'SOURCE',
      version: 'HTTP/1.0',
      headers,
      rest: icy.rest,
      via: 'shoutcast',
      ip,
      bitrate,
      nodeId: null,
      userAgent: icyHeaders.get('user-agent') ?? 'Shoutcast v1 encoder',
    });
  }

  /** Shoutcast title updates: GET /admin.cgi?pass=…&mode=updinfo&song=… */
  private async legacyMetadata(socket: net.Socket, req: Head, ip: string, view: StationView) {
    const url = new URL(req.path, 'http://x');
    const target = this.legacyTarget(view, '');
    const creds = basicAuth(req.headers.get('authorization'));
    const pass = url.searchParams.get('pass') ?? creds?.pass ?? '';
    const account = target && (await authenticateSource(this.ctx, view.station.id, target.mount.id, creds?.user ?? null, pass));
    if (!target || !account) return this.refuse(socket, ip);
    const params = new URLSearchParams({ mount: target.mount.path, mode: 'updinfo', song: url.searchParams.get('song') ?? '' });
    // Shoutcast encoders send Latin-1 unless they say otherwise.
    params.set('charset', url.searchParams.get('charset') ?? 'ISO-8859-1');
    await this.sendMetadata(socket, view, params);
  }

  /** Old players that only know the Shoutcast address (http://host:port/ or /;) hear the legacy mount. */
  private legacyListener(socket: net.Socket, req: Head, ip: string, view: StationView) {
    const target = this.legacyTarget(view, req.path === '/;' || req.path === '/' ? '' : req.path);
    if (!target) return reply(socket, '404 Not Found');
    const upstream = net.connect({ host: '127.0.0.1', port: view.station.icecastPort }, () => {
      const keep = req.rawHeaders.filter(([k]) => ['user-agent', 'icy-metadata', 'accept', 'referer'].includes(k.toLowerCase()));
      upstream.write(
        [`GET ${target.mount.path} HTTP/1.0`, `Host: 127.0.0.1:${view.station.icecastPort}`, `X-Hrs-Client: ${ip}`, 'X-Hrs-Via: legacy', ...keep.map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n',
      );
      upstream.pipe(socket);
      socket.pipe(upstream);
      socket.resume();
    });
    upstream.on('error', () => reply(socket, '503 Service Unavailable'));
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  }
}
