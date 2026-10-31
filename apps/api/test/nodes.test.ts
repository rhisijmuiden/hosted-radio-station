import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { signPreamble, verifyPreamble } from '../src/services/nodes/preamble.js';
import { forgetMissingStations, forgetRelays } from '../src/services/nodes/routing.js';
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
    expect(patch.json()).toMatchObject({ id: node.id });
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
    // The orchestrator only has control lines (phase 13); this server's own ingest and relay roles are shown apart.
    expect(topo.links).toEqual(expect.arrayContaining([expect.objectContaining({ from: node.id, to: 'main', kind: 'control' }), expect.objectContaining({ from: 'local:ingest', to: 'main', kind: 'control' })]));
    expect(topo.links.filter((l: { kind: string; from: string; to: string }) => l.kind === 'stream' && (l.from === 'main' || l.to === 'main'))).toEqual([]);
    expect(topo.nodes.filter((n: { local: boolean }) => n.local).map((n: { id: string }) => n.id)).toEqual(['local:ingest', 'local:relay']);

    // The station page counts the listeners on the relay with the mount they listen to.
    const status = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/status`, headers: admin })).json();
    expect(status.listeners).toBe(2);
    expect(status.mounts.find((m: { path: string }) => m.path === '/live')).toMatchObject({ listeners: 2 });

    // A listener that left is closed with the moment the node saw it leave.
    const [st] = await t.db.select({ tenantId: schema.stations.tenantId }).from(schema.stations).where(eq(schema.stations.id, stationId));
    const sessionId = randomUUID();
    const started = Date.now() - 100_000;
    await t.db.insert(schema.listenerSessions).values({ id: sessionId, stationId, tenantId: st!.tenantId, mountPath: '/live', via: 'relay', nodeId: node.id, clientKey: `node:${node.id}:/live:1`, startedAt: new Date(started) });
    const left = await t.app.inject({
      method: 'POST',
      url: '/api/nodes/agent/report',
      headers: { authorization: `Node ${node.id}.${secret}` },
      payload: { relays: [{ key: 'harder-fm/live', state: 'connected' }], clients: [], ended: [{ key: 'harder-fm/live', id: '1', endedAt: new Date(started + 70_000).toISOString() }], probes: [] },
    });
    expect(left.statusCode).toBe(200);
    const [closed] = await t.db.select().from(schema.listenerSessions).where(eq(schema.listenerSessions.id, sessionId));
    expect(closed!.durationSeconds).toBe(70);
    a.ws.close();
  });

  it('lets customers add own nodes within their limit, and hides other nodes', async () => {
    const list = (await t.app.inject({ method: 'GET', url: '/api/nodes', headers: owner })).json();
    expect(list).toEqual([]);
    const platform = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: owner, payload: { name: 'mine' } });
    expect(platform.statusCode).toBe(403);
    // A new customer may only run a station node of its own; other roles are switched on by the administrator.
    expect((await t.app.inject({ method: 'GET', url: `/api/tenants/${tenantId}`, headers: owner })).json().limits.nodeRoles).toEqual(['station']);
    const notAllowed = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: owner, payload: { name: 'harder-01', tenantId, roles: ['source'] } });
    expect(notAllowed.statusCode).toBe(403);
    expect(notAllowed.json().error.message).toMatch(/source role/);
    const limits = { maxStations: 2, maxRadioStations: 0, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 1, maxNodes: 1, nodeRoles: ['station', 'source'] };
    expect((await t.app.inject({ method: 'PATCH', url: `/api/tenants/${tenantId}`, headers: admin, payload: { limits } })).statusCode).toBe(200);
    // A client that leaves the node roles out keeps them.
    const { nodeRoles: _kept, ...older } = limits;
    expect((await t.app.inject({ method: 'PATCH', url: `/api/tenants/${tenantId}`, headers: admin, payload: { limits: older } })).json().limits.nodeRoles).toEqual(['station', 'source']);
    const own = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: owner, payload: { name: 'harder-01', tenantId, roles: ['source'] } });
    expect(own.statusCode).toBe(201);
    // Roles outside the package cannot be added later either; the ones it has may stay.
    const relay = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${own.json().node.id}`, headers: owner, payload: { roles: ['source', 'relay'] } });
    expect(relay.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/nodes/${own.json().node.id}`, headers: owner, payload: { roles: ['source'] } })).statusCode).toBe(200);
    const second = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: owner, payload: { name: 'harder-02', tenantId } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toMatch(/1 own node/);
    const [other] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.name, 'lon-relay-03'));
    expect((await t.app.inject({ method: 'GET', url: `/api/nodes/${other!.id}`, headers: owner })).statusCode).toBe(403);
    // A customer node carries only that customer's stations.
    const foreign = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${own.json().node.id}`, headers: owner, payload: { config: { relayStations: ['00000000-0000-4000-8000-000000000000'] } } });
    expect(foreign.statusCode).toBe(400);

    // My setup: own node and the platform relays that carry the station, all by their one name (phase 18), but host
    // name and address only of my own node.
    const topo = (await t.app.inject({ method: 'GET', url: '/api/nodes/topology', headers: owner })).json();
    expect(topo.view).toBe('customer');
    expect(topo.nodes.filter((n: { local: boolean }) => !n.local).map((n: { name: string }) => n.name).sort()).toEqual(['ams-relay-01', 'harder-01', 'lon-relay-03']);
    expect(topo.nodes.filter((n: { own: boolean; hostname: string | null }) => !n.own && n.hostname)).toEqual([]);
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

  it('runs an FM/MPX node: settings, plan with RDS, live DJ and the on-air status', async () => {
    const { node, pairing, paired } = await pair(admin, { name: 'fm-schermer', location: 'IJmuiden', roles: ['fm'] });
    expect(pairing.command).toContain('install-fm.sh');
    // A change sends only what changes; the rest keeps its value.
    let res = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${node.id}`, headers: admin, payload: { config: { fm: { stationId, pi: '8abc', ps: 'HARDERFM', af: [98.6, 101.2] } } } });
    expect(res.statusCode).toBe(200);
    res = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${node.id}`, headers: admin, payload: { config: { fm: { pty: 10 }, probe: false } } });
    expect(res.json().config.fm).toMatchObject({ stationId, pi: '8ABC', ps: 'HARDERFM', pty: 10, af: [98.6, 101.2], output: 'soundcard', rtSong: '{artist} - {title}' });
    expect(res.json().config).toMatchObject({ probe: false, publicHost: '' });
    const bad = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${node.id}`, headers: admin, payload: { config: { fm: { pi: 'XYZ1' } } } });
    expect(bad.statusCode).toBe(400);

    const a = agent(node.id, paired.json().secret);
    const plan = (await a.next('plan')).plan as Record<string, any>;
    expect(plan.roles).toEqual(['fm']);
    expect(plan.relay).toBeNull();
    expect(plan.fm).toMatchObject({
      station: { id: stationId, slug: 'harder-fm', name: 'Harder FM' },
      url: 'http://localhost:8000/listen/harder-fm/live',
      texts: { ps: 'HARDERFM', psMode: 'static' },
      rds: { enabled: true, pi: 0x8abc, pty: 10, af: [98.6, 101.2], timezone: 'Europe/Amsterdam' },
      output: { kind: 'soundcard', device: 'default', channels: 2 },
      uecp: null,
    });
    expect(await a.next('fm')).toMatchObject({ dj: null, show: null });

    // A DJ goes live: the node hears about it.
    const nextFm = a.nextNew('fm');
    await t.db.insert(schema.liveSessions).values({ stationId, mountPath: '/live', accountName: 'dj-rob', via: 'tls' });
    t.app.nodes.fmNotify(stationId);
    expect(await nextFm).toMatchObject({ dj: 'dj-rob' });

    // UECP to an existing encoder.
    const next = a.nextNew('plan');
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${node.id}`, headers: admin, payload: { config: { fm: { uecp: true, uecpHost: '10.0.0.20', uecpPort: 4001, output: 'none' } } } });
    expect(((await next).plan as Record<string, any>).fm).toMatchObject({ output: { kind: 'none' }, uecp: { transport: 'tcp', host: '10.0.0.20', port: 4001, site: 0, encoder: 0 } });

    const fm = { input: 'connected', title: 'Avicii - Levels', output: 'off', uecp: 'connected', meters: null, ps: 'HARDERFM', psFrames: ['HARDERFM'], rt: 'Avicii - Levels', tags: [{ type: 4, start: 0, length: 6 }], groups: { '0A': 10 }, evil: 'x'.repeat(10) };
    a.ws.send(JSON.stringify({ t: 'stats', cpu: 0.1, memory: 0.2, load: 0, uptime: 1, rxBps: 0, txBps: 0, listeners: 0, encoders: 0, icmp: null, problems: [], update: null, revision: null, fm }));
    await new Promise((r) => setTimeout(r, 150));
    const got = (await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}`, headers: admin })).json();
    expect(got.status.fm).toMatchObject({ input: 'connected', uecp: 'connected', rt: 'Avicii - Levels', tags: [{ type: 4, start: 0, length: 6 }] });
    expect(got.status.fm.evil).toBeUndefined();
    const topo = (await t.app.inject({ method: 'GET', url: '/api/nodes/topology', headers: admin })).json();
    expect(topo.nodes.find((n: { id: string }) => n.id === node.id)).toMatchObject({ fmOnAir: true });
    // The audio comes from this server's relay role (or a relay of the station), never from the orchestrator.
    expect(topo.links).toContainEqual(expect.objectContaining({ from: 'local:relay', to: node.id, kind: 'stream' }));
    a.ws.close();
  });

  it('puts Stereo Tool on an FM node: uploaded program, plan with local UECP, download for FM nodes only', async () => {
    const { node, paired } = await pair(admin, { name: 'fm-stereotool', roles: ['fm'] });
    // A tiny stand-in for the program: an ELF header for 64-bit x86-64.
    const elf = Buffer.alloc(64);
    elf.writeUInt32BE(0x7f454c46, 0);
    elf[4] = 2;
    elf.writeUInt16LE(0x3e, 18);
    const form = (file: Buffer, name: string) => {
      const boundary = 'xxBOUNDARYxx';
      return {
        headers: { ...admin, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      };
    };
    const notElf = await t.app.inject({ method: 'POST', url: '/api/nodes/stereotool', ...form(Buffer.from('hello'), 'readme.txt') });
    expect(notElf.statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/nodes/stereotool', headers: owner })).statusCode).toBe(403);
    const up = await t.app.inject({ method: 'POST', url: '/api/nodes/stereotool', ...form(elf, 'stereo_tool_cmd_64') });
    expect(up.statusCode).toBe(200);
    expect(up.json().binary).toMatchObject({ name: 'stereo_tool_cmd_64', size: 64 });
    const sha = up.json().binary.sha256 as string;

    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/nodes/${node.id}`,
      headers: admin,
      payload: { config: { fm: { stationId, processor: 'stereotool', stLicence: 'ABC-123', stExtraArgs: '--foo 1', uecp: true, uecpHost: '10.0.0.20' } } },
    });
    expect(res.statusCode).toBe(200);
    const a = agent(node.id, paired.json().secret);
    const plan = (await a.next('plan')).plan as Record<string, any>;
    expect(plan.fm.stereoTool).toEqual({ binary: { sha256: sha, size: 64 }, licence: 'ABC-123', mpx: 'stereotool', inputRate: 192000, webPort: 17010, uecpPort: 17011, extraArgs: ['--foo', '1'] });
    // Stereo Tool's own RDS encoder is on air: the UECP goes to it, not to the external encoder.
    expect(plan.fm.uecp).toMatchObject({ transport: 'tcp', host: '127.0.0.1', port: 17011 });
    const bad = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${node.id}`, headers: admin, payload: { config: { fm: { stExtraArgs: '; rm -rf /' } } } });
    expect(bad.statusCode).toBe(400);

    const auth = { authorization: `Node ${node.id}.${paired.json().secret}` };
    const got = await t.app.inject({ method: 'GET', url: '/api/nodes/agent/stereotool/binary', headers: auth });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(elf)).toBe(true);
    const relay = await pair(admin, { name: 'not-fm', roles: ['relay'] });
    const refused = await t.app.inject({ method: 'GET', url: '/api/nodes/agent/stereotool/binary', headers: { authorization: `Node ${relay.node.id}.${relay.paired.json().secret}` } });
    expect(refused.statusCode).toBe(403);

    // Removing the program takes it out of the plan.
    const next = a.nextNew('plan');
    expect((await t.app.inject({ method: 'DELETE', url: '/api/nodes/stereotool', headers: admin })).statusCode).toBe(200);
    expect(((await next).plan as Record<string, any>).fm.stereoTool.binary).toBeNull();
    a.ws.close();
  });

  it('takes a deleted station out of the relay nodes that carried it', async () => {
    // Room in the customer's listener budget for a second station.
    await t.db.update(schema.stations).set({ maxListeners: 50 }).where(eq(schema.stations.id, stationId));
    const created = await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId, name: 'Tmp FM', slug: 'tmp-fm' } });
    expect(created.json()).toMatchObject({ name: 'Tmp FM' });
    const tmp = created.json();
    const { node } = await pair(admin, { name: 'list-relay', roles: ['relay'] });
    const patch = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${node.id}`, headers: admin, payload: { config: { relayStations: [stationId, tmp.id] } } });
    expect(patch.json()).toMatchObject({ id: node.id });
    expect((await t.app.inject({ method: 'DELETE', url: `/api/stations/${tmp.id}`, headers: owner })).statusCode).toBe(200);
    const [row] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, node.id));
    expect(row!.config.relayStations).toEqual([stationId]);
  });

  it('cleans up a station that was deleted before the clean-up existed', async () => {
    const { node } = await pair(admin, { name: 'old-relay', roles: ['relay'] });
    const [row] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, node.id));
    await t.db.update(schema.nodes).set({ config: { ...row!.config, relayStations: [stationId, randomUUID()] } }).where(eq(schema.nodes.id, node.id));
    expect(await forgetMissingStations(t.ctx)).toBe(true);
    const [after] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, node.id));
    expect(after!.config.relayStations).toEqual([stationId]);
    expect(await forgetMissingStations(t.ctx)).toBe(false);
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
