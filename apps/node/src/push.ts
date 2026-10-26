import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { dataPath } from './config.js';
import { localMount, updateTitle, type IcecastSecrets } from './icecast.js';
import { log } from './log.js';
import type { AgentReport, RelayMount } from './protocol.js';
import { sourceConnection } from './relay.js';

type RelayState = AgentReport['relays'][number];

interface Slot {
  mount: RelayMount;
  client: net.Socket | null;
  local: net.Socket | null;
  since: number;
  state: RelayState;
}

const HEAD_END = /\r?\n\r?\n/;
const MAX_HEAD = 16 * 1024;

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A certificate for the push port when the node has no public name (station nodes then skip the name check). */
async function selfSigned(): Promise<{ cert: Buffer; key: Buffer }> {
  const cert = dataPath('push', 'self.crt');
  const key = dataPath('push', 'self.key');
  try {
    await access(cert);
  } catch {
    await promisify(execFile)('mkdir', ['-p', dataPath('push')]);
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-subj', '/CN=hrs-node', '-keyout', key, '-out', cert]);
  }
  return { cert: await readFile(cert), key: await readFile(key) };
}

/**
 * Takes streams that station nodes push to this relay node (phase 12). A station node signs in like an Icecast source
 * (PUT /listen/<station>/<mount>, user "source", the mount's token as password); the stream goes into the same mount
 * on the node's own Icecast, where listeners hear it. Titles come in through /admin/metadata as on Icecast.
 */
export class PushReceiver {
  private server: tls.Server | null = null;
  private port: number | null = null;
  private slots = new Map<string, Slot>();
  problems: string[] = [];

  constructor(private readonly ctx: { icecastPort: () => number; secrets: IcecastSecrets }) {}

