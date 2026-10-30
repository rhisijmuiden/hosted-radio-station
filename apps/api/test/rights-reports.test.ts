import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { splitTitle } from '../src/services/reports/rights.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let owner: { cookie: string };
let dj: { cookie: string };
let stationId: string;

// 2026-10-12 is in summer time in Amsterdam: 20:00Z = 22:00 local.
const at = (hhmmss: string) => new Date(`2026-10-12T${hhmmss}Z`);

beforeAll(async () => {
  t = await setup();
  const admin = await login(t.app, 'admin@example.com', 'admin-password');
  const tenant = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: { name: 'Rights FM', slug: 'rightsfm', plan: 'station', owner: { email: 'owner@rights.fm', name: 'Owner', password: 'owner-password' } },
  });
  owner = await login(t.app, 'owner@rights.fm', 'owner-password');
  await t.app.inject({ method: 'POST', url: `/api/tenants/${tenant.json().id}/members`, headers: owner, payload: { email: 'dj@rights.fm', name: 'DJ', password: 'dj-password-1', role: 'dj' } });
  dj = await login(t.app, 'dj@rights.fm', 'dj-password-1');
  stationId = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId: tenant.json().id, name: 'Rights FM', slug: 'rights-fm' } })).json().id;

  await t.db.insert(schema.mediaFiles).values([
    { stationId, location: 'storage', path: 'a.mp3', title: 'Song A', artist: 'Band', composer: 'J. Writer / K. Lyric', label: 'Indie Records', album: 'First', isrc: 'NLA1R2400123', code: 'RF-00001', durationSeconds: 200 },
    { stationId, location: 'storage', path: 'jingle.mp3', title: 'Station ID', artist: 'Rights FM', durationSeconds: 8 },
  ]);
  await t.db.insert(schema.songPlays).values([
    // The AutoDJ plays Song A on two source mounts at once: one play.
    { stationId, mountPath: '/live', title: 'Band - Song A', startedAt: at('20:00:00'), endedAt: at('20:03:20'), listenersStart: 10, listenersPeak: 12 },
    { stationId, mountPath: '/mobile', title: 'Band - Song A', startedAt: at('20:00:02'), endedAt: at('20:03:22'), listenersStart: 3, listenersPeak: 3 },
    { stationId, mountPath: '/live', title: 'Rights FM - Station ID', startedAt: at('20:03:20'), endedAt: at('20:03:28') },
    // A DJ plays something that is not in the library, and Song A again.
    { stationId, mountPath: '/live', title: 'Other Artist - Live Track', startedAt: at('21:00:10'), endedAt: at('21:04:10'), listenersPeak: 20 },
    { stationId, mountPath: '/live', title: 'band - song a', startedAt: at('21:04:10'), endedAt: at('21:07:30') },
    // The next day in Amsterdam (00:30 local): outside a report of the 12th.
    { stationId, mountPath: '/live', title: 'Band - Song A', startedAt: at('22:30:00'), endedAt: at('22:33:20') },
  ]);
  await t.db.insert(schema.liveSessions).values([
    { stationId, mountPath: '/live', accountName: 'DJ Kim', via: 'tls', startedAt: at('21:00:00'), endedAt: at('21:30:00') },
    // An encoder that sent no titles: one line for the whole broadcast.
    { stationId, mountPath: '/live', accountName: 'DJ Quiet', via: 'tls', startedAt: at('21:40:00'), endedAt: at('21:55:00') },
  ]);
  await t.db.insert(schema.listenerSamples).values([0, 1, 2, 3].map((m) => ({ at: new Date(at('20:00:00').getTime() + m * 60_000), stationId, target: '*', avg: 30, peak: 40 })));
});
afterAll(() => t.close());

describe('rights reports (phase 21 step 5)', () => {
  it('splits stream titles', () => {
    expect(splitTitle('Band - Song - Remix')).toEqual({ artist: 'Band', title: 'Song - Remix' });
    expect(splitTitle('Just a title')).toEqual({ artist: '', title: 'Just a title' });
  });

  it('lists every music play of the days asked, in the station time, with makers and listeners', async () => {
    const res = await t.app.inject({ url: `/api/stations/${stationId}/reports/plays?from=2026-10-12&to=2026-10-12`, headers: owner });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.map((p: { time: string; title: string; source: string }) => [p.time, p.title, p.source])).toEqual([
      ['22:00:00', 'Song A', 'autodj'],
      ['23:00:10', 'Live Track', 'live'],
      ['23:04:10', 'Song A', 'live'],
      ['23:40:00', 'Live broadcast without titles', 'live'],
    ]);
    expect(items[3]).toMatchObject({ dj: 'DJ Quiet', durationSeconds: 900 });
    expect(items[0]).toMatchObject({ date: '2026-10-12', durationSeconds: 200, artist: 'Band', composer: 'J. Writer / K. Lyric', label: 'Indie Records', isrc: 'NLA1R2400123', code: 'RF-00001', mount: '/live', peakListeners: 40, listenerHours: 2 });
    expect(items[1]).toMatchObject({ artist: 'Other Artist', isrc: '', dj: 'DJ Kim', peakListeners: 20 });
    // Jingles are in with a lower minimum.
    const all = (await t.app.inject({ url: `/api/stations/${stationId}/reports/plays?from=2026-10-12&to=2026-10-12&minSeconds=0`, headers: owner })).json().items;
    expect(all.map((p: { title: string }) => p.title)).toContain('Station ID');
  });

  it('counts the plays per recording', async () => {
    const items = (await t.app.inject({ url: `/api/stations/${stationId}/reports/tracks?from=2026-10-12&to=2026-10-13`, headers: owner })).json().items;
    expect(items.map((x: { title: string; plays: number; totalSeconds: number }) => [x.title, x.plays, x.totalSeconds])).toEqual([
      ['Song A', 3, 600],
      ['Live Track', 1, 240],
    ]);
  });

  it('downloads both as CSV, for managers only', async () => {
    const csv = await t.app.inject({ url: `/api/stations/${stationId}/reports/plays.csv?from=2026-10-12&to=2026-10-12`, headers: owner });
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="rights-fm_plays_2026-10-12_2026-10-12.csv"');
    const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^"date","time","duration","duration_seconds","artist","title","composer"/);
    expect(lines[1]).toContain('"2026-10-12","22:00:00","3:20","200","Band","Song A","J. Writer / K. Lyric"');
    const tracks = await t.app.inject({ url: `/api/stations/${stationId}/reports/tracks.csv?from=2026-10-12&to=2026-10-12`, headers: owner });
    expect(tracks.body).toContain('"Band","Song A","J. Writer / K. Lyric","First","Indie Records","NLA1R2400123","RF-00001","2"');
    expect((await t.app.inject({ url: `/api/stations/${stationId}/reports/plays.csv?from=2026-10-12&to=2026-10-12`, headers: dj })).statusCode).toBe(403);
    expect((await t.app.inject({ url: `/api/stations/${stationId}/reports/plays?from=2026-10-12&to=2026-10-01`, headers: owner })).statusCode).toBe(400);
  });
});
