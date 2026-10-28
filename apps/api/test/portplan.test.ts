import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { buildPlan } from '../src/services/nodes/plan.js';
import { inboundPorts } from '../src/services/nodes/ports.js';
import { getSetting, streamingSchema, withStationNodePorts } from '../src/services/settings.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let stationId: string;

async function pair(body: Record<string, unknown>) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: body });
  expect(res.statusCode).toBe(201);
  const { node, pairing } = res.json();
  await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code, hostname: 'node-host' } });
  return node.id as string;
}
const nodeRow = async (id: string) => (await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, id)))[0]!;

/** Runs the port plan migration again, on rows written as a server before 1.3 would have them. */
async function migrate() {
  const file = readFileSync(join(import.meta.dirname, '../drizzle/0020_port_plan.sql'), 'utf8');
  for (const part of file.split('--> statement-breakpoint')) await t.db.execute(sql.raw(part));
}

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: {
      name: 'Schermer',
      slug: 'schermer',
      plan: 'distribution',
      limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 1, maxNodes: 1 },
      owner: { email: 'owner@schermer.nl', name: 'Owner', password: 'owner-password' },
    },
  });
  const owner = await login(t.app, 'owner@schermer.nl', 'owner-password');
  stationId = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId: res.json().id, name: 'Radio Schermer', slug: 'schermer-fm' } })).json().id;
});
afterAll(() => t.close());