  async apply(port: number | null, mounts: RelayMount[]) {
    const wanted = new Map(mounts.filter((m) => m.push).map((m) => [m.key, m]));
    for (const [key, s] of this.slots) {
      const want = wanted.get(key);
      if (!want || want.push!.token !== s.mount.push!.token || want.path !== s.mount.path) {
        this.drop(s);
        this.slots.delete(key);
      } else s.mount = want;
    }
    for (const [key, m] of wanted) if (!this.slots.has(key)) this.slots.set(key, { mount: m, client: null, local: null, since: 0, state: { key, state: 'idle', message: 'Waiting for the station node' } });
    const listen = wanted.size ? port : null;
    if (listen === this.port) return;
    this.server?.close();
    this.server = null;
    this.port = listen;
    this.problems = [];
    if (!listen) return;
    const certs = await this.certificates();
    const server = tls.createServer({ ...certs.default, SNICallback: (name, cb) => cb(null, certs.byName.get(name.toLowerCase())) }, (socket) => this.accept(socket));
    server.on('tlsClientError', () => undefined);
    server.on('error', (err) => {
      const msg = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Push port ${listen} is already in use` : err.message;
      this.problems.push(msg);
      log.error('push port failed', { port: listen, err: msg });
    });
    server.listen(listen, () => log.info('taking streams from station nodes', { port: listen }));
    this.server = server;
  }

  stop() {
    void this.apply(null, []);
    for (const s of this.slots.values()) this.drop(s);
    this.slots.clear();
  }

  /** The node's own certificates (for its public name), else a self-signed one. */
  private async certificates() {
    const dir = dataPath('certs');
    const byName = new Map<string, tls.SecureContext>();
    let def: { cert: Buffer; key: Buffer } | null = null;
    for (const f of (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.crt'))) {
      const host = f.slice(0, -4);
      try {
        const pair = { cert: await readFile(join(dir, f)), key: await readFile(join(dir, `${host}.key`)) };
        byName.set(host, tls.createSecureContext(pair));
        def ??= pair;
      } catch {
        /* incomplete pair */
      }
    }
    return { default: def ?? (await selfSigned()), byName };
  }

  states(): RelayState[] {
    return [...this.slots.values()].map((s) => s.state);
  }

  connected(key: string) {
    return this.slots.get(key)?.state.state === 'connected';
  }

  private drop(s: Slot) {
    s.client?.destroy();
    s.local?.destroy();
    s.client = null;
    s.local = null;
  }

  private accept(socket: tls.TLSSocket) {
    socket.setNoDelay(true);
    socket.on('error', () => undefined);
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 10_000);
    const onData = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const text = head.toString('latin1');
      const m = text.match(HEAD_END);
      if (!m) {
        if (head.length > MAX_HEAD) socket.destroy();
        return;
      }
      socket.off('data', onData);
      clearTimeout(timer);
      const end = m.index! + m[0].length;
      void this.request(socket, text.slice(0, m.index!), head.subarray(end));
    };
    socket.on('data', onData);
  }

  private reply(socket: net.Socket, status: string, close = true) {
    socket.write(`HTTP/1.1 ${status}\r\nServer: Hosted Radio Station node\r\nContent-Length: 0\r\n${close ? 'Connection: close\r\n' : ''}\r\n`);
    if (close) socket.end();
  }

  private async request(socket: net.Socket, headText: string, rest: Buffer) {
    const [first, ...lines] = headText.split(/\r?\n/);
    const [method, target] = (first ?? '').split(' ');
    const headers = new Map<string, string>();
    for (const l of lines) {
      const i = l.indexOf(':');
      if (i > 0) headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
    }
    const url = new URL(target ?? '/', 'http://node');
    const auth = headers.get('authorization') ?? '';
    const [user, pass] = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString('utf8').split(/:(.*)/s) : [];
    const slotOf = (mount: string) => [...this.slots.values()].find((s) => localMount(s.mount) === mount);

    if (method === 'GET' && url.pathname === '/admin/metadata') {
      const slot = slotOf(url.searchParams.get('mount') ?? '');
      if (!slot || user !== 'source' || !pass || !same(pass, slot.mount.push!.token)) return this.reply(socket, '401 Unauthorized');
      const song = url.searchParams.get('song');
      if (song && slot.local) await updateTitle(this.ctx.icecastPort(), this.ctx.secrets.admin, localMount(slot.mount), song).catch(() => undefined);
      return this.reply(socket, '200 OK');
    }
    if (method !== 'PUT' && method !== 'SOURCE') return this.reply(socket, '405 Method Not Allowed');
    const slot = slotOf(url.pathname);
    if (!slot) return this.reply(socket, '404 Not Found');
    if (user !== 'source' || !pass || !same(pass, slot.mount.push!.token)) return this.reply(socket, '401 Unauthorized');

    // A new push replaces the old one (the station node reconnected).
    this.drop(slot);
    let local: net.Socket;
    try {
      local = await sourceConnection(this.ctx.icecastPort(), localMount(slot.mount), this.ctx.secrets.source, {
        'Content-Type': headers.get('content-type') ?? 'audio/mpeg',
        'Ice-Name': headers.get('ice-name') ?? slot.mount.name,
        'Ice-Public': '0',
        ...(headers.get('ice-audio-info') ? { 'Ice-Audio-Info': headers.get('ice-audio-info')! } : {}),
      });
    } catch (err) {
      slot.state = { key: slot.mount.key, state: 'error', message: (err as Error).message };
      return this.reply(socket, '503 Service Unavailable');
    }
    if (headers.get('expect')?.toLowerCase() === '100-continue') socket.write('HTTP/1.1 100 Continue\r\n\r\n');
    this.reply(socket, '200 OK', false);
    slot.client = socket;
    slot.local = local;
    slot.since = Date.now();
    const br = Number(headers.get('ice-audio-info')?.match(/bitrate=(\d+)/)?.[1]) || null;
    slot.state = { key: slot.mount.key, state: 'connected', bitrateKbps: br };
    log.info('station node pushing', { mount: slot.mount.key, from: socket.remoteAddress });
    if (rest.length) local.write(rest);
    socket.pipe(local);
    const end = (why: string) => {
      if (slot.client !== socket) return;
      this.drop(slot);
      slot.state = { key: slot.mount.key, state: 'idle', message: why };
    };
    socket.once('close', () => end('The station node stopped pushing'));
    local.once('close', () => end('The local Icecast dropped the stream'));
    local.on('error', () => undefined);
  }
}
