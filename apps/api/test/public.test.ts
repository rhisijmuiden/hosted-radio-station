import { execFileSync } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { schema } from '../src/db/index.js';
import { renderPublicShell } from '../src/routes/public.js';
import { artworkKey, splitTitle } from '../src/services/public/artwork.js';
import { scanOnDemand } from '../src/services/public/ondemand.js';
import { mediaDir } from '../src/services/streaming/icecast.js';
import { Recorder, recordingFile, recordingTitle } from '../src/streams/recorder.js';
import { loadSnapshot } from '../src/streams/snapshot.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let owner: { cookie: string };
let dj: { cookie: string };
let tenantId: string;
let stationId: string;
let icecast: http.Server;
let base: string;
/** What the fake Icecast server reports: mount → title. */
const onAir = new Map<string, string | null>();

const statsXml = () =>
  `<icestats>${[...onAir]
    .map(([mount, title]) => `<source mount="${mount}"><listeners>3</listeners>${title !== null ? `<title>${title}</title>` : ''}<server_type>audio/mpeg</server_type></source>`)
    .join('')}</icestats>`;

const settings = async (patch: Record<string, unknown>) => {
  const current = (await t.app.inject({ url: `/api/stations/${stationId}/public`, headers: owner })).json().settings;
  const res = await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/public`, headers: owner, payload: { ...current, ...patch } });
  expect(res.statusCode).toBe(200);
  return res.json();
};

beforeAll(async () => {
  t = await setup();
  const admin = await login(t.app, 'admin@example.com', 'admin-password');
  tenantId = (
    await t.app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: admin,
      payload: {
        name: 'Radio Schermer',
        slug: 'schermer',
        plan: 'distribution',
        limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 100 },
        owner: { email: 'owner@schermer.nl', name: 'Owner', password: 'owner-password' },
      },
    })
  ).json().id;
  owner = await login(t.app, 'owner@schermer.nl', 'owner-password');
  await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/members`, headers: owner, payload: { email: 'dj@schermer.nl', name: 'DJ Schermer', password: 'dj-password-1', role: 'dj' } });
  dj = await login(t.app, 'dj@schermer.nl', 'dj-password-1');
  const st = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Radio Schermer', slug: 'schermer-fm', maxListeners: 50, bitrateKbps: 128 } })).json();
  stationId = st.id;
  const live = st.mounts[0].id;
  const opus = await t.app.inject({
    method: 'POST',
    url: `/api/stations/${stationId}/mounts`,
    headers: owner,
    payload: { path: '/opus', kind: 'transcode', sourceMountId: live, format: 'opus', bitrateKbps: 64, isDefault: true },
  });
  expect(opus.json()).toMatchObject({ isDefault: true });

  // A stand-in for the station's Icecast server: its status page, and a stream on /live for the recorder.
  const [row] = await t.db.select().from(schema.stations).where(eq(schema.stations.id, stationId));
  icecast = http.createServer((req, res) => {
    if (req.url?.startsWith('/admin/stats')) return res.writeHead(200, { 'content-type': 'text/xml' }).end(statsXml());
    if (req.url === '/live') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      const timer = setInterval(() => res.write(Buffer.alloc(4096, 1)), 20);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => icecast.listen(row!.icecastPort, '127.0.0.1', () => r()));
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  icecast?.closeAllConnections();
  await new Promise((r) => (icecast ? icecast.close(r) : r(null)));
  await t.close();
});

