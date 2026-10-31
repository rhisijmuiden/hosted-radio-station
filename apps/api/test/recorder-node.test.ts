import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { parseRange, RECORDING_PART } from '../src/routes/recordings.js';
import { recorderToken } from '../src/services/nodes/delivery.js';
import { buildPlan } from '../src/services/nodes/plan.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let stationId: string;
let otherStation: string;
let recorder: string;
let recorderSecret: string;

async function pair(body: Record<string, unknown>) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: body });
  expect(res.statusCode).toBe(201);
  const { node, pairing } = res.json();
  const p = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code, hostname: 'node-host' } });
  return { id: node.id as string, secret: p.json().secret as string };
}
const nodeRow = async (id: string) => (await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, id)))[0]!;
const report = (recordings: unknown[], id = recorder, secret = recorderSecret) =>
  t.app.inject({ method: 'POST', url: '/api/nodes/agent/report', headers: { authorization: `Node ${id}.${secret}` }, payload: { relays: [], clients: [], probes: [], recordings } });
const logFile = (station: string, hour: number, extra: Record<string, unknown> = {}) => ({
  stationId: station,
  kind: 'log',
  file: `${station}/log/2026-10-29_${String(hour).padStart(2, '0')}-00-00Z_64k.mp3`,
  startedAt: `2026-10-29T${String(hour).padStart(2, '0')}:00:00.000Z`,
  seconds: 3600,
  bytes: 28_800_000,
  open: false,
  ...extra,
});

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const tenant = await t.app.inject({ method: 'POST', url: '/api/tenants', headers: admin, payload: { name: 'Test FM BV', slug: 'testfm', plan: 'station' } });
  stationId = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId: tenant.json().id, name: 'Test FM', slug: 'test-fm' } })).json().id;
  const other = await t.app.inject({ method: 'POST', url: '/api/tenants', headers: admin, payload: { name: 'Other', slug: 'other', plan: 'station' } });
  otherStation = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId: other.json().id, name: 'Other FM', slug: 'other-fm' } })).json().id;
  const r = await pair({ name: 'recorder1', roles: ['recorder'] });
  recorder = r.id;
  recorderSecret = r.secret;
});
afterAll(() => t.close());

