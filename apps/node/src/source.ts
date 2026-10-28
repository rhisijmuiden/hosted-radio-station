import { createHmac } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { dataPath } from './config.js';
import { log } from './log.js';
import type { EncoderRequest, IngestManager } from './ingest.js';
import type { NodePlan } from './protocol.js';

type SourcePlan = NonNullable<NodePlan['source']>;

/**
 * The first line the node puts in front of every encoder connection it passes on, signed with its secret, so the main
 * server knows the encoder's real address. Same format as apps/api/src/services/nodes/preamble.ts.
 */
export function signPreamble(secret: string, p: { nodeId: string; via: 'tls' | 'plain'; ip: string; host: string | null }, now = Date.now()) {
  const ts = Math.floor(now / 1000);
  const host = p.host || '-';
  const sig = createHmac('sha256', secret).update(`1|${p.nodeId}|${ts}|${p.via}|${p.ip}|${host}`).digest('hex');
  return `HRSNODE 1 ${p.nodeId} ${ts} ${p.via} ${p.ip} ${host} ${sig}\r\n`;
}

const HEADER_LIMIT = 16 * 1024;

/** Reads an encoder's request head (up to the empty line). */
function readHead(socket: net.Socket): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('header timeout')), 15_000);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0) return done(null, i);
      if (buf.length > HEADER_LIMIT) done(new Error('header too large'));
    };
    const onEnd = () => done(new Error('closed'));
    function done(err: Error | null, i = 0) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.pause();
      if (err) reject(err);
      else resolve({ head: buf.subarray(0, i).toString('latin1'), rest: buf.subarray(i + 4) });
    }
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.resume();
  });
}

