import { createHmac } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { dataPath } from './config.js';
import { log } from './log.js';
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
  private plain: Listener | null = null;
  private secure: Listener | null = null;
  private plan: SourcePlan | null = null;
  private contexts = new Map<string, tls.SecureContext>();
  private defaultCert: { cert: Buffer; key: Buffer } | null = null;
  private certStamp = '';
  private active = new Map<net.Socket, number>();
  problems: string[] = [];

  constructor(private readonly node: { nodeId: string; secret: string }) {}

  get encoders() {
    const now = Date.now();
    return [...this.active.values()].filter((since) => now - since > 5000).length;
  }

  async apply(plan: SourcePlan | null) {
    this.plan = plan;
    this.problems = [];
    await this.loadCertificates();
    this.plain = this.rebind(this.plain, plan?.plainPort ?? null, 'plain');
    this.secure = this.rebind(this.secure, plan?.tlsPort && this.defaultCert ? plan.tlsPort : null, 'tls');
    if (plan?.tlsPort && !this.defaultCert) this.problems.push('No certificate for encoder TLS yet');
  }

  stop() {
    void this.apply(null);
    for (const s of this.active.keys()) s.destroy();
  }

  private rebind(cur: Listener | null, port: number | null, via: 'tls' | 'plain'): Listener | null {
    if (cur && cur.port === port) return cur;
    cur?.server.close();
    if (!port) return null;
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
    if (changed && this.secure) (this.secure.server as tls.Server).setSecureContext(def!);
  }

  private forward(client: net.Socket, via: 'tls' | 'plain') {
    const plan = this.plan;
    if (!plan) return client.destroy();
    this.active.set(client, Date.now());
    client.setNoDelay(true);
    const ip = (client.remoteAddress ?? '').replace(/^::ffff:/, '');
    const host = via === 'tls' ? (client as tls.TLSSocket).servername || null : null;
    const up = plan.upstream;
    const upstream = up.tls ? tls.connect({ host: up.host, port: up.port, servername: net.isIP(up.host) ? undefined : up.host }) : net.connect({ host: up.host, port: up.port });
    upstream.setNoDelay(true);
    const end = () => {
      this.active.delete(client);
      client.destroy();
      upstream.destroy();
    };
    client.pause();
    upstream.once(up.tls ? 'secureConnect' : 'connect', () => {
      upstream.write(signPreamble(this.node.secret, { nodeId: this.node.nodeId, via, ip: ip || '0.0.0.0', host }));
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on('error', (err) => {
      log.warn('passing an encoder on failed', { ip, err });
      if (!client.destroyed) client.end('HTTP/1.0 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nThe main server cannot be reached right now.\r\n');
      end();
    });
    client.on('error', end);
    client.on('close', end);
    upstream.on('close', end);
  }

  /** Picks up new and renewed certificates, and opens the TLS port once the first certificate is there. */
  async refreshCertificates() {
    await this.loadCertificates();
    if (this.plan?.tlsPort && this.defaultCert && !this.secure) await this.apply(this.plan);
  }
}
