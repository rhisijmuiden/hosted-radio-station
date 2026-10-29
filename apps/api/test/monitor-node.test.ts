import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { evaluate } from '../src/services/alerts/rules.js';
import { buildPlan, MONITOR_LISTEN_SECONDS } from '../src/services/nodes/plan.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let stationId: string;
let relay: string;
let monitor: string;

async function pair(body: Record<string, unknown>) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: body });
  expect(res.statusCode).toBe(201);
  const { node, pairing } = res.json();
  const p = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code, hostname: 'node-host' } });
  return { id: node.id as string, secret: p.json().secret as string };
}
const nodeRow = async (id: string) => (await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, id)))[0]!;
const setOnline = async (id: string, online: boolean) => {
  const n = await nodeRow(id);
  await t.db.update(schema.nodes).set({ status: { ...n.status, online, ip: '192.0.2.10' } }).where(eq(schema.nodes.id, id));
};

let monitorSecret: string;

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const tenant = await t.app.inject({ method: 'POST', url: '/api/tenants', headers: admin, payload: { name: 'Harder', slug: 'harder', plan: 'station' } });
  stationId = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId: tenant.json().id, name: 'Harder.FM', slug: 'harder-fm' } })).json().id;
  const [live] = await t.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, stationId));
  await t.db.insert(schema.stationMounts).values({ stationId, path: '/low', kind: 'transcode', format: 'mp3', bitrateKbps: 64, sourceMountId: live!.id, isPublic: true, sortOrder: 5 });
  relay = (await pair({ name: 'pub-relay-01', roles: ['relay'] })).id;
  await t.app.inject({ method: 'PATCH', url: `/api/nodes/${relay}`, headers: admin, payload: { config: { publicHost: 'relay.example.com' } } });
  const m = await pair({ name: 'pub-monitor-01', roles: ['monitor'] });
  monitor = m.id;
  monitorSecret = m.secret;
  await setOnline(relay, true);
});
afterAll(() => t.close());

describe('monitoring node', () => {
  it('checks every stream deeply, and the other nodes stop their own checks while it is online', async () => {
    const before = await buildPlan(t.ctx, await nodeRow(relay));
    expect(before.probes?.targets.length).toBeGreaterThan(0);

    await setOnline(monitor, true);
    const plan = await buildPlan(t.ctx, await nodeRow(monitor));
    expect(plan.roles).toEqual(['monitor']);
    expect(plan.relay).toBeNull();
    const targets = plan.probes!.targets.map((x) => x.target);
    // Every public stream on this server, the default one through the relay as well.
    expect(targets).toEqual(['harder-fm/live@main', 'harder-fm/low@main', `harder-fm/live@${relay}`]);
    expect(plan.probes!.targets.every((x) => x.deep?.seconds === MONITOR_LISTEN_SECONDS)).toBe(true);
    expect((await buildPlan(t.ctx, await nodeRow(relay))).probes).toBeNull();

    await setOnline(monitor, false);
    expect((await buildPlan(t.ctx, await nodeRow(relay))).probes?.targets.length).toBeGreaterThan(0);
  });

  it('stores what the deep check measured', async () => {
    const at = new Date().toISOString();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/nodes/agent/report',
      headers: { authorization: `Node ${monitor}.${monitorSecret}` },
      payload: {
        relays: [],
        clients: [],
        probes: [{ target: 'harder-fm/live@main', stationId, url: 'http://x/listen/harder-fm/live', ok: true, httpStatus: 200, ttfbMs: 80, at, bitrateKbps: 127, contentType: 'audio/mpeg', title: 'Artist - Song', levelDb: -3.5, silent: false }],
      },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await t.db.select().from(schema.nodeProbes).where(eq(schema.nodeProbes.nodeId, monitor));
    expect(row).toMatchObject({ bitrateKbps: 127, contentType: 'audio/mpeg', title: 'Artist - Song', levelDb: -3.5, silent: false });
  });

  it('leaves a stream that never played out of the check status on the map', async () => {
    const at = new Date().toISOString();
    const report = (ok: boolean) =>
      t.app.inject({
        method: 'POST',
        url: '/api/nodes/agent/report',
        headers: { authorization: `Node ${monitor}.${monitorSecret}` },
        payload: { relays: [], clients: [], probes: [{ target: `harder-fm/low@${relay}`, stationId, url: 'http://x/low', ok, httpStatus: ok ? 200 : 404, ttfbMs: 50, at, ...(ok ? {} : { message: 'HTTP 404' }) }] },
      });
    expect((await report(false)).statusCode).toBe(200);
    const check = async () => (await t.app.inject({ method: 'GET', url: '/api/nodes/topology', headers: admin })).json().nodes.find((n: { id: string }) => n.id === relay)?.check;
    expect(await check()).toBeNull();
    // Once it played, a failure counts.
    await report(true);
    await report(false);
    expect(await check()).toBe('failed');
    // The badge names the check that fails.
    const topo = (await t.app.inject({ method: 'GET', url: '/api/nodes/topology', headers: admin })).json();
    expect(topo.checkFailures[relay]).toEqual([{ stream: expect.stringMatching(/ \/low$/), silent: false, message: 'HTTP 404' }]);
  });
});

describe('deep check rules', () => {
  const NOW = Date.now();
  const base = {
    now: NOW,
    nodes: [],
    stations: [{ id: 's1', name: 'Harder.FM', slug: 'harder-fm', enabled: true }],
    probeIntervalSeconds: 60,
    rollout: { current: null, paused: null },
    dns: { mode: 'off' as const, error: null },
    settings: { quietStations: [], maintenance: [] },
    orchestratorName: 'onlineradio',
    mounts: [
      { stationId: 's1', path: '/live', format: 'mp3', kind: 'source', bitrateKbps: 192 },
      { stationId: 's1', path: '/low', format: 'mp3', kind: 'transcode', bitrateKbps: 64 },
    ],
  };
  const probe = (target: string, extra: Record<string, unknown>) => ({ nodeId: 'm', target: `harder-fm${target}`, stationId: 's1', ok: true, message: null, checkedAt: new Date(NOW - 10_000), ...extra });

  it('says a station plays silence when every check hears nothing', () => {
    const out = evaluate({ ...base, probes: [probe('/live@main', { silent: true }), probe('/low@main', { silent: true })] });
    expect(out.map((c) => [c.kind, c.severity])).toEqual([['station_silent', 'critical']]);
    expect(evaluate({ ...base, probes: [probe('/live@main', { silent: true }), probe('/low@main', { silent: false })] })).toEqual([]);
  });

  it('flags a stream in the wrong format or a converted stream at the wrong bitrate', () => {
    const out = evaluate({ ...base, probes: [probe('/live@main', { contentType: 'audio/aac', bitrateKbps: 128 }), probe('/low@main', { contentType: 'audio/mpeg', bitrateKbps: 128 })] });
    expect(out.map((c) => [c.key, c.message])).toEqual([
      ['stream_quality:s1:/live', 'audio/aac instead of mp3'],
      ['stream_quality:s1:/low', '128 kbps instead of 64 kbps'],
    ]);
    // An encoder below its maximum is fine.
    expect(evaluate({ ...base, probes: [probe('/live@main', { contentType: 'audio/mpeg', bitrateKbps: 128 })] })).toEqual([]);
  });
});
