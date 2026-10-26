import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { signPreamble, verifyPreamble } from '../src/services/nodes/preamble.js';
import { forgetRelays } from '../src/services/nodes/routing.js';
import { eq } from 'drizzle-orm';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let owner: { cookie: string };
let tenantId: string;
let stationId: string;
let base: string;

/** A fake node agent on the control channel. */
function agent(nodeId: string, secret: string, version = '0.1.0') {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/nodes/connect`);
  const messages: Record<string, unknown>[] = [];
  const waiters: { t: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, nodeId, secret, version, commit: 'abc1234', hostname: 'relay-test', facts: { caddy: true, cores: 2, addresses: ['10.0.0.5'] } }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', seq: m.seq }));
    messages.push(m);
    for (const w of [...waiters]) if (w.t === m.t) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  };
  const closedP = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (ev) => resolve((closed = { code: ev.code, reason: ev.reason }));
  });
  return {
    ws,
    messages,
    closed: () => closed,
    closedP,
    next: (type: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const have = messages.find((m) => m.t === type);
        if (have) return resolve(have);
        waiters.push({ t: type, resolve });
      }),
    nextNew: (type: string) => new Promise<Record<string, unknown>>((resolve) => waiters.push({ t: type, resolve })),
  };
}

async function pair(cookie: { cookie: string }, body: Record<string, unknown>) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: cookie, payload: body });
  expect(res.statusCode).toBe(201);
  const { node, pairing } = res.json();
  const p = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code.toLowerCase().replace(/-/g, ''), hostname: 'relay-test' } });
  return { node, pairing, paired: p };
}

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: {
      name: 'Harder.fm',
      slug: 'harder',
      plan: 'distribution',
      limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 1, maxNodes: 1 },
      owner: { email: 'owner@harder.fm', name: 'Owner', password: 'owner-password' },
    },
  });
  tenantId = res.json().id;
  owner = await login(t.app, 'owner@harder.fm', 'owner-password');
  const st = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Harder FM', slug: 'harder-fm' } });
  stationId = st.json().id;
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(() => t.close());

describe('nodes', () => {
  it('pairs a node once with its one-time code', async () => {
    const { node, pairing, paired } = await pair(admin, { name: 'ams-relay-01', location: 'Amsterdam', roles: ['relay'] });
    expect(pairing.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(pairing.command).toContain('install-node.sh');
    expect(pairing.command).toContain(`--code ${pairing.code}`);
    expect(paired.statusCode).toBe(200);
    expect(paired.json()).toMatchObject({ nodeId: node.id, name: 'ams-relay-01', secret: expect.any(String) });
    // The code works only once.
    const again = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code } });
    expect(again.statusCode).toBe(400);
    const got = await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}`, headers: admin });
    expect(got.json()).toMatchObject({ paired: true, pairingExpiresAt: null, tenantId: null, roles: ['relay'] });
    const [row] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, node.id));
    // The secret is stored encrypted.
    expect(row!.secret).not.toContain(paired.json().secret);
  });

  it('connects an agent, sends it a plan and measures the round trip', async () => {
    const { node, paired } = await pair(admin, { name: 'fra-relay-02', location: 'Frankfurt', roles: ['relay'] });
    const a = agent(node.id, paired.json().secret);
    const welcome = await a.next('welcome');
    expect(welcome).toMatchObject({ nodeId: node.id, name: 'fra-relay-02' });
    const plan = (await a.next('plan')).plan as Record<string, any>;
    expect(plan).toMatchObject({ nodeId: node.id, roles: ['relay'], source: null });
    expect(plan.relay.mounts).toEqual([expect.objectContaining({ key: 'harder-fm/live', url: 'http://localhost:8000/listen/harder-fm/live' })]);
    expect(plan.revision).toEqual(expect.any(String));
    await a.next('ping');
    await new Promise((r) => setTimeout(r, 100));
    const got = (await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}`, headers: admin })).json();
    expect(got.status).toMatchObject({ online: true, version: '0.1.0', hostname: 'relay-test', caddy: true, rttMs: expect.any(Number) });
    expect(got.listenBase).toBe('http://127.0.0.1');

    // A change of settings is pushed as a new plan.
    const next = a.nextNew('plan');
    const patch = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${node.id}`, headers: admin, payload: { config: { publicHost: 'relay-fra.example.com', maxListeners: 500 } } });
    expect(patch.statusCode).toBe(200);
    const p2 = ((await next).plan as Record<string, any>);
    expect(p2.web.publicHost).toBe('relay-fra.example.com');
    expect(p2.relay.maxListeners).toBe(500);
    expect(p2.revision).not.toBe(plan.revision);

    // Unpairing closes the channel for good.
    await t.app.inject({ method: 'POST', url: `/api/nodes/${node.id}/unpair`, headers: admin });
    expect((await a.closedP).code).toBe(4401);
  });

  it('refuses agents with a wrong secret', async () => {
    const [n] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.name, 'ams-relay-01'));
    const a = agent(n!.id, 'wrong');
    expect((await a.closedP).code).toBe(4401);
  });

  it('stores relay reports, routes listeners to the relay and counts them in the statistics', async () => {
    const { node, paired } = await pair(admin, { name: 'lon-relay-03', location: 'London', roles: ['relay'] });
    const secret = paired.json().secret;
    const a = agent(node.id, secret);
    await a.next('plan');
    // Not on air on the relay yet: listeners stay on this server.
    const before = await t.app.inject({ method: 'GET', url: '/api/public/stations/harder-fm/listen/live' });
    expect(before.statusCode).toBe(302);
    expect(before.headers.location).toBe('/listen/harder-fm/live');

    const bad = await t.app.inject({ method: 'POST', url: '/api/nodes/agent/report', headers: { authorization: `Node ${node.id}.nope` }, payload: {} });
    expect(bad.statusCode).toBe(401);
    const report = await t.app.inject({
      method: 'POST',
      url: '/api/nodes/agent/report',
      headers: { authorization: `Node ${node.id}.${secret}` },
      payload: {
        relays: [{ key: 'harder-fm/live', state: 'connected', bitrateKbps: 128, listeners: 2 }, { key: 'other/live', state: 'connected' }],
        clients: [
          { key: 'harder-fm/live', id: '1', ip: '203.0.113.9', userAgent: 'VLC/3.0', referer: null, connectedSeconds: 30 },
          { key: 'harder-fm/live', id: '2', ip: '198.51.100.4', userAgent: 'Mozilla/5.0', referer: null, connectedSeconds: 90 },
          { key: 'other/live', id: '3', ip: '198.51.100.5', userAgent: 'x', referer: null, connectedSeconds: 9 },
        ],
        probes: [{ target: `${stationId}/live@main`, stationId, url: 'http://localhost:8000/listen/harder-fm/live', ok: true, httpStatus: 200, ttfbMs: 42, at: new Date().toISOString() }],
      },
    });
    expect(report.statusCode).toBe(200);
    const got = (await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}`, headers: admin })).json();
    // Only mounts the node carries count.
    expect(got.status.relays).toEqual([expect.objectContaining({ key: 'harder-fm/live', state: 'connected' })]);
    expect(got.status.listeners).toBe(2);
    const [row] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, node.id));
    expect(row!.clients).toHaveLength(2);

    // Two minutes in the same hour (the previous one), so they fall in one hourly bucket.
    const hour = Math.floor(Date.now() / 3600_000) * 3600_000 - 3600_000;
    await t.db.insert(schema.nodeMetrics).values([
      { nodeId: node.id, at: new Date(hour + 60_000), rttAvg: 10, rttMax: 20, pings: 12, lost: 0, cpu: 0.2, memory: 0.4, rxBps: 1000, txBps: 5000, listeners: 2 },
      { nodeId: node.id, at: new Date(hour + 120_000), rttAvg: 30, rttMax: 60, pings: 12, lost: 3, cpu: 0.3, memory: 0.4, rxBps: 1000, txBps: 7000, listeners: 4 },
    ]);
    const metrics = await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}/metrics?hours=168`, headers: admin });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toEqual([expect.objectContaining({ rttAvg: 20, rttMax: 60, pings: 24, lost: 3, listeners: 4 })]);
    expect((await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}/metrics?hours=2`, headers: admin })).json()).toHaveLength(2);

    const probes = (await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}/probes`, headers: admin })).json();
    expect(probes).toEqual([expect.objectContaining({ stationName: 'Harder FM', where: 'main', ok: true, ttfbMs: 42, uptime24h: 1 })]);

    forgetRelays();
    const routed = await t.app.inject({ method: 'GET', url: '/api/public/stations/harder-fm/listen/live?x=1' });
    expect(routed.statusCode).toBe(302);
    expect(routed.headers.location).toBe('http://127.0.0.1/listen/harder-fm/live?x=1');
    const missing = await t.app.inject({ method: 'GET', url: '/api/public/stations/harder-fm/listen/nope' });
    expect(missing.statusCode).toBe(404);

    // Switched off: everybody listens here.
    await t.app.inject({ method: 'PUT', url: '/api/nodes/settings', headers: admin, payload: { autoUpdate: true, routeListeners: false, probeIntervalSeconds: 60, latencyWarnMs: 150, metricsRetentionDays: 30 } });
    const local = await t.app.inject({ method: 'GET', url: '/api/public/stations/harder-fm/listen/live' });
    expect(local.headers.location).toBe('/listen/harder-fm/live');

    const topo = (await t.app.inject({ method: 'GET', url: '/api/nodes/topology', headers: admin })).json();
    expect(topo.view).toBe('admin');
    expect(topo.nodes.find((n: { id: string }) => n.id === node.id)).toMatchObject({ online: true, listeners: 2, relaysUp: 1 });
    expect(topo.links).toEqual(expect.arrayContaining([expect.objectContaining({ from: node.id, to: 'main', kind: 'control' }), expect.objectContaining({ from: 'main', to: node.id, kind: 'stream' })]));

    // The station page counts the listeners on the relay with the mount they listen to.
    const status = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/status`, headers: admin })).json();
    expect(status.listeners).toBe(2);
    expect(status.mounts.find((m: { path: string }) => m.path === '/live')).toMatchObject({ listeners: 2 });
    a.ws.close();
  });

  it('lets customers add own nodes within their limit, and hides other nodes', async () => {
    const list = (await t.app.inject({ method: 'GET', url: '/api/nodes', headers: owner })).json();
    expect(list).toEqual([]);
    const platform = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: owner, payload: { name: 'mine' } });
    expect(platform.statusCode).toBe(403);
    const own = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: owner, payload: { name: 'harder-01', tenantId, roles: ['source'] } });
    expect(own.statusCode).toBe(201);
    const second = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: owner, payload: { name: 'harder-02', tenantId } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toMatch(/1 own node/);
    const [other] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.name, 'lon-relay-03'));
    expect((await t.app.inject({ method: 'GET', url: `/api/nodes/${other!.id}`, headers: owner })).statusCode).toBe(403);
    // A customer node carries only that customer's stations.
    const foreign = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${own.json().node.id}`, headers: owner, payload: { config: { relayStations: ['00000000-0000-4000-8000-000000000000'] } } });
    expect(foreign.statusCode).toBe(400);

    // My setup: own node by name, the platform relay that carries the station without its name.
    const topo = (await t.app.inject({ method: 'GET', url: '/api/nodes/topology', headers: owner })).json();
    expect(topo.view).toBe('customer');
    expect(topo.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['Relay · Amsterdam', 'Relay · London', 'harder-01']);
  });

  it('routes encoders of a customer domain through its source node', async () => {
    const [own] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.name, 'harder-01'));
    const d = await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/domains`, headers: owner, payload: { domain: 'harder.fm' } });
    expect(d.statusCode).toBe(201);
    const set = await t.app.inject({ method: 'PUT', url: `/api/tenants/${tenantId}/domains/${d.json().id}/ingest-node`, headers: owner, payload: { nodeId: own!.id } });
    expect(set.statusCode).toBe(200);
    expect(set.json().ingestNodeId).toBe(own!.id);
    const [relay] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.name, 'lon-relay-03'));
    const wrong = await t.app.inject({ method: 'PUT', url: `/api/tenants/${tenantId}/domains/${d.json().id}/ingest-node`, headers: owner, payload: { nodeId: relay!.id } });
    expect(wrong.statusCode).toBeGreaterThanOrEqual(400);
    const node = (await t.app.inject({ method: 'GET', url: `/api/nodes/${own!.id}`, headers: owner })).json();
    expect(node.ingestHosts).toEqual(['src.harder.fm']);
  });

  it('signs and checks the encoder preamble', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const line = signPreamble('s3cret', { nodeId: id, via: 'tls', ip: '203.0.113.7', host: 'src.example.com' });
    const secretOf = (n: string) => (n === id ? 's3cret' : null);
    expect(verifyPreamble(line, secretOf)).toEqual({ nodeId: id, via: 'tls', ip: '203.0.113.7', host: 'src.example.com' });
    expect(verifyPreamble(line.replace('203.0.113.7', '203.0.113.8'), secretOf)).toBeNull();
    expect(verifyPreamble(line, () => 'other')).toBeNull();
    const old = signPreamble('s3cret', { nodeId: id, via: 'plain', ip: '203.0.113.7', host: null }, Date.now() - 600_000);
    expect(verifyPreamble(old, secretOf)).toBeNull();
  });
});
