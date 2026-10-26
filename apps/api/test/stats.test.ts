import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { rollupHourly } from '../src/services/stats/maintenance.js';
import { listenerHash, referrerHost, shortenIp } from '../src/services/stats/privacy.js';
import { classifyClient } from '../src/services/stats/useragent.js';
import { parseClients, renderIcecastConfig, type MountStats } from '../src/services/streaming/icecast.js';
import { ListenerCollector } from '../src/streams/collector.js';
import { loadSnapshot, type Snapshot } from '../src/streams/snapshot.js';
import { login, setup } from './helpers.js';

const HOOK_PORT = 18998;
let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let owner: { cookie: string };
let other: { cookie: string };
let tenantId: string;
let stationId: string;
let snap: Snapshot;
let collector: ListenerCollector;

const hook = (path: string, body: Record<string, string>) =>
  fetch(`http://127.0.0.1:${HOOK_PORT}/icecast/${stationId}/${path}`, { method: 'POST', body: new URLSearchParams(body) });

const mountStats = (mount: string, listeners: number, title: string | null = null): MountStats => ({
  mount,
  listeners,
  listenerPeak: listeners,
  title,
  bitrateKbps: 128,
  contentType: 'audio/mpeg',
  sourceIp: null,
  userAgent: null,
  streamStart: null,
  bytesRead: 0,
  bytesSent: 0,
});

beforeAll(async () => {
  t = await setup({ LISTENER_HOOK_PORT: String(HOOK_PORT) });
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const mk = async (slug: string, email: string) =>
    (
      await t.app.inject({
        method: 'POST',
        url: '/api/tenants',
        headers: admin,
        payload: {
          name: slug,
          slug,
          plan: 'distribution',
          limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 1 },
          owner: { email, name: 'Owner', password: 'owner-password' },
        },
      })
    ).json().id as string;
  tenantId = await mk('schermer', 'owner@schermer.nl');
  await mk('other', 'owner@other.nl');
  owner = await login(t.app, 'owner@schermer.nl', 'owner-password');
  other = await login(t.app, 'owner@other.nl', 'owner-password');
  const res = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Radio Schermer', slug: 'schermer-fm', maxListeners: 50, bitrateKbps: 128 } });
  stationId = res.json().id;
  snap = await loadSnapshot(t.ctx);
  collector = new ListenerCollector(t.ctx, pino({ level: 'silent' }), () => snap);
  await collector.start();
});
afterAll(async () => {
  await collector.stop();
  await t.close();
});