describe('helpers', () => {
  it('splits titles and normalises artwork keys', () => {
    expect(splitTitle('Headhunterz - Dragonborn')).toEqual({ artist: 'Headhunterz', title: 'Dragonborn' });
    expect(splitTitle('Jingle')).toEqual({ artist: null, title: 'Jingle' });
    expect(artworkKey('Artist feat. Other - Song (Radio Edit)')).toBe('artist - song');
  });

  it('names recordings after the date and the DJ', () => {
    const b = { sessionId: 'abcdef12-0000', stationId, mountPath: '/live', accountName: 'DJ Hard/Core', startedAt: new Date('2026-10-26T20:05:00Z') };
    expect(recordingFile(b, 'mp3', 'Europe/Amsterdam')).toBe('recordings/2026-10-26_2105_DJ-HardCore_abcdef.mp3');
    expect(recordingTitle(b, 'Europe/Amsterdam')).toBe('2026-10-26 2105 DJ Hard/Core');
  });
});

describe('now playing', () => {
  it('takes the title of the source for a converted default mount', async () => {
    onAir.set('/live', 'Headhunterz - Dragonborn');
    onAir.set('/opus', null);
    await t.db.insert(schema.songPlays).values([
      { stationId, mountPath: '/live', title: 'Older - Song', startedAt: new Date(Date.now() - 600_000), endedAt: new Date(Date.now() - 300_000) },
      { stationId, mountPath: '/live', title: 'Headhunterz - Dragonborn', startedAt: new Date(Date.now() - 60_000) },
    ]);
    const res = await t.app.inject({ url: '/api/public/stations/schermer-fm/nowplaying' });
    expect(res.statusCode).toBe(200);
    const np = res.json();
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(np).toMatchObject({
      onAir: true,
      song: { artist: 'Headhunterz', title: 'Dragonborn', startedAt: expect.any(String) },
      listeners: 6,
      history: [{ text: 'Older - Song' }],
      requests: { enabled: false },
    });
    expect(np.mounts.find((m: { path: string }) => m.path === '/opus')).toMatchObject({ isDefault: true, contentType: 'audio/ogg' });
    // The older status endpoint shows it too.
    expect((await t.app.inject({ url: '/api/public/stations/schermer-fm' })).json().nowPlaying.title).toBe('Headhunterz - Dragonborn');
  });

  it('hides listeners and history when asked, and the whole page when switched off', async () => {
    await settings({ showListeners: false, showHistory: false });
    await t.app.nowPlaying.refresh('schermer-fm', false);
    const np = (await t.app.inject({ url: '/api/public/stations/schermer-fm/nowplaying' })).json();
    expect(np.listeners).toBeNull();
    expect(np.history).toEqual([]);
    await settings({ enabled: false });
    await t.app.nowPlaying.refresh('schermer-fm', false);
    expect((await t.app.inject({ url: '/api/public/stations/schermer-fm/nowplaying' })).statusCode).toBe(404);
    await settings({ enabled: true, showListeners: true, showHistory: true });
    await t.app.nowPlaying.refresh('schermer-fm', false);
  });

  it('lists recently played titles', async () => {
    const res = await t.app.inject({ url: '/api/public/stations/schermer-fm/history?limit=5' });
    expect(res.json().items).toEqual([expect.objectContaining({ artist: 'Older', title: 'Song', playedAt: expect.any(String) })]);
  });

  it('pushes changes over Server-Sent Events', async () => {
    const res = await fetch(`${base}/api/public/stations/schermer-fm/events`);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let text = '';
    const next = async () => {
      while (!/event: nowplaying\ndata: .*\n\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
      const m = text.match(/event: nowplaying\ndata: (.*)\n\n/)!;
      text = text.slice(m.index! + m[0].length);
      return JSON.parse(m[1]!);
    };
    expect((await next()).song.title).toBe('Dragonborn');
    onAir.set('/live', 'Brennan Heart - Imaginary');
    t.app.nowPlaying.notify(stationId);
    expect((await next()).song).toMatchObject({ artist: 'Brennan Heart', title: 'Imaginary' });
    await reader.cancel();
  });

  it('pushes changes over WebSocket', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/public/ws?station=schermer-fm`);
    const messages: { type: string; station: string; data: { song: { title: string } } }[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    await expect.poll(() => messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatchObject({ type: 'nowplaying', station: 'schermer-fm', data: { song: { title: 'Imaginary' } } });
    onAir.set('/live', 'Da Tweekaz - Jägermeister');
    t.app.nowPlaying.notify(stationId);
    await expect.poll(() => messages.at(-1)?.data.song.title).toBe('Jägermeister');
    ws.close();
  });

  it('fills in the page preview for social media', async () => {
    const html = await renderPublicShell(t.ctx, '<html><head><title>x</title></head></html>', 'schermer-fm', false);
    expect(html).toContain('<title>Radio Schermer</title>');
    expect(html).toContain('og:url" content="http://localhost:8000/public/schermer-fm"');
    expect(await renderPublicShell(t.ctx, '<title>x</title>', 'unknown', false)).toBe('<title>x</title>');
  });
});

describe('logo', () => {
  it('stores a logo and serves it', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const bad = await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/public/logo`, headers: owner, payload: { image: 'data:image/png;base64,aGVsbG8=' } });
    expect(bad.statusCode).toBe(400);
    const res = await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/public/logo`, headers: owner, payload: { image: `data:image/png;base64,${png.toString('base64')}` } });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().logoUrl);
    const img = await t.app.inject({ url: url.pathname + url.search });
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.equals(png)).toBe(true);
    expect((await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/public/logo`, headers: dj, payload: { image: 'x' } })).statusCode).toBe(403);
  });
});

