import { execFileSync } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { buildPlan } from '../src/services/nodes/plan.js';
import { scanOnDemand } from '../src/services/public/ondemand.js';
import { mediaDir } from '../src/services/streaming/icecast.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let owner: { cookie: string };
let dj: { cookie: string };
let stationId: string;
let recorder: string;
let secret: string;
let djAccountId: string;
let otherAccountId: string;
let AUDIO: Buffer;

const nodeRow = async (id: string) => (await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, id)))[0]!;
const liveOf = async () => (await buildPlan(t.ctx, await nodeRow(recorder))).recorder!.stations[0]!.shows;
const report = (recordings: unknown[]) =>
  t.app.inject({ method: 'POST', url: '/api/nodes/agent/report', headers: { authorization: `Node ${recorder}.${secret}` }, payload: { relays: [], clients: [], probes: [], recordings } });
/** Seconds of an mp3 by ffprobe. */
const seconds = (buf: Buffer) => {
  const f = join(tmpdir(), `hrs-probe-${process.pid}.mp3`);
  writeFileSync(f, buf);
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
};
const mp3 = (file: string, secs: number) => execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `sine=d=${secs}`, '-b:a', '128k', '-y', file]);

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const tenant = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: { name: 'Rec FM', slug: 'recfm', plan: 'station', owner: { email: 'owner@rec.fm', name: 'Owner', password: 'owner-password' } },
  });
  owner = await login(t.app, 'owner@rec.fm', 'owner-password');
  const m = await t.app.inject({ method: 'POST', url: `/api/tenants/${tenant.json().id}/members`, headers: owner, payload: { email: 'dj@rec.fm', name: 'DJ Rec', password: 'dj-password-1', role: 'dj' } });
  dj = await login(t.app, 'dj@rec.fm', 'dj-password-1');
  stationId = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId: tenant.json().id, name: 'Rec FM', slug: 'rec-fm' } })).json().id;
  djAccountId = (await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/accounts`, headers: owner, payload: { username: 'djrec', userId: m.json().user.id } })).json().id;
  otherAccountId = (await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/accounts`, headers: owner, payload: { username: 'someone', password: 'someone-password' } })).json().id;

  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name: 'recorder1', roles: ['recorder'] } });
  const p = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: res.json().pairing.code, hostname: 'rec' } });
  recorder = res.json().node.id;
  secret = p.json().secret;
  await t.app.inject({ method: 'PATCH', url: `/api/nodes/${recorder}`, headers: admin, payload: { config: { recordStations: [stationId] } } });

  const src = join(tmpdir(), `hrs-show-${process.pid}.mp3`);
  mp3(src, 20);
  AUDIO = execFileSync('cat', [src]);
  // A pretend agent that sends the bytes of every recording it is asked for.
  (t.app.nodes as unknown as { conns: Map<string, unknown> }).conns.set(recorder, {
    nodeId: recorder,
    recorded: new Set<string>(),
    status: { online: true, features: ['recorder'] },
    socket: {
      OPEN: 1,
      readyState: 1,
      send(raw: string) {
        const msg = JSON.parse(raw);
        if (msg.t !== 'rec_send') return;
        setImmediate(() =>
          void t.app.inject({
            method: 'POST',
            url: `/api/nodes/agent/recordings/${msg.id}`,
            headers: { authorization: `Node ${recorder}.${secret}`, 'content-type': 'application/octet-stream', 'x-hrs-size': String(AUDIO.length), 'x-hrs-start': String(msg.start) },
            payload: AUDIO.subarray(msg.start, Math.min(AUDIO.length, msg.end ?? AUDIO.length)),
          }),
        );
      },
    },
  });
});
afterAll(async () => {
  (t.app.nodes as unknown as { conns: Map<string, unknown> }).conns.delete(recorder);
  await t.close();
});