describe('helpers', () => {
  it('recognises players and devices', () => {
    expect(classifyClient('VLC/3.0.20 LibVLC/3.0.20')).toMatchObject({ player: 'VLC', device: 'desktop' });
    expect(classifyClient('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toMatchObject({
      player: 'Safari',
      device: 'mobile',
      os: 'iOS',
    });
    expect(classifyClient('Sonos/80.1-55014 (ZPS1)')).toMatchObject({ player: 'Sonos', device: 'speaker' });
    expect(classifyClient('AlexaMediaPlayer/2.1.4676.0 (Linux;Android 5.1.1)')).toMatchObject({ player: 'Amazon Alexa', device: 'speaker' });
    expect(classifyClient('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toMatchObject({ player: 'Edge', os: 'Windows', device: 'desktop' });
    expect(classifyClient('curl/8.5.0').device).toBe('bot');
    expect(classifyClient(null)).toMatchObject({ player: 'Unknown' });
  });

  it('shortens addresses and hashes listeners', () => {
    expect(shortenIp('203.0.113.77')).toBe('203.0.113.0');
    expect(shortenIp('::ffff:198.51.100.9')).toBe('198.51.100.0');
    expect(shortenIp('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::');
    expect(shortenIp('2001:db8::1')).toBe('2001:db8:0::');
    expect(listenerHash('s', '203.0.113.77', 'VLC')).toBe(listenerHash('s', '203.0.113.77', 'VLC'));
    expect(listenerHash('s', '203.0.113.77', 'VLC')).not.toBe(listenerHash('s', '203.0.113.78', 'VLC'));
    expect(referrerHost('https://www.harder.fm/player?x=1')).toBe('harder.fm');
    expect(referrerHost('nonsense')).toBeNull();
  });

  it('parses Icecast client lists', () => {
    const xml =
      '<?xml version="1.0"?><icestats><source mount="/live"><Listeners>2</Listeners><listener><IP>127.0.0.1</IP><UserAgent>VLC/3.0</UserAgent><Connected>12</Connected><ID>4</ID></listener><listener><IP>127.0.0.1</IP><UserAgent>Hosted Radio Station relay</UserAgent><Connected>99</Connected><ID>5</ID></listener></source></icestats>';
    expect(parseClients(xml)).toEqual([
      { id: '4', ip: '127.0.0.1', userAgent: 'VLC/3.0', connectedSeconds: 12 },
      { id: '5', ip: '127.0.0.1', userAgent: 'Hosted Radio Station relay', connectedSeconds: 99 },
    ]);
  });

  it('adds the listener hooks to icecast.xml only when asked', async () => {
    const view = snap.stations.get(stationId)!;
    const base = { station: view.station, mounts: view.mounts, hostname: 'radio.example.com', adminPassword: 'a', sourcePassword: 'b', internalClients: 2 };
    expect(renderIcecastConfig(t.ctx, base)).not.toContain('listener_add');
    const xml = renderIcecastConfig(t.ctx, { ...base, listenerHook: 'http://127.0.0.1:8099' });
    expect(xml).toContain(`<option name="listener_add" value="http://127.0.0.1:8099/icecast/${stationId}/add" />`);
    expect(xml).toContain('<option name="headers" value="x-hrs-client,x-hrs-via,referer" />');
  });
});

describe('listener sessions', () => {
  it('records a listener from the hooks with a shortened address', async () => {
    const res = await hook('add', {
      action: 'listener_add',
      client: '7',
      mount: '/live?type=.mp3',
      ip: '127.0.0.1',
      agent: 'VLC/3.0.20 LibVLC/3.0.20',
      'h_x-hrs-client': '203.0.113.77',
      h_referer: 'https://www.schermer.nl/luister',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('icecast-auth-user')).toBe('1');
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await t.db.select().from(schema.listenerSessions).where(eq(schema.listenerSessions.stationId, stationId));
    expect(row).toMatchObject({ mountPath: '/live', via: 'web', ip: '203.0.113.0', device: 'desktop', player: 'VLC', referrer: 'schermer.nl', endedAt: null, tenantId });
    expect(row!.listenerHash).toBeTruthy();
  });

  it('ignores our own relays and lets every listener in', async () => {
    const res = await hook('add', { action: 'listener_add', client: '8', mount: '/live', agent: 'Hosted Radio Station transcoder' });
    expect(res.headers.get('icecast-auth-user')).toBe('1');
    const rows = await t.db.select().from(schema.listenerSessions).where(eq(schema.listenerSessions.stationId, stationId));
    expect(rows).toHaveLength(1);
  });

  it('closes the session on disconnect', async () => {
    await hook('remove', { action: 'listener_remove', client: '7', mount: '/live', duration: '30' });
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await t.db.select().from(schema.listenerSessions).where(eq(schema.listenerSessions.stationId, stationId));
    expect(row!.endedAt).toBeInstanceOf(Date);
    expect(row!.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('stores listener counts per minute and plays per title', async () => {
    const view = snap.stations.get(stationId)!;
    await collector.observe(view, new Map([['/live', mountStats('/live', 4, 'Artist - Song A')]]), {});
    await collector.observe(view, new Map([['/live', mountStats('/live', 6, 'Artist - Song A')]]), {});
    collector.setExternalCount(stationId, '00000000-0000-4000-8000-000000000001', 2);
    await collector.observe(view, new Map([['/live', mountStats('/live', 5, 'Artist - Song B')]]), {});
    await collector.flush(true);
    const samples = await t.db.select().from(schema.listenerSamples).where(eq(schema.listenerSamples.stationId, stationId));
    const total = samples.find((s) => s.target === '*')!;
    expect(total.peak).toBe(7);
    expect(total.avg).toBeCloseTo((4 + 6 + 7) / 3);
    expect(samples.find((s) => s.target === 'mount:/live')!.peak).toBe(6);
    const plays = await t.db.select().from(schema.songPlays).where(eq(schema.songPlays.stationId, stationId));
    expect(plays.map((p) => p.title).sort()).toEqual(['Artist - Song A', 'Artist - Song B']);
    expect(plays.find((p) => p.title === 'Artist - Song A')).toMatchObject({ listenersStart: 4, listenersPeak: 6, listenersEnd: 7 });
    await rollupHourly(t.ctx, new Date(Date.now() - 3600_000));
    const hourly = await t.db.select().from(schema.listenerHourly).where(eq(schema.listenerHourly.stationId, stationId));
    expect(hourly.find((h) => h.target === '*')).toMatchObject({ peak: 7, minutes: 1 });
  });
});

describe('reports', () => {
  const period = () => {
    const to = new Date(Date.now() + 60_000);
    const from = new Date(to.getTime() - 86400_000);
    return `from=${from.toISOString()}&to=${to.toISOString()}&tz=Europe/Amsterdam`;
  };

  it('reports a station for its owner', async () => {
    // A session long enough to count.
    await t.db
      .update(schema.listenerSessions)
      .set({ startedAt: new Date(Date.now() - 600_000), endedAt: new Date(Date.now() - 300_000), durationSeconds: 300, country: 'NL', city: 'IJmuiden', latitude: 52.46, longitude: 4.61 })
      .where(eq(schema.listenerSessions.stationId, stationId));
    const res = await t.app.inject({ url: `/api/stats/report?stationId=${stationId}&${period()}`, headers: owner });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.kpis).toMatchObject({ sessions: 1, uniqueListeners: 1, peakListeners: 7, avgSessionSeconds: 300, countries: 1 });
    expect(r.countries).toEqual([{ key: 'NL', sessions: 1, listeners: 1, hours: 0.1 }]);
    expect(r.players[0]).toMatchObject({ key: 'VLC' });
    expect(r.places[0]).toMatchObject({ city: 'IJmuiden', lat: 52.46 });
    expect(r.timeseries.points.length).toBeGreaterThan(0);
    expect(r.durations.find((d: { fromSeconds: number }) => d.fromSeconds === 300).sessions).toBe(1);
    expect(r.heatmap.length).toBeGreaterThan(0);
  });

  it('lists songs, sessions and exports CSV', async () => {
    const prog = await t.app.inject({ url: `/api/stats/programme?stationId=${stationId}&${period()}`, headers: owner });
    expect(prog.json().plays).toHaveLength(2);
    const sessions = await t.app.inject({ url: `/api/stats/sessions?stationId=${stationId}&${period()}`, headers: owner });
    expect(sessions.json()[0]).toMatchObject({ stationName: 'Radio Schermer', city: 'IJmuiden', ip: '203.0.113.0' });
    const csv = await t.app.inject({ url: `/api/stats/export.csv?kind=countries&stationId=${stationId}&${period()}`, headers: owner });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('"NL","1","1","0.1"');
  });

  it('keeps other customers out', async () => {
    const res = await t.app.inject({ url: `/api/stats/report?stationId=${stationId}&${period()}`, headers: other });
    expect(res.statusCode).toBe(403);
    const list = await t.app.inject({ url: '/api/stats/stations', headers: other });
    expect(list.json()).toEqual([]);
    const mine = await t.app.inject({ url: '/api/stats/stations', headers: owner });
    expect(mine.json()).toEqual([expect.objectContaining({ id: stationId, mounts: ['/live'] })]);
  });

  it('shows live listeners', async () => {
    const res = await t.app.inject({ url: '/api/stats/live', headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 0, stations: expect.arrayContaining([expect.objectContaining({ id: stationId })]) });
  });

  it('keeps the settings for administrators', async () => {
    const res = await t.app.inject({ url: '/api/stats/settings', headers: owner });
    expect(res.statusCode).toBe(403);
    const get = await t.app.inject({ url: '/api/stats/settings', headers: admin });
    const body = { ...get.json(), anonymizeIps: false, geoip: { ...get.json().geoip, provider: 'dbip', maxmindLicenseKey: 'secret' } };
    const put = await t.app.inject({ method: 'PUT', url: '/api/stats/settings', headers: admin, payload: body });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ anonymizeIps: false, geoip: { maxmindLicenseKey: '••••••••' } });
  });
});