describe('song requests', () => {
  const send = (body: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/public/stations/schermer-fm/requests', payload: body, remoteAddress: '198.51.100.7' });

  it('refuses requests until the station takes them', async () => {
    expect((await send({ artist: 'A', title: 'B' })).json().error.code).toBe('requests_off');
    await settings({ requests: { enabled: true, onlyWhenLive: true, perHour: 2, message: 'Shout out!' } });
    await t.app.nowPlaying.refresh('schermer-fm', false);
    expect((await send({ artist: 'A', title: 'B' })).json().error.code).toBe('requests_closed');
  });

  it('takes requests, limits them per listener and ignores bots', async () => {
    await settings({ requests: { enabled: true, onlyWhenLive: false, perHour: 2, message: '' } });
    await t.app.nowPlaying.refresh('schermer-fm', false);
    expect((await send({ artist: 'Headhunterz', title: 'Orange Heart', name: 'Kim', message: 'Groetjes!' })).statusCode).toBe(200);
    expect((await send({ artist: 'x', title: 'y', website: 'http://spam' })).json()).toEqual({ ok: true, id: null });
    expect((await send({ artist: 'Wildstylez', title: 'Year of Summer' })).statusCode).toBe(200);
    expect((await send({ artist: 'One', title: 'Too many' })).statusCode).toBe(429);
  });

  it('shows requests to the DJ, who handles them', async () => {
    const list = (await t.app.inject({ url: `/api/stations/${stationId}/requests`, headers: dj })).json();
    expect(list.pending).toBe(2);
    expect(list.items.map((r: { title: string }) => r.title)).toEqual(['Year of Summer', 'Orange Heart']);
    const id = list.items[1].id;
    const played = await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}/requests/${id}`, headers: dj, payload: { status: 'played' } });
    expect(played.json()).toMatchObject({ status: 'played', handledBy: 'DJ Schermer' });
    expect((await t.app.inject({ url: `/api/stations/${stationId}/requests?status=handled`, headers: dj })).json().items).toHaveLength(1);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/stations/${stationId}/requests`, headers: dj })).json()).toEqual({ removed: 1 });
  });
});

