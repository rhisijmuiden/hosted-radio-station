/**
 * End-to-end test of the streams service with real Icecast and ffmpeg: an encoder goes through the ingest gateway,
 * a converted mount and a relay to a second ("external") Icecast server follow, titles are forwarded and limits apply.
 * Skipped when icecast2 or ffmpeg is not installed.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { fetchStats } from '../src/services/streaming/icecast.js';
import { putSetting, getSetting } from '../src/services/settings.js';
import { StreamsWorker } from '../src/streams/worker.js';
import { login, setup } from './helpers.js';

const has = (cmd: string) => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const enabled = has('icecast2') && has('ffmpeg') && has('openssl');
const base = 20000 + Math.floor(Math.random() * 20000);
const PORTS = { tls: base, plain: base + 1, icecastFrom: base + 10, legacyFrom: base + 100, external: base + 300 };

let t: Awaited<ReturnType<typeof setup>>;
let worker: StreamsWorker;
const children: ChildProcess[] = [];
let stationId: string;
let icecastPort: number;
let adminPassword: string;
let legacyPort: number;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(250);
  }
  throw new Error('timed out');
}

/** Icecast refuses to run as root; the test container runs as root. */
function startIcecast(configXml: string, dir: string) {
  writeFileSync(join(dir, 'icecast.xml'), configXml);
  chmodSync(dir, 0o777);
  const root = process.getuid?.() === 0;
  const child = root
    ? spawn('su', ['nobody', '-s', '/bin/sh', '-c', `exec icecast2 -c ${join(dir, 'icecast.xml')}`], { stdio: 'ignore' })
    : spawn('icecast2', ['-c', join(dir, 'icecast.xml')], { stdio: 'ignore' });
  children.push(child);
}

function encoder(url: string, extra: string[] = []) {
  const child = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-c:a', 'libmp3lame', '-b:a', '128k', ...extra, '-f', 'mp3', '-content_type', 'audio/mpeg', url], { stdio: 'ignore' });
  children.push(child);
  return child;
}

const stats = () => fetchStats({ port: icecastPort, adminPassword });
const mountLive = (path: string, port = icecastPort, pass = adminPassword) => until(async () => (await fetchStats({ port, adminPassword: pass })).find((s) => s.mount === path));

/** Sends a raw request through the gateway and returns the first answer. */
function raw(port: number, payload: string | Buffer, opts: { tls?: boolean; servername?: string } = {}): Promise<string> {
  return new Promise((resolve) => {
    const socket = opts.tls
      ? tls.connect({ port, host: '127.0.0.1', servername: opts.servername, rejectUnauthorized: false }, () => socket.write(payload))
      : net.connect(port, '127.0.0.1', () => socket.write(payload));
    let got = '';
    socket.on('data', (d) => (got += d.toString()));
    socket.on('error', () => resolve(got));
    setTimeout(() => {
      socket.destroy();
      resolve(got);
    }, 1500);
  });
}

