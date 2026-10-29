import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db/index.js';
import type { ClockItem } from '../src/db/schema.js';
import { scanLibrary } from '../src/services/autodj/library.js';
import { fetchNews, isFresh, newsTick, openNews, readNewsStatus, remotePathFor, sealNews } from '../src/services/autodj/news.js';
import { nextTrack, playerStarted, trackStarted } from '../src/services/autodj/planner.js';
import { zonedInstant } from '../src/services/scheduler/time.js';
import { SECRET_MASK } from '../src/services/settings.js';
import { mediaDir } from '../src/services/streaming/icecast.js';
import type { Station } from '../src/services/streaming/state.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let dj: { cookie: string };
let stationId: string;
let server: http.Server;
let base: string;
/** What the test news server answers: a file and its time, or an error. */
let serve: { file: string | null; modified: Date };

const TZ = 'Europe/Amsterdam';
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const local = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return zonedInstant(date, h * 60 + m, TZ);
};
const item = (p: Partial<ClockItem> & Pick<ClockItem, 'kind'>): ClockItem => ({ id: Math.random().toString(36).slice(2), label: '', playlistId: null, mediaId: null, count: 1, at: null, hard: false, ...p });
const api = (method: string, url: string, payload?: unknown, headers = admin) =>
  t.app.inject({ method: method as 'GET', url: `/api/stations/${stationId}${url}`, headers, payload: payload as never });
const station = async () => (await t.db.select().from(schema.stations).where(eq(schema.stations.id, stationId)))[0] as Station;
const tone = (path: string, tags: Record<string, string>, seconds = 2) => {
  mkdirSync(join(path, '..'), { recursive: true });
  const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...meta, '-b:a', '64k', path]);
};

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const tenant = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: {
      name: 'Harder FM',
      slug: 'harder',
      plan: 'station',
      limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 100 },
      owner: { email: 'owner@harder.fm', name: 'Owner', password: 'owner-password' },
    },
  });
  stationId = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId: tenant.json().id, name: 'Harder.FM', slug: 'harderfm', bitrateKbps: 128 } })).json().id;
  expect((await api('POST', '/upgrade', {})).statusCode).toBe(200);
  await t.app.inject({ method: 'POST', url: `/api/tenants/${tenant.json().id}/members`, headers: admin, payload: { email: 'dj@harder.fm', name: 'DJ', password: 'dj-password-1', role: 'dj' } });
  dj = await login(t.app, 'dj@harder.fm', 'dj-password-1');
  serve = { file: null, modified: new Date() };
  server = http.createServer((req, res) => {
    if (!serve.file || !req.url?.startsWith('/news/')) {
      res.writeHead(404).end('not here');
      return;
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'last-modified': serve.modified.toUTCString() }).end(readFileSync(serve.file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  server?.close();
  await t?.close();
});

describe('news settings', () => {
  it('puts the time of the news in the file name', () => {
    const slot = local('2026-10-29', '08:00');
    expect(remotePathFor('news/{YYYY}{MM}{DD}-{HH}{mm}.mp3', slot, TZ)).toBe('news/20261029-0800.mp3');
  });

  it('keeps the password sealed, masked in the panel and unchanged when it comes back masked', async () => {
    const res = await api('PUT', '/news', { enabled: false, source: 'sftp', host: 'news.example.com', username: 'harder', password: 'secret-1', path: 'news/latest.mp3' });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.password).toBe(SECRET_MASK);
    const stored = (await station()).news;
    expect(stored.password).not.toBe('secret-1');
    expect(openNews(t.ctx.box, stored).password).toBe('secret-1');
    await api('PUT', '/news', { ...res.json().settings, port: 2222 });
    const again = (await station()).news;
    expect(again.password).toBe(stored.password);
    expect(sealNews(t.ctx.box, { password: SECRET_MASK }, again).password).toBe(stored.password);
    expect((await api('PUT', '/news', { enabled: true, source: 'url', url: '' })).statusCode).toBe(400);
    expect((await api('PUT', '/news', { enabled: false, source: 'url', url: '' }, dj)).statusCode).toBe(403);
    expect((await api('GET', '/news', undefined, dj)).statusCode).toBe(200);
  });

  it('accepts a News item in the hour clocks', async () => {
    const res = await api('POST', '/clocks', { name: 'News clock', items: [item({ kind: 'news', at: 0, hard: true, locked: true }), item({ kind: 'rotation' })] });
    expect(res.statusCode).toBe(201);
    expect(res.json().items[0]).toMatchObject({ kind: 'news', locked: true });
  });
});