/** Parses an HTTP request head. Exported for tests. */
export function parseHead(head: string, rest: Buffer): EncoderRequest | null {
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

interface Listener {
  port: number;
  server: net.Server;
}

/**
 * The source role: encoders connect to this node (plain Icecast and TLS), and every connection is passed on to the
 * ingest gateway of the main server, which checks the log-in. TLS certificates for the customer names that point here
 * come from the node's web server (copied by the root helper into certs/).
 */
export class SourceForwarder {
  /** Listening encoder ports: the node's own and, while it keeps them, the old ones (port plan, 1.3). */
  private plain: Listener[] = [];
  private secure: Listener[] = [];
  private plan: SourcePlan | null = null;
  private contexts = new Map<string, tls.SecureContext>();
  private defaultCert: { cert: Buffer; key: Buffer } | null = null;
  private certStamp = '';
  private active = new Map<net.Socket, number>();
  problems: string[] = [];

  /** The ingest role (phase 13), set by the agent. */
  ingest: IngestManager | null = null;

  constructor(private readonly node: { nodeId: string; secret: string }) {}

  get encoders() {
    const now = Date.now();
    return [...this.active.values()].filter((since) => now - since > 5000).length;
  }

  async apply(plan: SourcePlan | null) {
    this.plan = plan;
    this.problems = [];
    await this.loadCertificates();
    const plain = plan?.ports?.plain ?? (plan?.plainPort ? [plan.plainPort] : []);
    const secure = plan?.ports?.tls ?? (plan?.tlsPort ? [plan.tlsPort] : []);
    this.plain = this.rebind(this.plain, plain, 'plain');
    this.secure = this.rebind(this.secure, this.defaultCert ? secure : [], 'tls');
    if (secure.length && !this.defaultCert) this.problems.push('No certificate for encoder TLS yet');
  }

  stop() {
    void this.apply(null);
    for (const s of this.active.keys()) s.destroy();
  }

  private rebind(cur: Listener[], ports: number[], via: 'tls' | 'plain'): Listener[] {
    const keep = cur.filter((l) => ports.includes(l.port));
    for (const l of cur) if (!ports.includes(l.port)) l.server.close();
    return [...keep, ...ports.filter((p) => !keep.some((l) => l.port === p)).map((p) => this.listen(p, via))];
  }

  private listen(port: number, via: 'tls' | 'plain'): Listener {
    const onConn = (socket: net.Socket) => this.forward(socket, via);
    const server =
      via === 'tls'
        ? tls.createServer({ SNICallback: (name, cb) => cb(null, this.contexts.get(name.toLowerCase()) ?? this.contexts.get('default')), ...(this.defaultCert ?? {}) }, onConn)
        : net.createServer(onConn);
    if (via === 'tls') (server as tls.Server).on('tlsClientError', () => undefined);
    server.on('error', (err) => {
      const msg = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message;
      this.problems.push(msg);
      log.error('encoder port failed', { port, err: msg });
    });
    server.listen(port, () => log.info('taking encoders', { port, via }));
    return { port, server };
  }

  private async loadCertificates() {
    const dir = dataPath('certs');
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.crt'));
    const stamp = (await Promise.all(files.map(async (f) => `${f}:${(await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0}`))).join(',');
    if (stamp === this.certStamp) return;
    const contexts = new Map<string, tls.SecureContext>();
    let def: { cert: Buffer; key: Buffer } | null = null;
    for (const f of files) {
      const host = f.slice(0, -4);
      try {
        const cert = await readFile(join(dir, f));
        const key = await readFile(join(dir, `${host}.key`));
        contexts.set(host, tls.createSecureContext({ cert, key }));
        if (host === 'default' || !def) def = { cert, key };
      } catch (err) {
        log.warn('certificate could not be loaded', { host, err });
      }
    }
    this.contexts = contexts;
    this.certStamp = stamp;
    const changed = !!def && (!this.defaultCert || !def.cert.equals(this.defaultCert.cert));
    this.defaultCert = def;
    if (changed) for (const l of this.secure) (l.server as tls.Server).setSecureContext(def!);
  }

  private forward(client: net.Socket, via: 'tls' | 'plain') {
    const plan = this.plan;
    if (!plan) return client.destroy();
    this.active.set(client, Date.now());
    client.setNoDelay(true);
    const ip = (client.remoteAddress ?? '').replace(/^::ffff:/, '');
    const host = via === 'tls' ? (client as tls.TLSSocket).servername || null : null;
    client.on('error', () => client.destroy());
    client.on('close', () => this.active.delete(client));
    void readHead(client)
      .then(({ head, rest }) => {
        const req = parseHead(head, rest);
        const name = host || req?.headers.get('host')?.replace(/:\d+$/, '') || null;
        // Stations routed to this node (phase 13) are taken here; the audio never goes to the main server.
        if (req && this.ingest?.takes(req, name)) return this.ingest.handle(client, req, via, ip || '0.0.0.0', name);
        this.passOn(client, plan, via, ip, host, Buffer.concat([Buffer.from(`${head}\r\n\r\n`, 'latin1'), rest]));
      })
      .catch(() => client.destroy());
  }

  /** Passes an encoder on to the ingest gateway of the main server, for stations that take encoders there. */
  private passOn(client: net.Socket, plan: SourcePlan, via: 'tls' | 'plain', ip: string, host: string | null, first: Buffer) {
    const up = plan.upstream;
    const upstream = up.tls ? tls.connect({ host: up.host, port: up.port, servername: net.isIP(up.host) ? undefined : up.host }) : net.connect({ host: up.host, port: up.port });
    upstream.setNoDelay(true);
    const end = () => {
      this.active.delete(client);
      client.destroy();
      upstream.destroy();
    };
    upstream.once(up.tls ? 'secureConnect' : 'connect', () => {
      log.info('passing an encoder on', { ip, host, upstream: `${up.host}:${up.port}`, tls: up.tls });
      upstream.write(signPreamble(this.node.secret, { nodeId: this.node.nodeId, via, ip: ip || '0.0.0.0', host }));
      upstream.write(first);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on('error', (err) => {
      log.warn('passing an encoder on failed', { ip, upstream: `${up.host}:${up.port}`, err: (err as NodeJS.ErrnoException).code ?? err.message });
      if (!client.destroyed) client.end('HTTP/1.0 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nThe main server cannot be reached right now.\r\n');
      end();
    });
    client.on('close', end);
    upstream.on('close', end);
  }

  /** Picks up new and renewed certificates, and opens the TLS port once the first certificate is there. */
  async refreshCertificates() {
    await this.loadCertificates();
    if ((this.plan?.ports?.tls.length || this.plan?.tlsPort) && this.defaultCert && !this.secure.length) await this.apply(this.plan);
  }
}
