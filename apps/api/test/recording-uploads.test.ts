import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { RecordingDelivery, remotePathOf, retryDelay, type Uploader } from '../src/services/recorder/delivery.js';
import { itemPath } from '../src/services/public/ondemand.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let stationId: string;
let recorder: string;
let secret: string;
let sessionId: string;
const sent: Record<string, unknown>[] = [];
const AUDIO = Buffer.from('ID3 pretend audio of a recording');

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, '.000Z');
const stamp = (at: string) => at.slice(0, 19).replace('T', '_').replace(/:/g, '-');
const logFile = (at: string, open = false) => ({ stationId, kind: 'log', file: `${stationId}/log/${stamp(at)}Z_64k.mp3`, startedAt: at, seconds: 3600, bytes: AUDIO.length, open });
const report = (recordings: unknown[]) =>
  t.app.inject({ method: 'POST', url: '/api/nodes/agent/report', headers: { authorization: `Node ${recorder}.${secret}` }, payload: { relays: [], clients: [], probes: [], recordings } });

/** Uploads that are recorded instead of sent; the first one to a destination named "flaky" fails. */
const uploads: { dest: string; remotePath: string; body: string }[] = [];
let flaky = true;
const upload: Uploader = async (dest, localFile, remotePath) => {
  const body = await readFile(localFile, 'utf8');
  if ((dest.config as { host?: string }).host === 'flaky.example.com' && flaky) {
    flaky = false;
    throw new Error('Connection refused');
  }
  uploads.push({ dest: (dest.config as { host: string }).host, remotePath, body });
  return null;
};

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const tenant = await t.app.inject({ method: 'POST', url: '/api/tenants', headers: admin, payload: { name: 'Test FM BV', slug: 'testfm', plan: 'station' } });
  stationId = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId: tenant.json().id, name: 'Test FM', slug: 'test-fm' } })).json().id;
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name: 'recorder1', roles: ['recorder'], config: { recordStations: [stationId] } } });
  const p = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: res.json().pairing.code, hostname: 'rec' } });
  recorder = res.json().node.id;
  secret = p.json().secret;
  await t.app.inject({ method: 'PATCH', url: `/api/nodes/${recorder}`, headers: admin, payload: { config: { recordStations: [stationId] } } });
  // A pretend agent: answers rec_send with the bytes, and keeps the other messages.
  (t.app.nodes as unknown as { conns: Map<string, unknown> }).conns.set(recorder, {
    nodeId: recorder,
    status: { online: true, features: ['recorder'] },
    socket: {
      OPEN: 1,
      readyState: 1,
      send(raw: string) {
        const msg = JSON.parse(raw);
        if (msg.t !== 'rec_send') return void sent.push(msg);
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
  const [s] = await t.db
    .insert(schema.liveSessions)
    .values({ stationId, mountPath: '/live', accountName: 'DJ Reinder', via: 'tls', startedAt: new Date(Date.now() - 40 * 60_000), endedAt: new Date(Date.now() - 5 * 60_000) })
    .returning();
  sessionId = s!.id;
});
afterAll(async () => {
  (t.app.nodes as unknown as { conns: Map<string, unknown> }).conns.delete(recorder);
  await t.close();
});

const delivery = () => new RecordingDelivery(t.ctx, t.app.nodes, null, t.app.log, upload);
const sftp = (host: string, kinds = ['log', 'show']) => ({ name: host, type: 'sftp', kinds, config: { host, username: 'radio', password: 'geheim', path: 'opnames' } });

describe('uploads of recordings (phase 21 step 3)', () => {
  it('keeps destinations per station with their secrets hidden', async () => {
    const bad = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/recording/destinations`, headers: admin, payload: { ...sftp('a.example.com'), kinds: [] } });
    expect(bad.statusCode).toBe(400);
    const res = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/recording/destinations`, headers: admin, payload: sftp('nas.example.com') });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: 'sftp', kinds: ['log', 'show'], description: 'sftp://radio@nas.example.com:22/opnames', uploaded: 0, failing: 0 });
    expect(res.json().config.password).not.toBe('geheim');
    const [row] = await t.db.select().from(schema.recordingDestinations).where(eq(schema.recordingDestinations.id, res.json().id));
    expect(JSON.stringify(row!.config)).not.toContain('geheim');
    // Saving with the masked password keeps the real one.
    const put = await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/recording/destinations/${res.json().id}`, headers: admin, payload: { ...sftp('nas.example.com'), config: res.json().config } });
    expect(put.statusCode).toBe(200);
    const [again] = await t.db.select().from(schema.recordingDestinations).where(eq(schema.recordingDestinations.id, res.json().id));
    expect(t.ctx.box.decrypt((again!.config as { password: string }).password)).toBe('geheim');
    expect((await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/recording/destinations`, headers: admin, payload: { ...sftp('x'), type: 'local' } })).statusCode).toBe(400);
  });

  it('uploads finished recordings once, tries a failed upload again later, and skips what ended before the destination came', async () => {
    await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/recording/destinations`, headers: admin, payload: sftp('flaky.example.com', ['log']) });
    const done = logFile(iso(50 * 60_000));
    const old = logFile(iso(5 * 3600_000));
    const open = logFile(iso(10 * 60_000), true);
    expect((await report([old, done, open])).statusCode).toBe(200);
    await delivery().tick();
    expect(uploads).toEqual([{ dest: 'nas.example.com', remotePath: remotePathOf({ kind: 'log', file: done.file, startedAt: new Date(done.startedAt), sessionId: null }, 'test-fm', null), body: AUDIO.toString() }]);
    expect(uploads[0]!.remotePath).toMatch(/^test-fm\/logging\/\d{4}-\d{2}\/test-fm_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}Z_64k\.mp3$/);
    const list = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recording/destinations`, headers: admin })).json();
    const flakyDest = list.destinations.find((x: { name: string }) => x.name === 'flaky.example.com');
    expect(flakyDest).toMatchObject({ uploaded: 0, failing: 1, lastError: 'Connection refused' });
    const files = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recordings?from=${iso(6 * 3600_000)}`, headers: admin })).json();
    expect(files.find((f: { startedAt: string }) => f.startedAt === done.startedAt).uploads).toEqual({ done: 1, failed: 1, error: 'Connection refused' });

    // Nothing again before the retry is due; then the failed one goes.
    uploads.length = 0;
    await delivery().tick();
    expect(uploads).toEqual([]);
    expect(retryDelay(1)).toBe(60_000);
    await delivery().tick(new Date(Date.now() + 2 * 60_000));
    expect(uploads.map((u) => u.dest)).toEqual(['flaky.example.com']);
    const after = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recording/destinations`, headers: admin })).json();
    expect(after.destinations.find((x: { name: string }) => x.name === 'flaky.example.com')).toMatchObject({ uploaded: 1, failing: 0, lastError: null });
  });

  it('makes a finished show an on-demand item once, and uploads it with the DJ in its name', async () => {
    uploads.length = 0;
    const at = iso(30 * 60_000);
    const show = { stationId, kind: 'show', sessionId, file: `${stationId}/show/${stamp(at)}Z_128k_${sessionId}.mp3`, startedAt: at, seconds: 1900, bytes: AUDIO.length, open: false };
    const log = logFile(iso(50 * 60_000));
    await report([log, show]);
    await delivery().tick();
    expect(uploads.map((u) => [u.dest, u.remotePath])).toEqual([['nas.example.com', expect.stringMatching(/^test-fm\/shows\/\d{4}-\d{2}\/test-fm_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}Z_DJ-Reinder_[0-9a-f]{6}\.mp3$/)]]);
    const items = await t.db.select().from(schema.onDemandItems).where(eq(schema.onDemandItems.stationId, stationId));
    expect(items).toEqual([expect.objectContaining({ source: 'recording', host: 'DJ Reinder', liveSessionId: sessionId, publishedAt: null, sizeBytes: AUDIO.length })]);
    expect(items[0]!.title).toMatch(/DJ Reinder$/);
    expect(await readFile(itemPath(t.ctx, stationId, items[0]!.file), 'utf8')).toBe(AUDIO.toString());
    const [rec] = await t.db.select().from(schema.recordings).where(and(eq(schema.recordings.kind, 'show'), eq(schema.recordings.sessionId, sessionId)));
    expect(rec!.ondemandAt).not.toBeNull();
    await delivery().tick();
    expect(await t.db.select().from(schema.onDemandItems).where(eq(schema.onDemandItems.stationId, stationId))).toHaveLength(1);
    const shows = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/recordings?kind=show&from=${iso(6 * 3600_000)}`, headers: admin })).json();
    expect(shows[0]).toMatchObject({ onDemand: true, uploads: { done: 1, failed: 0 } });
  });

  it('asks the recorder to remove what is everywhere it had to go, when the station wants that', async () => {
    await delivery().tick();
    expect(sent.filter((m) => m.t === 'rec_delete')).toEqual([]);
    expect((await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/recording`, headers: admin, payload: { deleteUploaded: true } })).statusCode).toBe(200);
    await delivery().tick();
    const removed = sent.filter((m) => m.t === 'rec_delete').map((m) => String(m.file).split('/')[1]);
    // The logging hour (both destinations have it) and the show (uploaded and on demand); not the older hour nobody took.
    expect(removed.sort()).toEqual(['log', 'show']);
  });
});