describe.runIf(hasFfmpeg)('news bulletin', () => {
  let fallbackId: string;
  let bulletin: string;

  beforeAll(async () => {
    const dir = mediaDir(t.ctx, stationId);
    tone(join(dir, 'music', 'songs', 's1.mp3'), { artist: 'A', title: 'Song 1' });
    tone(join(dir, 'music', 'songs', 's2.mp3'), { artist: 'B', title: 'Song 2' });
    tone(join(dir, 'music', 'jingles', 'spare.mp3'), { artist: 'Station', title: 'Spare news jingle' });
    bulletin = join(dir, '..', 'bulletin-source.mp3');
    tone(bulletin, { title: 'ANP' }, 3);
    await scanLibrary(t.ctx, stationId);
    fallbackId = (await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.title, 'Spare news jingle')))[0]!.id;
    const settings = (await api('GET', '/autodj')).json().settings;
    await api('PUT', '/autodj', { ...settings, crossfadeSeconds: 0, artistSeparationMinutes: 0, trackSeparationMinutes: 0 });
    const view = (await api('GET', '/scheduler')).json();
    const clock = view.clocks.find((c: { name: string }) => c.name === 'News clock');
    await api('PUT', '/scheduler', { ...view.settings, enabled: true, timezone: TZ, defaultClockId: clock.id });
    const saved = await api('PUT', '/news', { enabled: true, name: 'ANP News', source: 'url', url: `${base}/news/{HH}.mp3`, leadMinutes: 5, maxAgeMinutes: 30, fallbackMediaId: fallbackId });
    expect(saved.statusCode).toBe(200);
  });

  it('fetches the bulletin in the minutes before the news, keeps it out of the library and plays it locked', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Too early: nothing is fetched yet.
    vi.setSystemTime(local('2026-10-29', '07:50'));
    await newsTick(t.ctx);
    expect((await readNewsStatus(t.ctx, stationId)).lastAttemptAt).toBeNull();
    // In the lead time, but the provider has nothing yet: tried, error kept.
    vi.setSystemTime(local('2026-10-29', '07:56'));
    await newsTick(t.ctx);
    expect((await readNewsStatus(t.ctx, stationId)).error).toMatch(/404/);
    serve = { file: bulletin, modified: new Date(local('2026-10-29', '07:55')) };
    vi.setSystemTime(local('2026-10-29', '07:57'));
    await newsTick(t.ctx);
    const status = await readNewsStatus(t.ctx, stationId);
    expect(status).toMatchObject({ error: null, slot: new Date(local('2026-10-29', '08:00')).toISOString() });
    expect(status.durationSeconds).toBeGreaterThan(2.5);
    expect(isFresh(status, { maxAgeMinutes: 30 }, local('2026-10-29', '08:00'))).toBe(true);
    const [row] = await t.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, status.mediaId!));
    expect(row).toMatchObject({ location: 'news', enabled: false, title: 'ANP News 08:00' });
    const lib = (await api('GET', '/library?enabled=all')).json();
    expect(lib.items.some((i: { location: string }) => i.location === 'news')).toBe(false);
    // RHIS Studio sees the news time, and the bulletin plays through the library audio route.
    const news = (await api('GET', '/news', undefined, dj)).json();
    expect(news.slots[0]).toMatchObject({ at: new Date(local('2026-10-29', '08:00')).toISOString(), fresh: true });
    expect(news.fallback).toMatchObject({ id: fallbackId, title: 'Spare news jingle' });
    expect((await api('GET', `/library/${status.mediaId}/audio`, undefined, dj)).statusCode).toBe(200);
    const rundown = (await api('GET', '/autodj/rundown?hours=2')).json();
    expect(rundown.rows.find((r: { source: string }) => r.source === 'news')).toMatchObject({ label: 'ANP News', locked: true, hard: true });

    vi.setSystemTime(local('2026-10-29', '07:59') + 59_000);
    await playerStarted(t.ctx, stationId);
    const next = await nextTrack(t.ctx, stationId);
    await trackStarted(t.ctx, stationId, next!.itemId);
    const playing = (await api('GET', '/autodj')).json().nowPlaying;
    expect(playing).toMatchObject({ label: 'ANP News', locked: true, origin: 'clock' });
    expect(playing.media.id).toBe(status.mediaId);
  });

  it('plays the spare jingle when the bulletin is too old, and swaps in a new one that arrives in time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // The 09:00 news: the provider still has the bulletin of 07:55.
    vi.setSystemTime(local('2026-10-29', '08:56'));
    await newsTick(t.ctx);
    const old = await readNewsStatus(t.ctx, stationId);
    expect(isFresh(old, { maxAgeMinutes: 30 }, local('2026-10-29', '09:00'))).toBe(false);
    vi.setSystemTime(local('2026-10-29', '08:59') + 59_000);
    const next = await nextTrack(t.ctx, stationId);
    const [queued] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.id, next!.itemId));
    expect(queued).toMatchObject({ mediaId: fallbackId, label: 'ANP News', locked: true });
    // A spare jingle that is only waiting in the queue gives way to a fresh bulletin.
    await t.db.update(schema.queueItems).set({ state: 'queued' }).where(eq(schema.queueItems.id, queued!.id));
    serve = { file: bulletin, modified: new Date(local('2026-10-29', '08:58')) };
    const fresh = await fetchNews(t.ctx, await station(), local('2026-10-29', '09:00'));
    const [after] = await t.db.select().from(schema.queueItems).where(eq(schema.queueItems.id, queued!.id));
    expect(after!.mediaId).toBe(fresh.mediaId);
  });

  it('keeps the bulletin it has when a fetch fails, and tells why', async () => {
    const before = await readNewsStatus(t.ctx, stationId);
    serve = { file: null, modified: new Date() };
    const res = await api('POST', '/news/fetch', {});
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toMatchObject({ mediaId: before.mediaId, error: expect.stringMatching(/404/) });
    writeFileSync(join(mediaDir(t.ctx, stationId), '..', 'not-audio.mp3'), 'hello');
    serve = { file: join(mediaDir(t.ctx, stationId), '..', 'not-audio.mp3'), modified: new Date() };
    const bad = await api('POST', '/news/fetch', {});
    expect(bad.json().status.error).toMatch(/not audio/);
    expect(bad.json().status.mediaId).toBe(before.mediaId);
  });
});
