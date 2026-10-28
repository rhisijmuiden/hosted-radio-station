import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { STUDIO_INGEST, STUDIO_USER, studioToken } from '../src/services/nodes/delivery.js';
import { authorizeIngest } from '../src/services/nodes/ingest.js';
import { buildPlan } from '../src/services/nodes/plan.js';
import { buildPackage } from '../src/services/stationnode/package.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let stationId: string;
let studio: string;
let ingest: string;
let backup: string;
let relay: string;

async function pair(body: Record<string, unknown>) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: body });
  expect(res.statusCode).toBe(201);
  const { node, pairing } = res.json();
  await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code, hostname: 'node-host' } });
  return node.id as string;
}
const nodeRow = async (id: string) => (await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, id)))[0]!;
const setOnline = async (id: string, online: boolean, ip = '192.0.2.10') => {
  const n = await nodeRow(id);
  await t.db.update(schema.nodes).set({ status: { ...n.status, online, ip, features: [STUDIO_INGEST] } }).where(eq(schema.nodes.id, id));
};
const routing = (payload: Record<string, unknown>) => t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/routing`, headers: admin, payload });
const pushes = async () => {
  const pkg = await buildPackage(t.ctx, await nodeRow(studio));
  // Only the pushes the orchestrator adds; the station's own outputs travel along as they are.
  return pkg.stations[0]!.outputs.map((o) => o.config as { host: string; port: number; mount: string; username: string; ingestNodeId?: string; relayNodeId?: string }).filter((c) => c.ingestNodeId || c.relayNodeId);
};

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: {
      name: 'Harder',
      slug: 'harder',
      plan: 'station',
      limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 320, storageQuotaMb: 10, maxNodes: 2 },
      owner: { email: 'owner@harder.fm', name: 'Owner', password: 'owner-password' },
    },
  });
  const owner = await login(t.app, 'owner@harder.fm', 'owner-password');
  stationId = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId: res.json().id, name: 'Harder.FM', slug: 'harder-fm' } })).json().id;
  // A second, transcoded mount: the ingest makes it, the studio only uploads /live.
  const [live] = await t.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, stationId));
  await t.db.insert(schema.stationMounts).values({ stationId, path: '/low', kind: 'transcode', format: 'mp3', bitrateKbps: 64, sourceMountId: live!.id, isPublic: true, sortOrder: 5 });
  studio = await pair({ name: 'pub-station-01', roles: ['station'] });
  ingest = await pair({ name: 'pub-ingest-01', roles: ['source'] });
  backup = await pair({ name: 'pub-ingest-02', roles: ['source'] });
  relay = await pair({ name: 'pub-relay-01', roles: ['relay'] });
  await t.app.inject({ method: 'PATCH', url: `/api/nodes/${relay}`, headers: admin, payload: { config: { publicHost: 'relay.example.com' } } });
  for (const id of [studio, ingest, relay]) await setOnline(id, true);
  await t.db.update(schema.stations).set({ nodeId: studio }).where(eq(schema.stations.id, stationId));
});
afterAll(() => t.close());

describe('station node through the ingest (1.3)', () => {
  it('sends the source stream once to an ingest by default, not every mount to every relay', async () => {
    const view = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: admin })).json();
    expect(view.routing.delivery).toBe('ingest');
    expect(view.studio).toEqual({ ingests: [{ id: ingest, name: 'pub-ingest-01', online: true, priority: 0 }], direct: null, error: null });
    const out = await pushes();
    expect(out).toEqual([expect.objectContaining({ host: '192.0.2.10', port: 8200, mount: '/harder-fm/live', username: STUDIO_USER, ingestNodeId: ingest })]);
  });

  it('plans the ingest to take the station, make its mounts and feed the relays', async () => {
    const plan = await buildPlan(t.ctx, await nodeRow(ingest));
    const s = plan.ingest!.stations.find((x) => x.stationId === stationId)!;
    expect(s.priority).toBe(0);
    expect(s.mounts.map((m) => [m.path, m.kind])).toEqual(expect.arrayContaining([['/live', 'source'], ['/low', 'transcode']]));
    expect(s.targets).toEqual([expect.objectContaining({ nodeId: relay, host: 'relay.example.com', port: 8301 })]);
    expect(s.outputs).toEqual([]);
    // The relay takes pushes for it, as before.
    expect((await buildPlan(t.ctx, await nodeRow(relay))).relay!.mounts.every((m) => !!m.push)).toBe(true);
  });

  it('lets only the station node itself send to the ingest, and logs no broadcast for it', async () => {
    const studioRow = await nodeRow(studio);
    const ingestRow = await nodeRow(ingest);
    const ask = (user: string | null, pass: string) => authorizeIngest(t.ctx, ingestRow, { t: 'auth', id: 1, stationId, mount: '/live', user, pass, ip: '192.0.2.10', purpose: 'source' });
    expect(await ask(STUDIO_USER, studioToken(t.ctx, studioRow, stationId))).toMatchObject({ ok: true, accountName: 'pub-station-01', limitKbps: 0 });
    expect(await ask(STUDIO_USER, 'wrong')).toMatchObject({ ok: false });
    expect(await ask('dj1', 'whatever')).toMatchObject({ ok: false });
    // Another ingest is not on the route.
    expect(await authorizeIngest(t.ctx, await nodeRow(backup), { t: 'auth', id: 2, stationId, mount: '/live', user: STUDIO_USER, pass: studioToken(t.ctx, studioRow, stationId), ip: '192.0.2.10', purpose: 'source' })).toMatchObject({ ok: false });
  });

  it('adds a chosen backup ingest, which also gets the stream', async () => {
    await setOnline(backup, true, '192.0.2.11');
    const res = await routing({ ingest, backupIngest: backup, relays: 'auto', spareRelays: true, delivery: 'ingest' });
    expect(res.statusCode).toBe(200);
    expect(res.json().studio.ingests.map((i: { id: string; priority: number }) => [i.id, i.priority])).toEqual([
      [ingest, 0],
      [backup, 1],
    ]);
    expect((await pushes()).map((o) => o.ingestNodeId)).toEqual([ingest, backup]);
    expect((await buildPlan(t.ctx, await nodeRow(backup))).ingest!.stations.find((x) => x.stationId === stationId)!.priority).toBe(1);
  });

  it('falls back to the relays while no ingest is online', async () => {
    await setOnline(ingest, false);
    await setOnline(backup, false);
    expect((await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: admin })).json().studio).toEqual({ ingests: [], direct: 'offline', error: null });
    const out = await pushes();
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.relayNodeId === relay && o.port === 8301)).toBe(true);
    await setOnline(ingest, true);
    await setOnline(backup, true, '192.0.2.11');
  });

  it('sends straight to the relays when chosen so', async () => {
    const res = await routing({ ingest: 'local', backupIngest: null, relays: 'auto', spareRelays: true, delivery: 'direct' });
    expect(res.json().studio).toEqual({ ingests: [], direct: 'chosen', error: null });
    const out = await pushes();
    expect(out.map((o) => o.mount).sort()).toEqual(['/listen/harder-fm/live', '/listen/harder-fm/low']);
    expect(out.every((o) => o.relayNodeId === relay)).toBe(true);
    expect((await buildPlan(t.ctx, await nodeRow(ingest))).ingest!.stations.some((x) => x.stationId === stationId)).toBe(false);
  });

  it('refuses a node without the ingest role', async () => {
    expect((await routing({ ingest: relay, backupIngest: null, relays: 'auto', spareRelays: true, delivery: 'ingest' })).statusCode).toBe(400);
  });

  it('keeps a station node with software from before 1.3 on the relays', async () => {
    await routing({ ingest: 'local', backupIngest: null, relays: 'auto', spareRelays: true, delivery: 'ingest' });
    const n = await nodeRow(studio);
    await t.db.update(schema.nodes).set({ status: { ...n.status, features: [] } }).where(eq(schema.nodes.id, studio));
    try {
      expect((await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: admin })).json().studio).toEqual({ ingests: [], direct: 'update', error: null });
      const out = await pushes();
      expect(out).toHaveLength(2);
      expect(out.every((o) => o.relayNodeId === relay)).toBe(true);
      // The ingest already takes the station, so it is ready the moment the updated node starts sending.
      const ready = await Promise.all([ingest, backup].map(async (id) => (await buildPlan(t.ctx, await nodeRow(id))).ingest!.stations.some((x) => x.stationId === stationId)));
      expect(ready.filter(Boolean)).toHaveLength(1);
    } finally {
      await setOnline(studio, true);
    }
  });

  it('sends to the ingest on the local network when both sit behind the same public address', async () => {
    const n = await nodeRow(ingest);
    await t.db.update(schema.nodes).set({ status: { ...n.status, ip: '198.51.100.7', addresses: ['10.10.4.121', 'fd00::1'] } }).where(eq(schema.nodes.id, ingest));
    const s = await nodeRow(studio);
    await t.db.update(schema.nodes).set({ status: { ...s.status, ip: '198.51.100.7' } }).where(eq(schema.nodes.id, studio));
    await routing({ ingest, backupIngest: null, relays: 'auto', spareRelays: true, delivery: 'ingest' });
    expect(await pushes()).toEqual([expect.objectContaining({ host: '10.10.4.121', port: 8200, ingestNodeId: ingest })]);
    // From elsewhere the public address.
    await t.db.update(schema.nodes).set({ status: { ...s.status, ip: '203.0.113.5' } }).where(eq(schema.nodes.id, studio));
    expect(await pushes()).toEqual([expect.objectContaining({ host: '198.51.100.7', ingestNodeId: ingest })]);
  });

  // Last: the station then stays on the relays for a while.
  it('feeds the relays itself while its pushes to the ingest fail', async () => {
    // Automatic: one of the two ingests.
    const [via] = (await pushes()).map((o) => o.ingestNodeId!);
    expect([ingest, backup]).toContain(via);
    await t.db.update(schema.stations).set({ nodeRuntime: { mounts: [], autodj: null, encoders: 0, relays: { [via!]: { state: 'error', message: '10.10.4.121:8200: ECONNREFUSED' } }, revision: null, storageBytes: null, updatedAt: new Date().toISOString(), syncedAt: null } as never }).where(eq(schema.stations.id, stationId));
    const out = await pushes();
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.relayNodeId === relay)).toBe(true);
    // Once the node no longer pushes to the ingest it reports nothing for it, and still feeds the relays.
    await t.db.update(schema.stations).set({ nodeRuntime: null }).where(eq(schema.stations.id, stationId));
    expect((await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: admin })).json().studio).toEqual({ ingests: [], direct: 'failing', error: '10.10.4.121:8200: ECONNREFUSED' });
    // The ingest keeps the station in its plan meanwhile, so the next try finds it ready.
    expect((await buildPlan(t.ctx, await nodeRow(via!))).ingest!.stations.some((x) => x.stationId === stationId)).toBe(true);
    expect((await pushes()).every((o) => o.relayNodeId === relay)).toBe(true);
  });
});