describe('recorder node (phase 21)', () => {
  it('records nothing until stations are chosen, then logs their default stream through the listen route', async () => {
    expect((await buildPlan(t.ctx, await nodeRow(recorder))).recorder).toEqual({ stations: [] });
    const res = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${recorder}`, headers: admin, payload: { config: { recordStations: [stationId] } } });
    expect(res.statusCode).toBe(200);
    const plan = await buildPlan(t.ctx, await nodeRow(recorder));
    expect(plan.roles).toEqual(['recorder']);
    expect(plan.relay).toBeNull();
    expect(plan.recorder!.stations).toEqual([
      { stationId, slug: 'test-fm', name: 'Test FM', logging: { url: expect.stringMatching(/\/api\/public\/stations\/test-fm\/listen\/live$/), kbps: 64, days: 31 }, shows: { days: 90, minMinutes: 2, live: [] } },
    ]);
  });

  it('gives logging the stream straight from the ingest node, for while no relay carries the station', async () => {
    const ingest = await pair({ name: 'pub-ingest-01', roles: ['source'] });
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${ingest.id}`, headers: admin, payload: { config: { publicHost: 'ingest1.example.com' } } });
    const online = async (id: string, on: boolean) => {
      const n = await nodeRow(id);
      await t.db.update(schema.nodes).set({ status: { ...n.status, online: on, ip: '192.0.2.10', certs: ['*.example.com'] } }).where(eq(schema.nodes.id, id));
    };
    await online(ingest.id, true);
    // The recorder sits elsewhere: over TLS to the ingest's public name.
    await online(recorder, true);
    await t.db.update(schema.nodes).set({ status: { ...(await nodeRow(recorder)).status, ip: '198.51.100.7' } }).where(eq(schema.nodes.id, recorder));
    const r = await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/routing`, headers: admin, payload: { ingest: ingest.id } });
    expect(r.statusCode).toBe(200);
    const logging = async () => (await buildPlan(t.ctx, await nodeRow(recorder))).recorder!.stations[0]!.logging!;
    const token = recorderToken(t.ctx, await nodeRow(ingest.id), 'test-fm/live');
    expect((await logging()).fallback).toBe(`https://ingest1.example.com:8201/ingest/test-fm/live?token=${token}`);
    // An ingest that is offline has nothing to give.
    await online(ingest.id, false);
    expect((await logging()).fallback).toBeUndefined();
    await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/routing`, headers: admin, payload: { ingest: 'local' } });
    await t.app.inject({ method: 'DELETE', url: `/api/nodes/${ingest.id}`, headers: admin });
  });

  it('follows the station settings, and leaves logging out when it is off', async () => {
    const put = await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/recording`, headers: admin, payload: { loggingKbps: 32, loggingDays: 7 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ logging: true, loggingKbps: 32, loggingDays: 7, shows: true });
    expect((await buildPlan(t.ctx, await nodeRow(recorder))).recorder!.stations[0]!.logging).toMatchObject({ kbps: 32, days: 7 });
    expect((await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/recording`, headers: admin, payload: { loggingKbps: 50 } })).statusCode).toBe(400);
    await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/recording`, headers: admin, payload: { logging: false } });
    expect((await buildPlan(t.ctx, await nodeRow(recorder))).recorder!.stations[0]!.logging).toBeNull();
    await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/recording`, headers: admin, payload: { logging: true, loggingKbps: 64, loggingDays: 31 } });

    const view = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recording`, headers: admin })).json();
    expect(view.recorders).toEqual([expect.objectContaining({ id: recorder, name: 'recorder1', online: false, state: null })]);
    expect((await t.app.inject({ method: 'GET', url: `/api/stations/${otherStation}/recording`, headers: admin })).json().recorders).toEqual([]);
  });

  it('only records the stations a dedicated recorder serves', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${recorder}`, headers: admin, payload: { config: { dedication: 'station', dedicatedStationId: stationId, recordStations: [stationId, otherStation] } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/can only record the stations it is dedicated to/);
    const ok = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${recorder}`, headers: admin, payload: { config: { dedication: 'station', dedicatedStationId: stationId, recordStations: 'all' } } });
    expect(ok.statusCode).toBe(200);
    expect((await buildPlan(t.ctx, await nodeRow(recorder))).recorder!.stations.map((s) => s.stationId)).toEqual([stationId]);
  });

  it('keeps the list of files the recorder has, without files of stations it does not serve', async () => {
    expect((await report([logFile(stationId, 20), logFile(stationId, 21, { open: true, seconds: 600, bytes: 4_800_000 }), logFile(otherStation, 20)])).statusCode).toBe(200);
    let rows = await t.db.select().from(schema.recordings).where(eq(schema.recordings.nodeId, recorder));
    expect(rows.map((r) => r.file).sort()).toEqual([logFile(stationId, 20).file, logFile(stationId, 21).file]);
    // A report without the list changes nothing; a list without a file removes it.
    await t.app.inject({ method: 'POST', url: '/api/nodes/agent/report', headers: { authorization: `Node ${recorder}.${recorderSecret}` }, payload: { relays: [], clients: [], probes: [] } });
    expect(await t.db.select().from(schema.recordings).where(eq(schema.recordings.nodeId, recorder))).toHaveLength(2);
    await report([logFile(stationId, 21, { seconds: 3600, bytes: 28_800_000 }), logFile(stationId, 22, { open: true, seconds: 60, bytes: 480_000 })]);
    rows = await t.db.select().from(schema.recordings).where(eq(schema.recordings.nodeId, recorder));
    expect(rows.map((r) => [r.file.split('_')[1]!.slice(0, 2), r.open, r.durationSeconds]).sort()).toEqual([
      ['21', false, 3600],
      ['22', true, 60],
    ]);
    // A file that is not one of the recorder's is refused.
    expect((await report([{ ...logFile(stationId, 23), file: '../../etc/passwd' }])).statusCode).toBe(400);
  });

  it('lists the files of a period with the songs in them', async () => {
    const list = await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recordings?from=2026-10-29T21:30:00.000Z&to=2026-10-29T23:00:00.000Z`, headers: admin });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((f: { startedAt: string; open: boolean; available: boolean }) => [f.startedAt, f.open, f.available])).toEqual([
      ['2026-10-29T21:00:00.000Z', false, false],
      ['2026-10-29T22:00:00.000Z', true, false],
    ]);
    const [, file22] = list.json();
    await t.db.insert(schema.songPlays).values([
      { stationId, mountPath: '/live', title: 'Artist - First', startedAt: new Date('2026-10-29T21:58:00Z'), endedAt: new Date('2026-10-29T22:01:00Z') },
      { stationId, mountPath: '/live', title: 'Artist - Second', startedAt: new Date('2026-10-29T22:01:00Z'), endedAt: null },
      { stationId, mountPath: '/low', title: 'Artist - Second', startedAt: new Date('2026-10-29T22:01:01Z'), endedAt: null },
    ]);
    await t.db.insert(schema.liveSessions).values({ stationId, mountPath: '/live', accountName: 'DJ Reinder', via: 'tls', startedAt: new Date('2026-10-29T22:00:30Z') });
    const songs = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recordings/${file22.id}/songs`, headers: admin })).json();
    expect(songs.map((s: { title: string; offsetSeconds: number; live: boolean; dj: string | null }) => [s.title, s.offsetSeconds, s.live, s.dj])).toEqual([
      ['Artist - First', -120, false, null],
      ['DJ Reinder', 30, true, 'DJ Reinder'],
      ['Artist - Second', 60, true, 'DJ Reinder'],
    ]);
    expect((await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recordings/${file22.id}/audio`, headers: admin })).statusCode).toBe(503);
  });

  it('fetches the audio from the recorder: a part for a player, the whole file part by part for a download', async () => {
    const [rec] = await t.db.select().from(schema.recordings).where(eq(schema.recordings.nodeId, recorder)).limit(1);
    const size = RECORDING_PART + 1000;
    const data = Buffer.alloc(size, 7);
    data.write('ID3', 0);
    const hub = t.app.nodes as unknown as { conns: Map<string, unknown> };
    const asked: { start: number; end: number | null }[] = [];
    // A pretend agent: answers rec_send by posting the bytes, as apps/node/src/recorder.ts does.
    hub.conns.set(recorder, {
      nodeId: recorder,
      status: { online: true, features: ['recorder'] },
      socket: {
        OPEN: 1,
        readyState: 1,
        send(raw: string) {
          const msg = JSON.parse(raw);
          if (msg.t !== 'rec_send') return;
          expect(msg.file).toBe(rec!.file);
          asked.push({ start: msg.start, end: msg.end });
          const to = Math.min(size, msg.end ?? size);
          setImmediate(() =>
            void t.app.inject({
              method: 'POST',
              url: `/api/nodes/agent/recordings/${msg.id}`,
              headers: { authorization: `Node ${recorder}.${recorderSecret}`, 'content-type': 'application/octet-stream', 'x-hrs-size': String(size), 'x-hrs-start': String(msg.start) },
              payload: data.subarray(msg.start, to),
            }),
          );
        },
      },
    });
    try {
      const part = await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recordings/${rec!.id}/audio`, headers: { ...admin, range: 'bytes=100-' } });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe(`bytes 100-${100 + RECORDING_PART - 1}/${size}`);
      expect(part.rawPayload.length).toBe(RECORDING_PART);

      asked.length = 0;
      const whole = await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recordings/${rec!.id}/audio?download=1`, headers: admin });
      expect(whole.statusCode).toBe(200);
      expect(whole.headers['content-disposition']).toMatch(/^attachment; filename="test-fm_2026-10-29_2\d-00Z\.mp3"$/);
      expect(whole.rawPayload.equals(data)).toBe(true);
      expect(asked).toEqual([
        { start: 0, end: RECORDING_PART },
        { start: RECORDING_PART, end: size },
      ]);
    } finally {
      hub.conns.delete(recorder);
    }
    // Nobody waits for a file that was not asked for.
    const stray = await t.app.inject({
      method: 'POST',
      url: '/api/nodes/agent/recordings/00000000-0000-4000-8000-000000000000',
      headers: { authorization: `Node ${recorder}.${recorderSecret}`, 'content-type': 'application/octet-stream', 'x-hrs-size': '3', 'x-hrs-start': '0' },
      payload: Buffer.from('abc'),
    });
    expect(stray.statusCode).toBe(410);
  });

  it('records a live show while it is on air, and lists it with the DJ', async () => {
    await t.db.update(schema.liveSessions).set({ endedAt: new Date() }).where(eq(schema.liveSessions.stationId, stationId));
    const [session] = await t.db.insert(schema.liveSessions).values({ stationId, mountPath: '/live', accountName: 'DJ Show', via: 'tls', startedAt: new Date() }).returning();
    // One left over from long ago (an encoder that never said goodbye) is not recorded.
    await t.db.insert(schema.liveSessions).values({ stationId, mountPath: '/live', accountName: 'Ghost', via: 'tls', startedAt: new Date(Date.now() - 3 * 86400_000) });
    let st = (await buildPlan(t.ctx, await nodeRow(recorder))).recorder!.stations[0]!;
    expect(st.shows!.live).toEqual([{ sessionId: session!.id, dj: 'DJ Show', startedAt: session!.startedAt.toISOString(), url: expect.stringMatching(/\/listen\/live$/), format: 'mp3', kbps: 192 }]);
    await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/recording`, headers: admin, payload: { shows: false } });
    expect((await buildPlan(t.ctx, await nodeRow(recorder))).recorder!.stations[0]!.shows).toBeNull();
    await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/recording`, headers: admin, payload: { shows: true, showsMinMinutes: 5 } });

    const show = { stationId, kind: 'show', sessionId: session!.id, file: `${stationId}/show/2026-10-29_21-04-13Z_128k_${session!.id}.mp3`, startedAt: '2026-10-29T21:04:13.000Z', seconds: 1800, bytes: 28_800_000, open: false };
    expect((await report([logFile(stationId, 21), show])).statusCode).toBe(200);
    const shows = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recordings?kind=show&from=2026-10-29T00:00:00.000Z&to=2026-10-30T00:00:00.000Z`, headers: admin })).json();
    expect(shows).toEqual([expect.objectContaining({ kind: 'show', dj: 'DJ Show', durationSeconds: 1800 })]);
    // The AutoDJ title that was on before the show is not in its play log.
    await t.db.insert(schema.songPlays).values([
      { stationId, mountPath: '/live', title: 'AutoDJ - Before', startedAt: new Date('2026-10-29T21:01:00Z'), endedAt: null },
      { stationId, mountPath: '/live', title: 'DJ - During', startedAt: new Date('2026-10-29T21:10:00Z'), endedAt: null },
    ]);
    const showSongs = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recordings/${shows[0].id}/songs`, headers: admin })).json();
    expect(showSongs.map((x: { title: string; offsetSeconds: number }) => [x.title, x.offsetSeconds])).toEqual([['DJ - During', 347]]);
    // A show in another station's folder is refused.
    await report([{ ...show, file: `${otherStation}/show/2026-10-29_21-04-13Z_128k_${session!.id}.mp3` }]);
    expect(await t.db.select().from(schema.recordings).where(eq(schema.recordings.kind, 'show'))).toHaveLength(0);
    await t.db.update(schema.liveSessions).set({ endedAt: new Date() }).where(eq(schema.liveSessions.stationId, stationId));
    st = (await buildPlan(t.ctx, await nodeRow(recorder))).recorder!.stations[0]!;
    expect(st.shows!.live).toEqual([]);
  });

  it('reads Range headers', () => {
    expect(parseRange('bytes=0-')).toEqual({ start: 0, end: null });
    expect(parseRange('bytes=10-19')).toEqual({ start: 10, end: 20 });
    expect(parseRange('bytes=-500')).toBeNull();
    expect(parseRange('bytes=5-2')).toBeNull();
    expect(parseRange(undefined)).toBeNull();
  });
});