describe('port plan (1.3)', () => {
  let ingest: string;
  let relay: string;
  let custom: string;

  it('gives new nodes and a fresh install the ports of their role, without old ports', async () => {
    ingest = await pair({ name: 'ingest-ams', roles: ['source'] });
    relay = await pair({ name: 'relay-ams', roles: ['relay'] });
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${relay}`, headers: admin, payload: { config: { publicHost: 'relay-ams.example.com' } } });
    const s = await getSetting(t.ctx, 'streaming');
    expect(s).toMatchObject({ ingestPlainPort: 8200, ingestTlsPort: 8201, legacyPortFrom: 8210, legacyPortTo: 8299 });
    expect((await getSetting(t.ctx, 'orchestrator')).oldPorts).toBe(false);
    const fw = await inboundPorts(t.ctx, await nodeRow(ingest));
    expect(fw.map((p) => [p.service, p.port, !!p.old])).toEqual([
      ['encoderTls', 8201, false],
      ['encoderPlain', 8200, false],
    ]);
    const plan = await buildPlan(t.ctx, await nodeRow(relay));
    expect(plan.relay).toMatchObject({ pushPort: 8301, pushPorts: [8301] });
  });

  it('moves nodes and settings from before the port plan to the new ports and keeps the old ones open', async () => {
    custom = await pair({ name: 'relay-own', roles: ['relay'] });
    // As stored by 1.2: the old defaults, and one node with a push port of its own.
    for (const [id, config] of [
      [ingest, { sourcePlainPort: 8010, sourceTlsPort: 8443, pushPort: 8001 }],
      [relay, { publicHost: 'relay-ams.example.com', sourcePlainPort: 8010, sourceTlsPort: 8443, pushPort: 8001 }],
      [custom, { pushPort: 9001 }],
    ] as const) {
      await t.db.update(schema.nodes).set({ config }).where(eq(schema.nodes.id, id));
    }
    await t.db.insert(schema.settings).values({ key: 'streaming', value: { ingestTlsPort: 8443, ingestPlainPort: 8010, legacyPortFrom: 8100, legacyPortTo: 8199 } }).onConflictDoUpdate({ target: schema.settings.key, set: { value: { ingestTlsPort: 8443, ingestPlainPort: 8010, legacyPortFrom: 8100, legacyPortTo: 8199 } } });
    await t.db.update(schema.stations).set({ legacyPort: 8100 }).where(eq(schema.stations.id, stationId));
    await migrate();

    expect((await nodeRow(ingest)).config).toMatchObject({ sourcePlainPort: 8200, sourceTlsPort: 8201, pushPort: 8301, oldPorts: true });
    expect((await nodeRow(custom)).config).toEqual({ pushPort: 9001 });
    expect(await getSetting(t.ctx, 'streaming')).toMatchObject({ ingestPlainPort: 8200, ingestTlsPort: 8201, legacyPortFrom: 8210, legacyPortTo: 8299 });
    expect((await getSetting(t.ctx, 'orchestrator')).oldPorts).toBe(true);
  });

  it('plans the old ports next to the new ones, and keeps agents before 1.3 on the old ones', async () => {
    const r = await buildPlan(t.ctx, await nodeRow(relay));
    expect(r.relay).toMatchObject({ pushPort: 8001, pushPorts: [8301, 8001] });
    const i = await buildPlan(t.ctx, await nodeRow(ingest));
    expect(i.source).toMatchObject({ plainPort: 8010, tlsPort: 8443, ports: { plain: [8200, 8010], tls: [8201, 8443] } });
    // Pushes keep going to the port the firewall lets through today.
    await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/routing`, headers: admin, payload: { ingest, relays: [relay] } });
    const routed = await buildPlan(t.ctx, await nodeRow(ingest));
    expect(routed.ingest!.stations[0]!.targets[0]).toMatchObject({ nodeId: relay, port: 8001 });
    // The firewall checklist lists the old ports last, marked as old.
    const fw = await inboundPorts(t.ctx, await nodeRow(ingest));
    expect(fw.map((p) => [p.port, !!p.old])).toEqual([
      [8201, false],
      [8200, false],
      [8443, true],
      [8010, true],
    ]);
    const c = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/connection`, headers: admin })).json();
    expect(c.endpoints[0].ports).toEqual([{ service: 'encoderPlain', port: 8200 }, { service: 'encoderPlain', port: 8010, old: true }]);
  });

  it('lists where old ports are open and switches them off per server', async () => {
    const view = (await t.app.inject({ method: 'GET', url: '/api/nodes/port-plan', headers: admin })).json();
    expect(view).toMatchObject({ thisServer: true, oldShoutcast: 1, ports: { ingest: { plain: 8200 }, relay: { push: 8301 }, stationNode: { plain: 8400, tls: 8401, sftp: 8402 } } });
    expect(view.nodes.filter((n: { oldPorts: boolean }) => n.oldPorts).map((n: { name: string }) => n.name).sort()).toEqual(['ingest-ams', 'relay-ams']);

    const off = await t.app.inject({ method: 'PUT', url: '/api/nodes/port-plan', headers: admin, payload: { thisServer: false, nodes: [{ id: relay, oldPorts: false }] } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ thisServer: false, oldShoutcast: 0 });
    // The Shoutcast v1 pair moved into the new range.
    const [st] = await t.db.select({ legacyPort: schema.stations.legacyPort }).from(schema.stations).where(eq(schema.stations.id, stationId));
    expect(st!.legacyPort).toBe(8210);
    // Pushes now go to the new push port.
    expect((await buildPlan(t.ctx, await nodeRow(relay))).relay).toMatchObject({ pushPort: 8301, pushPorts: [8301] });
    expect((await buildPlan(t.ctx, await nodeRow(ingest))).ingest!.stations[0]!.targets[0]).toMatchObject({ port: 8301 });
    // Only the administrator manages it.
    expect((await t.app.inject({ method: 'GET', url: '/api/nodes/port-plan', headers: { cookie: '' } })).statusCode).toBe(401);
  });

  it('gives a station node its own ports, unless a port of its own was chosen', () => {
    expect(streamingSchema.parse(withStationNodePorts({}))).toMatchObject({ ingestPlainPort: 8400, ingestTlsPort: 8401, sftp: { port: 8402 } });
    expect(streamingSchema.parse(withStationNodePorts({ ingestPlainPort: 8010, ingestTlsPort: 8201, sftp: { enabled: true, port: 2022 } }))).toMatchObject({ ingestPlainPort: 8400, ingestTlsPort: 8401, sftp: { port: 8402 } });
    expect(streamingSchema.parse(withStationNodePorts({ ingestPlainPort: 9000 }))).toMatchObject({ ingestPlainPort: 9000 });
  });
});