describe.skipIf(!enabled)('streams service', () => {
  beforeAll(async () => {
    t = await setup();
    const admin = await login(t.app, 'admin@example.com', 'admin-password');
    const s = await getSetting(t.ctx, 'streaming');
    await putSetting(t.ctx, 'streaming', {
      ...s,
      ingestTlsPort: PORTS.tls,
      ingestPlainPort: PORTS.plain,
      icecastPortFrom: PORTS.icecastFrom,
      icecastPortTo: PORTS.icecastFrom + 50,
      legacyPortFrom: PORTS.legacyFrom,
      legacyPortTo: PORTS.legacyFrom + 50,
    });
    const tenant = await t.app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: admin,
      payload: { name: 'Test', slug: 'test', limits: { maxStations: 3, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 100 } },
    });
    const station = await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId: tenant.json().id, name: 'Test FM', slug: 'test-fm' } });
    stationId = station.json().id;
    const liveId = station.json().mounts[0].id;
    await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/accounts`, headers: admin, payload: { username: 'dj1', displayName: 'DJ One', password: 'dj1-password' } });
    await t.app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/mounts`,
      headers: admin,
      payload: { path: '/low.mp3', kind: 'transcode', sourceMountId: liveId, format: 'mp3', bitrateKbps: 64 },
    });
    const legacy = await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}`, headers: admin, payload: { legacy: { enabled: true } } });
    legacyPort = legacy.json().legacyPort;

    // The "external" server the relay pushes to.
    const extDir = mkdtempSync(join(tmpdir(), 'hrs-ext-'));
    startIcecast(
      `<icecast><hostname>localhost</hostname><limits><sources>5</sources></limits><authentication><source-password>ext-pass</source-password><admin-user>admin</admin-user><admin-password>ext-admin</admin-password></authentication><listen-socket><port>${PORTS.external}</port><bind-address>127.0.0.1</bind-address></listen-socket><paths><basedir>/usr/share/icecast2</basedir><logdir>${extDir}</logdir><webroot>/usr/share/icecast2/web</webroot><adminroot>/usr/share/icecast2/admin</adminroot></paths><logging><errorlog>error.log</errorlog><loglevel>2</loglevel></logging><security><chroot>0</chroot></security></icecast>`,
      extDir,
    );
    await t.app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/outputs`,
      headers: admin,
      payload: { type: 'icecast', name: 'External', mountId: liveId, config: { host: '127.0.0.1', port: PORTS.external, mount: '/relay', password: 'ext-pass' } },
    });

    // The station's own Icecast server, from the configuration the API wrote.
    const [row] = await t.db.select().from(schema.stations).where(eq(schema.stations.id, stationId));
    icecastPort = row!.icecastPort;
    adminPassword = t.ctx.box.decrypt(row!.icecastAdminPassword);
    const dir = mkdtempSync(join(tmpdir(), 'hrs-ice-'));
    const xml = readFileSync(join(t.ctx.config.DATA_DIR, 'stations', stationId, 'icecast.xml'), 'utf8').replace(/<logdir>[^<]*<\/logdir>/, `<logdir>${dir}</logdir>`).replace(/<pidfile>[^<]*<\/pidfile>/, '');
    startIcecast(xml, dir);

    // A self-signed default certificate for TLS ingest.
    const certs = join(t.ctx.config.DATA_DIR, 'certs');
    mkdirSync(certs, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(certs, 'default.key'), '-out', join(certs, 'default.crt')], { stdio: 'ignore' });

    worker = new StreamsWorker(t.ctx, pino({ level: 'silent' }));
    await worker.start();
    await until(async () => (await stats()) !== null && worker.gateway.portStates().plain?.ok && worker.gateway.portStates().tls?.ok);
  }, 30_000);

  afterAll(async () => {
    await worker?.stop();
    for (const c of children) c.kill('SIGKILL');
    try {
      execFileSync('pkill', ['-u', 'nobody', 'icecast2'], { stdio: 'ignore' });
    } catch {
      /* none left */
    }
    await t?.close();
  });

  it('refuses wrong passwords, unknown mounts and too high bitrates', async () => {
    const auth = (u: string, p: string) => Buffer.from(`${u}:${p}`).toString('base64');
    expect(await raw(PORTS.plain, `SOURCE /test-fm/live HTTP/1.0\r\nAuthorization: Basic ${auth('dj1', 'wrong')}\r\n\r\n`)).toMatch(/401/);
    expect(await raw(PORTS.plain, `SOURCE /nope/live HTTP/1.0\r\nAuthorization: Basic ${auth('dj1', 'dj1-password')}\r\n\r\n`)).toMatch(/404/);
    expect(await raw(PORTS.plain, `SOURCE /test-fm/live HTTP/1.0\r\nAuthorization: Basic ${auth('dj1', 'dj1-password')}\r\nice-audio-info: bitrate=320\r\n\r\n`)).toMatch(/403[\s\S]*192 kbps/);
    // Converted mounts are made here, encoders cannot feed them.
    expect(await raw(PORTS.plain, `SOURCE /test-fm/low.mp3 HTTP/1.0\r\nAuthorization: Basic ${auth('dj1', 'dj1-password')}\r\n\r\n`)).toMatch(/404/);
  });

  it('takes a live encoder, converts it, relays it and forwards titles', async () => {
    encoder('icecast://dj1:dj1-password@127.0.0.1:' + PORTS.plain + '/test-fm/live');
    await mountLive('/live');
    const session = await until(async () => (await t.db.select().from(schema.liveSessions).where(eq(schema.liveSessions.stationId, stationId)))[0]);
    expect(session).toMatchObject({ accountName: 'DJ One', mountPath: '/live', via: 'plain', endedAt: null });

    await mountLive('/low.mp3');
    await mountLive('/relay', PORTS.external, 'ext-admin');

    const auth = Buffer.from('dj1:dj1-password').toString('base64');
    const res = await raw(PORTS.plain, `GET /admin/metadata?mount=/test-fm/live&mode=updinfo&song=Artist%20-%20Caf%C3%A9 HTTP/1.0\r\nAuthorization: Basic ${auth}\r\n\r\n`);
    expect(res).toMatch(/200/);
    await until(async () => (await stats()).find((s) => s.mount === '/live')?.title === 'Artist - Café');
    await until(async () => (await stats()).find((s) => s.mount === '/low.mp3')?.title === 'Artist - Café');
    await until(async () => (await fetchStats({ port: PORTS.external, adminPassword: 'ext-admin' })).find((s) => s.mount === '/relay')?.title === 'Artist - Café');

    // A second encoder on the same mount gets Icecast's answer.
    expect(await raw(PORTS.plain, `SOURCE /test-fm/live HTTP/1.0\r\nAuthorization: Basic ${auth}\r\n\r\n`)).toMatch(/403/);
  }, 40_000);

  it('disconnects an encoder from the panel', async () => {
    const admin = await login(t.app, 'admin@example.com', 'admin-password');
    const detail = (await t.app.inject({ url: `/api/stations/${stationId}`, headers: admin })).json();
    const live = detail.mounts.find((m: { path: string }) => m.path === '/live');
    const res = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/mounts/${live.id}/disconnect`, headers: admin });
    expect(res.statusCode).toBe(200);
    for (const c of children.splice(2)) c.kill('SIGKILL');
    const ended = await until(async () => (await t.db.select().from(schema.liveSessions).where(eq(schema.liveSessions.stationId, stationId))).find((s) => s.endedAt));
    expect(ended.endReason).toBe('kicked');
    await until(async () => !(await stats()).some((s) => s.mount === '/live'));
  }, 20_000);

  it('takes encoders over TLS', async () => {
    const auth = Buffer.from('dj1:dj1-password').toString('base64');
    const answer = await raw(PORTS.tls, `PUT /test-fm/live HTTP/1.1\r\nHost: localhost\r\nAuthorization: Basic ${auth}\r\nContent-Type: audio/mpeg\r\nExpect: 100-continue\r\n\r\n`, { tls: true, servername: 'localhost' });
    expect(answer).toMatch(/HTTP\/1\.0 200/);
  });

  it('takes legacy Shoutcast v1 encoders on port + 1', async () => {
    await until(async () => !(await stats()).some((s) => s.mount === '/live'));
    const socket = net.connect(legacyPort + 1, '127.0.0.1');
    const got: string[] = [];
    socket.on('data', (d) => got.push(d.toString()));
    await new Promise((r) => socket.once('connect', r));
    socket.write('dj1:dj1-password\r\n');
    await until(async () => got.join('').includes('OK2'));
    socket.write('icy-name:Legacy\r\nicy-br:128\r\ncontent-type:audio/mpeg\r\n\r\n');
    // Some MP3 frames of silence.
    const frame = Buffer.alloc(417);
    frame.set([0xff, 0xfb, 0x90, 0x64]);
    const timer = setInterval(() => socket.write(Buffer.concat(Array(10).fill(frame))), 100);
    const live = await mountLive('/live');
    expect(live.contentType).toBe('audio/mpeg');
    const sessions = await t.db.select().from(schema.liveSessions).where(eq(schema.liveSessions.stationId, stationId));
    expect(sessions.some((s) => s.via === 'shoutcast' && !s.endedAt)).toBe(true);
    clearInterval(timer);
    socket.destroy();
  }, 20_000);
});
