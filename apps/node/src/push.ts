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

interface Feed {
  socket: net.Socket;
  /** 0 = the main ingest (or a station node), 1 = a backup ingest. */
  priority: number;
  since: number;
  bitrateKbps: number | null;
}

interface Slot {
  mount: RelayMount;
  /** Every ingest pushing this stream now; the best one feeds Icecast, the others stand by. */
  feeds: Feed[];
  /** The one feeding Icecast. */
  client: Feed | null;
  local: net.Socket | null;
  /** The source connection being opened, so two ingests that arrive together share it. */
  opening: Promise<net.Socket> | null;
  /** The last title per priority, so a switch to the backup brings its title along at once. */
  titles: Map<number, string>;
  /** Set while the source connection waits for a new push (see LINGER_MS). */
  linger: NodeJS.Timeout | null;
  since: number;
  state: RelayState;
}

const HEAD_END = /\r?\n\r?\n/;
/**
 * How long the source connection stays open after the last push ends, so a push that reconnects (a station node that
 * restarts its stream) or a puller that takes the stream back finds it open and listeners stay connected. It stays
 * under Icecast's source timeout of 10 seconds.
 */
export const LINGER_MS = 8000;
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

  constructor(
    private readonly ctx: {
      icecastPort: () => number;
      secrets: IcecastSecrets;
      /** An open source connection for this stream left by its puller, so listeners stay connected (phase 12). */
      inherit?: (key: string) => net.Socket | null;
      lingerMs?: number;
    },
  ) {}

  /**
   * `handBack`: a stream that is pulled again (its station moved back from a station node) gets the open source
   * connection of its slot, so listeners stay connected.
   */
  async apply(port: number | null, mounts: RelayMount[], handBack?: (key: string, local: net.Socket) => void) {
    const wanted = new Map(mounts.filter((m) => m.push).map((m) => [m.key, m]));
    const pulled = new Set(mounts.filter((m) => m.url).map((m) => m.key));
    for (const [key, s] of this.slots) {
      const want = wanted.get(key);
      if (!want || want.push!.token !== s.mount.push!.token || want.path !== s.mount.path) {
        const local = s.local;
        if (!want && handBack && local && !local.destroyed && pulled.has(key)) {
          s.local = null;
          handBack(key, local);
        }
        this.drop(s);
        this.slots.delete(key);
      } else s.mount = want;
    }
    for (const [key, m] of wanted) if (!this.slots.has(key)) this.slots.set(key, { mount: m, feeds: [], client: null, local: null, opening: null, titles: new Map(), linger: null, since: 0, state: { key, state: 'idle', message: 'Waiting for the ingest' } });
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
    this.unlinger(s);
    for (const f of s.feeds) f.socket.destroy();
    s.local?.destroy();
    s.feeds = [];
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

    const priority = Math.max(0, Math.min(9, Number(headers.get('x-hrs-priority')) || 0));

    if (method === 'GET' && url.pathname === '/admin/metadata') {
      const slot = slotOf(url.searchParams.get('mount') ?? '');
      if (!slot || user !== 'source' || !pass || !same(pass, slot.mount.push!.token)) return this.reply(socket, '401 Unauthorized');
      const song = url.searchParams.get('song');
      // Titles of an ingest that stands by would not match the audio.
      if (song) slot.titles.set(priority, song);
      if (song && slot.local && (!slot.client || priority <= slot.client.priority)) await updateTitle(this.ctx.icecastPort(), this.ctx.secrets.admin, localMount(slot.mount), song).catch(() => undefined);
      return this.reply(socket, '200 OK');
    }
    if (method !== 'PUT' && method !== 'SOURCE') return this.reply(socket, '405 Method Not Allowed');
    const slot = slotOf(url.pathname);
    if (!slot) return this.reply(socket, '404 Not Found');
    if (user !== 'source' || !pass || !same(pass, slot.mount.push!.token)) return this.reply(socket, '401 Unauthorized');

    // A new push of the same ingest replaces its old one (it reconnected).
    for (const f of slot.feeds.filter((x) => x.priority === priority)) this.remove(slot, f, false, true);
    if (slot.linger) log.info('ingest back within the wait', { mount: slot.mount.key });
    this.unlinger(slot);
    if (!slot.local) {
      const inherited = this.ctx.inherit?.(slot.mount.key) ?? null;
      if (inherited) {
        slot.local = this.watchLocal(slot, inherited);
        log.info('push takes over the pulled stream', { mount: slot.mount.key });
      }
    }
    if (!slot.local) {
      try {
        slot.opening ??= this.openLocal(slot, headers).finally(() => (slot.opening = null));
        slot.local = await slot.opening;
      } catch (err) {
        slot.state = { key: slot.mount.key, state: 'error', message: (err as Error).message };
        return this.reply(socket, '503 Service Unavailable');
      }
    }
    if (headers.get('expect')?.toLowerCase() === '100-continue') socket.write('HTTP/1.1 100 Continue\r\n\r\n');
    this.reply(socket, '200 OK', false);
    const feed: Feed = { socket, priority, since: Date.now(), bitrateKbps: Number(headers.get('ice-audio-info')?.match(/bitrate=(\d+)/)?.[1]) || null };
    slot.feeds.push(feed);
    log.info('ingest pushing', { mount: slot.mount.key, from: socket.remoteAddress, priority });
    // Audio of a feed that stands by is read and dropped, so it can take over without a gap.
    socket.on('data', (d: Buffer) => {
      if (slot.client === feed && slot.local && !slot.local.write(d)) {
        socket.pause();
        slot.local.once('drain', () => socket.resume());
      }
    });
    socket.once('close', () => this.remove(slot, feed, true));
    if (rest.length && (!slot.client || priority < slot.client.priority)) slot.local?.write(rest);
    this.promote(slot);
  }

  /** The source connection into the node's own Icecast; it stays open while any ingest pushes. */
  private async openLocal(slot: Slot, headers: Map<string, string>) {
    const local = await sourceConnection(this.ctx.icecastPort(), localMount(slot.mount), this.ctx.secrets.source, {
      'Content-Type': headers.get('content-type') ?? 'audio/mpeg',
      'Ice-Name': headers.get('ice-name') ?? slot.mount.name,
      'Ice-Public': '0',
      ...(headers.get('ice-audio-info') ? { 'Ice-Audio-Info': headers.get('ice-audio-info')! } : {}),
    });
    return this.watchLocal(slot, local);
  }

  /** Follows the source connection of a slot: when Icecast drops it, the pushes start again. */
  private watchLocal(slot: Slot, local: net.Socket) {
    slot.since = Date.now();
    local.on('error', () => undefined);
    local.once('close', () => {
      if (slot.local !== local) return;
      this.unlinger(slot);
      // Icecast dropped the stream: start again with the next push.
      for (const f of slot.feeds) f.socket.destroy();
      slot.feeds = [];
      slot.client = null;
      slot.local = null;
      slot.state = { key: slot.mount.key, state: 'idle', message: 'The local Icecast dropped the stream' };
    });
    return local;
  }

  /** Lets the best feed (lowest priority number, then the newest) feed Icecast. */
  private promote(slot: Slot) {
    const best = [...slot.feeds].sort((a, b) => a.priority - b.priority || b.since - a.since)[0] ?? null;
    if (best !== slot.client) {
      if (best && slot.client) log.info('switching ingest', { mount: slot.mount.key, from: slot.client.priority, to: best.priority });
      slot.client?.socket.resume();
      slot.client = best;
      best?.socket.resume();
      const title = best && slot.titles.get(best.priority);
      if (title && slot.local) void updateTitle(this.ctx.icecastPort(), this.ctx.secrets.admin, localMount(slot.mount), title).catch(() => undefined);
    }
    slot.state = best
      ? { key: slot.mount.key, state: 'connected', bitrateKbps: best.bitrateKbps, ...(best.priority > 0 ? { message: 'From the backup ingest' } : {}) }
      : { key: slot.mount.key, state: 'idle', message: 'The ingest stopped pushing' };
  }

  private remove(slot: Slot, feed: Feed, closed: boolean, replaced = false) {
    const i = slot.feeds.indexOf(feed);
    if (i < 0) return;
    slot.feeds.splice(i, 1);
    if (slot.client === feed) slot.client = null;
    if (!closed) feed.socket.destroy();
    if (!slot.feeds.some((f) => f.priority === feed.priority)) slot.titles.delete(feed.priority);
    if (slot.feeds.length) return this.promote(slot);
    if (replaced) return;
    // Nobody pushes any more. Keep the source connection a moment for a push that comes back; after that let Icecast
    // end the stream, so listeners move on or reconnect.
    slot.client = null;
    slot.state = { key: slot.mount.key, state: 'idle', message: 'The ingest stopped pushing' };
    if (!slot.local || slot.linger) return;
    slot.linger = setTimeout(() => {
      slot.linger = null;
      if (slot.feeds.length) return;
      const local = slot.local;
      slot.local = null;
      local?.destroy();
    }, this.ctx.lingerMs ?? LINGER_MS);
  }

  private unlinger(slot: Slot) {
    if (slot.linger) clearTimeout(slot.linger);
    slot.linger = null;
  }
}