describe('on demand', () => {
  let itemId: string;

  it('publishes files from the ondemand folder', async () => {
    const dir = join(mediaDir(t.ctx, stationId), 'ondemand', 'shows');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'Friday_Night_Show.mp3');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=2', '-metadata', 'title=Friday Night', '-metadata', 'artist=DJ Kim', '-y', file]);
    // A file that is still being uploaded waits.
    await scanOnDemand(t.ctx, stationId);
    expect((await t.app.inject({ url: `/api/stations/${stationId}/ondemand`, headers: owner })).json().items).toHaveLength(0);
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    await scanOnDemand(t.ctx, stationId);
    const items = (await t.app.inject({ url: `/api/stations/${stationId}/ondemand`, headers: owner })).json().items;
    expect(items).toEqual([expect.objectContaining({ source: 'upload', file: 'ondemand/shows/Friday_Night_Show.mp3', title: 'DJ Kim - Friday Night', durationSeconds: 2, publishedAt: expect.any(String) })]);
    itemId = items[0].id;
  });

  it('lists published items only when on-demand is on, and streams them with ranges', async () => {
    expect((await t.app.inject({ url: '/api/public/stations/schermer-fm/ondemand' })).json()).toEqual({ items: [], total: 0 });
    await settings({ onDemand: { enabled: true } });
    const list = (await t.app.inject({ url: '/api/public/stations/schermer-fm/ondemand' })).json();
    expect(list.total).toBe(1);
    const url = new URL(list.items[0].audioUrl);
    const part = await t.app.inject({ url: url.pathname, headers: { range: 'bytes=0-99' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toMatch(/^bytes 0-99\/\d+$/);
    expect(part.rawPayload.length).toBe(100);
    await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}/ondemand/${itemId}`, headers: owner, payload: { published: false, title: 'Friday' } });
    expect((await t.app.inject({ url: '/api/public/stations/schermer-fm/ondemand' })).json().total).toBe(0);
    expect((await t.app.inject({ url: url.pathname })).statusCode).toBe(404);
    // The panel can still play the draft.
    expect((await t.app.inject({ url: `/api/stations/${stationId}/ondemand/${itemId}/audio`, headers: dj })).statusCode).toBe(200);
  });

  it('deletes an item with its file', async () => {
    expect((await t.app.inject({ method: 'DELETE', url: `/api/stations/${stationId}/ondemand/${itemId}`, headers: dj })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/stations/${stationId}/ondemand/${itemId}`, headers: owner })).statusCode).toBe(200);
    await expect(stat(join(mediaDir(t.ctx, stationId), 'ondemand/shows/Friday_Night_Show.mp3'))).rejects.toThrow();
  });

  it('records a live broadcast and keeps it as a draft', async () => {
    await settings({ recording: { enabled: true, autoPublish: false, keepDays: 30, minMinutes: 0 } });
    const snap = await loadSnapshot(t.ctx);
    const view = snap.stations.get(stationId)!;
    const mount = view.mounts.find((m) => m.path === '/live')!;
    const [session] = await t.db.insert(schema.liveSessions).values({ stationId, mountId: mount.id, mountPath: '/live', accountName: 'DJ Schermer', via: 'plain' }).returning();
    const rec = new Recorder(t.ctx, view, mount, { sessionId: session!.id, stationId, mountPath: '/live', accountName: 'DJ Schermer', startedAt: session!.startedAt }, 10 * 1024 * 1024, pino({ level: 'silent' }) as never);
    rec.start();
    await expect.poll(() => rec.state.state).toBe('connected');
    await new Promise((r) => setTimeout(r, 300));
    const during = (await t.app.inject({ url: `/api/stations/${stationId}/ondemand`, headers: owner })).json().items;
    expect(during).toEqual([expect.objectContaining({ source: 'recording', recording: true, host: 'DJ Schermer' })]);
    rec.stop();
    await rec.finishing;
    const [item] = (await t.app.inject({ url: `/api/stations/${stationId}/ondemand`, headers: owner })).json().items;
    expect(item).toMatchObject({ recording: false, publishedAt: null, sizeBytes: expect.any(Number) });
    expect(item.sizeBytes).toBeGreaterThan(4096);
    expect((await readFile(join(mediaDir(t.ctx, stationId), item.file))).length).toBe(item.sizeBytes);
  });
});