describe('recording in RHIS Studio (phase 21 step 4)', () => {
  let mine: string;
  let theirs: string;
  let myShow: string;
  let theirShow: string;

  it('lets a DJ stop or start the recording of their own broadcast only', async () => {
    const [a] = await t.db.insert(schema.liveSessions).values({ stationId, mountPath: '/live', accountId: djAccountId, accountName: 'djrec', via: 'tls' }).returning();
    const [b] = await t.db.insert(schema.liveSessions).values({ stationId, mountPath: '/live', accountId: otherAccountId, accountName: 'someone', via: 'tls' }).returning();
    mine = a!.id;
    theirs = b!.id;
    const state = (await t.app.inject({ url: `/api/studio/stations/${stationId}/recording`, headers: dj })).json();
    expect(state).toMatchObject({ recorder: true, showsByDefault: true });
    expect(state.live).toEqual([expect.objectContaining({ sessionId: mine, record: true, chosen: false, recording: false })]);
    expect((await t.app.inject({ url: `/api/studio/stations/${stationId}/recording`, headers: owner })).json().live).toHaveLength(2);
    expect((await liveOf())!.live.map((x) => x.sessionId).sort()).toEqual([mine, theirs].sort());

    const stop = await t.app.inject({ method: 'PUT', url: `/api/studio/stations/${stationId}/live/${mine}/recording`, headers: dj, payload: { record: false } });
    expect(stop.json()).toMatchObject({ sessionId: mine, record: false, chosen: true });
    expect(await liveOf()).toMatchObject({ live: [expect.objectContaining({ sessionId: theirs })], paused: [mine] });
    expect((await t.app.inject({ method: 'PUT', url: `/api/studio/stations/${stationId}/live/${theirs}/recording`, headers: dj, payload: { record: false } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'PUT', url: `/api/studio/stations/${stationId}/live/${theirs}/recording`, headers: owner, payload: { record: false } })).statusCode).toBe(200);
    expect((await liveOf())!.live).toEqual([]);
  });

  it('records a show the DJ asks for when the station does not record shows', async () => {
    await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/recording`, headers: owner, payload: { shows: false } });
    expect((await t.app.inject({ url: `/api/studio/stations/${stationId}/recording`, headers: dj })).json()).toMatchObject({ showsByDefault: false, live: [expect.objectContaining({ record: false })] });
    await t.app.inject({ method: 'PUT', url: `/api/studio/stations/${stationId}/live/${mine}/recording`, headers: dj, payload: { record: true } });
    expect((await liveOf())!.live.map((x) => x.sessionId)).toEqual([mine]);
    await t.db.update(schema.liveSessions).set({ endedAt: new Date() }).where(eq(schema.liveSessions.stationId, stationId));
    expect((await t.app.inject({ method: 'PUT', url: `/api/studio/stations/${stationId}/live/${mine}/recording`, headers: dj, payload: { record: true } })).statusCode).toBe(404);
  });

  it('lists the shows of the last month, a DJ only their own, with links to play them', async () => {
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace(/\.\d+Z$/, '.000Z');
    const show = (session: string, start: string) => ({ stationId, kind: 'show', sessionId: session, file: `${stationId}/show/${start.slice(0, 19).replace('T', '_').replace(/:/g, '-')}Z_128k_${session}.mp3`, startedAt: start, seconds: 20, bytes: AUDIO.length, open: false });
    expect((await report([show(mine, at(30)), show(theirs, at(20))])).statusCode).toBe(200);
    const all = (await t.app.inject({ url: `/api/studio/stations/${stationId}/recordings`, headers: owner })).json();
    expect(all.map((x: { dj: string }) => x.dj)).toEqual(['someone', 'djrec']);
    [theirShow, myShow] = all.map((x: { id: string }) => x.id);
    const own = (await t.app.inject({ url: `/api/studio/stations/${stationId}/recordings`, headers: dj })).json();
    expect(own).toEqual([expect.objectContaining({ id: myShow, dj: 'djrec', durationSeconds: 20, available: true, open: false })]);
    expect((await t.app.inject({ method: 'POST', url: `/api/studio/stations/${stationId}/recordings/${theirShow}/link`, headers: dj })).statusCode).toBe(403);

    const link = (await t.app.inject({ method: 'POST', url: `/api/studio/stations/${stationId}/recordings/${myShow}/link`, headers: dj })).json();
    expect(link.url).toMatch(new RegExp(`^/api/recordings/${myShow}/audio\\?exp=\\d+&sig=`));
    const audio = await t.app.inject({ url: link.url });
    expect(audio.statusCode).toBe(200);
    expect(audio.rawPayload.equals(AUDIO)).toBe(true);
    const dl = await t.app.inject({ url: `${link.url}&download=1` });
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="rec-fm_show_.*Z\.mp3"$/);
    // Another recording, or a changed time, makes the signature wrong.
    expect((await t.app.inject({ url: link.url.replace(myShow, theirShow) })).statusCode).toBe(403);
    const exp = Number(new URL(link.url, 'http://x').searchParams.get('exp'));
    expect((await t.app.inject({ url: link.url.replace(`exp=${exp}`, `exp=${exp + 3600}`) })).statusCode).toBe(403);
  });

  it('downloads only a part of a recording in the panel', async () => {
    const res = await t.app.inject({ url: `/api/stations/${stationId}/recordings/${myShow}/audio?from=5&to=12`, headers: owner });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/_00m05s-00m12s\.mp3"$/);
    expect(seconds(res.rawPayload)).toBeGreaterThan(6);
    expect(seconds(res.rawPayload)).toBeLessThan(8);
    expect((await t.app.inject({ url: `/api/stations/${stationId}/recordings/${myShow}/audio?from=12&to=5`, headers: owner })).statusCode).toBe(400);
  });

  it('cuts an on-demand item down without encoding it again', async () => {
    const dir = join(mediaDir(t.ctx, stationId), 'ondemand');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'Show.mp3');
    mp3(file, 30);
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    await scanOnDemand(t.ctx, stationId);
    const [item] = (await t.app.inject({ url: `/api/stations/${stationId}/ondemand`, headers: owner })).json().items;
    expect(item.durationSeconds).toBe(30);
    const url = `/api/stations/${stationId}/ondemand/${item.id}/trim`;
    expect((await t.app.inject({ method: 'POST', url, headers: dj, payload: { from: 0, to: 10 } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url, headers: owner, payload: { from: 10, to: 10.5 } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url, headers: owner, payload: { from: 40, to: 50 } })).statusCode).toBe(400);
    const cut = await t.app.inject({ method: 'POST', url, headers: owner, payload: { from: 5, to: 20 } });
    expect(cut.statusCode).toBe(200);
    expect(cut.json().durationSeconds).toBeGreaterThanOrEqual(14);
    expect(cut.json().durationSeconds).toBeLessThanOrEqual(16);
    expect(cut.json().sizeBytes).toBeLessThan(item.sizeBytes);
  });
});
