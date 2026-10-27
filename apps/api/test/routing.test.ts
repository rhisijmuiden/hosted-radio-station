import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { forgetRelays } from '../src/services/nodes/routing.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let owner: { cookie: string };
let tenantId: string;
let stationId: string;
let base: string;

/** A fake node agent on the control channel. */
function agent(nodeId: string, secret: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/nodes/connect`);
  const messages: Record<string, any>[] = [];
  const waiters: { match: (m: Record<string, any>) => boolean; resolve: (m: Record<string, any>) => void }[] = [];
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, nodeId, secret, version: '0.1.0', commit: 'abc1234', hostname: 'node-test', facts: { caddy: true, cores: 2, addresses: ['10.0.0.9'] } }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', seq: m.seq }));
    messages.push(m);
    for (const w of [...waiters]) if (w.match(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  };
  const wait = (match: (m: Record<string, any>) => boolean, fresh = false) =>
    new Promise<Record<string, any>>((resolve) => {
      const have = fresh ? undefined : [...messages].reverse().find(match);
      if (have) return resolve(have);
      waiters.push({ match, resolve });
    });
  return {
    send: (m: Record<string, unknown>) => ws.send(JSON.stringify(m)),
    plan: (fresh = false) => wait((m) => m.t === 'plan', fresh).then((m) => m.plan),
    planWhere: (ok: (p: Record<string, any>) => boolean) => wait((m) => m.t === 'plan' && ok(m.plan)).then((m) => m.plan),
    auth: async (q: Record<string, unknown>) => {
      const id = Math.floor(Math.random() * 1e9);
      ws.send(JSON.stringify({ t: 'auth', id, purpose: 'source', ip: '203.0.113.7', ...q }));
      return wait((m) => m.t === 'auth_result' && m.id === id, true);
    },
    close: () => ws.close(),
  };
}

async function pair(body: Record<string, unknown>, headers = admin) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers, payload: body });
  expect(res.statusCode).toBe(201);
  const { node, pairing } = res.json();
  const p = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code, hostname: 'node-test' } });
  return { id: node.id as string, secret: p.json().secret as string };
}

const routing = (payload: Record<string, unknown>, headers = admin) => t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/routing`, headers, payload });

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
  tenantId = res.json().id;
  owner = await login(t.app, 'owner@schermer.nl', 'owner-password');
  const st = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Radio Schermer', slug: 'schermer-fm' } });
  stationId = st.json().id;
  await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/accounts`, headers: owner, payload: { username: 'dj1', displayName: 'DJ One', password: 'dj1-password' } });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(() => t.close());

describe('orchestrator as control plane (phase 13)', () => {
  let ingest: { id: string; secret: string };
  let backup: { id: string; secret: string };
  let relay: { id: string; secret: string };

  it('starts with this server as ingest and the relays pulling from it', async () => {
    const got = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: owner })).json();
    expect(got.routing).toEqual({ ingest: 'local', backupIngest: null, relays: 'auto', spareRelays: true });
    expect(got.canEdit).toBe(true);
  });

  it('checks the nodes a station is routed to', async () => {
    ingest = await pair({ name: 'ingest-ams', location: 'Amsterdam', roles: ['source'] });
    backup = await pair({ name: 'ingest-fra', location: 'Frankfurt', roles: ['source'] });
    relay = await pair({ name: 'relay-ams', location: 'Amsterdam', roles: ['relay'] });
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${relay.id}`, headers: admin, payload: { config: { publicHost: 'relay-ams.example.com' } } });
    expect((await routing({ ingest: relay.id })).json().error.message).toMatch(/ingest role/);
    expect((await routing({ ingest: randomUUID() })).statusCode).toBe(400);
    // Platform nodes are the administrator's to hand out.
    expect((await routing({ ingest: ingest.id }, owner)).statusCode).toBe(403);
    const ok = await routing({ ingest: ingest.id, backupIngest: backup.id, relays: [relay.id] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().routing).toEqual({ ingest: ingest.id, backupIngest: backup.id, relays: [relay.id], spareRelays: true });
    // Encoders now go to the ingest node; the backup is shown for the encoder's backup server.
    const detail = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}`, headers: owner })).json();
    expect(detail.connection.node).toMatchObject({ id: ingest.id, name: 'ingest-ams' });
    expect(detail.connection.backup.node).toMatchObject({ id: backup.id });
    expect(detail.connection.mounts[0].listenUrl).toContain('/api/public/stations/schermer-fm/listen/live');
  });

  it('plans the ingest nodes to push straight to the relays, and the relays to take pushes', async () => {
    forgetRelays();
    const r = agent(relay.id, relay.secret);
    const relayPlan = await r.plan();
    expect(relayPlan.relay.mounts).toEqual([expect.objectContaining({ key: 'schermer-fm/live', url: null, push: { token: expect.any(String) } })]);
    // This server has no audio of the station, so no probe looks for it here.
    expect((relayPlan.probes?.targets ?? []).some((p: { target: string }) => p.target.endsWith('@main'))).toBe(false);

    const a = agent(ingest.id, ingest.secret);
    const plan = await a.planWhere((p) => p.ingest?.stations?.[0]?.targets?.length > 0);
    const s = plan.ingest.stations[0];
    expect(s).toMatchObject({ stationId, slug: 'schermer-fm', priority: 0, mounts: [expect.objectContaining({ path: '/live', kind: 'source' })] });
    expect(s.targets[0]).toMatchObject({ nodeId: relay.id, host: 'relay-ams.example.com', port: 8001, insecureTls: false });
    // The relay checks the same token on its push port.
    expect(s.targets[0].tokens['schermer-fm/live']).toBe(relayPlan.relay.mounts[0].push.token);

    const b = agent(backup.id, backup.secret);
    expect((await b.planWhere((p) => !!p.ingest?.stations?.length)).ingest.stations[0].priority).toBe(1);

    // Log-ins are checked here; the node only learns yes or no.
    expect(await a.auth({ stationId, mount: '/live', user: 'dj1', pass: 'dj1-password' })).toMatchObject({ ok: true, accountName: 'DJ One', limitKbps: 192 });
    expect(await a.auth({ stationId, mount: '/live', user: 'dj1', pass: 'wrong' })).toMatchObject({ ok: false });
    expect(await a.auth({ stationId, mount: '/nope', user: 'dj1', pass: 'dj1-password' })).toMatchObject({ ok: false });
    // A node that is no ingest of the station gets nothing.
    expect(await r.auth({ stationId, mount: '/live', user: 'dj1', pass: 'dj1-password' })).toMatchObject({ ok: false });

    // Broadcasts on the node are logged here, and ended when the node no longer has them.
    const sessionId = randomUUID();
    a.send({ t: 'live', action: 'start', sessionId, stationId, mount: '/live', accountName: 'DJ One', via: 'tls', ip: '203.0.113.7' });
    await new Promise((res) => setTimeout(res, 300));
    const [row] = await t.db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, sessionId));
    expect(row).toMatchObject({ nodeId: ingest.id, onNode: true, endedAt: null, accountName: 'DJ One' });
    a.send({ t: 'live_sync', sessionIds: [] });
    await new Promise((res) => setTimeout(res, 300));
    const [ended] = await t.db.select().from(schema.liveSessions).where(and(eq(schema.liveSessions.id, sessionId)));
    expect(ended!.endedAt).not.toBeNull();

    // On air on the ingest: the topology shows audio from the ingest to the relay, and only control to the orchestrator.
    a.send({ t: 'stats', cpu: 0.1, memory: 0.2, load: 0, uptime: 1, rxBps: 0, txBps: 0, listeners: 0, encoders: 1, icmp: null, problems: [], update: null, revision: null, ingest: [{ stationId, mount: '/live', title: 'Artist - Song', bitrateKbps: 128, contentType: 'audio/mpeg', pushing: [relay.id] }] });
    await t.app.inject({ method: 'POST', url: '/api/nodes/agent/report', headers: { authorization: `Node ${relay.id}.${relay.secret}` }, payload: { relays: [{ key: 'schermer-fm/live', state: 'connected' }], clients: [], probes: [] } });
    await new Promise((res) => setTimeout(res, 300));
    const topo = (await t.app.inject({ method: 'GET', url: '/api/nodes/topology', headers: admin })).json();
    expect(topo.links).toEqual(expect.arrayContaining([expect.objectContaining({ from: ingest.id, to: relay.id, kind: 'stream' })]));
    expect(topo.links.filter((l: { kind: string; from: string; to: string }) => l.kind === 'stream' && (l.from === 'main' || l.to === 'main'))).toEqual([]);
    const status = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: owner })).json().status;
    expect(status.active).toBe(ingest.id);
    for (const x of [a, b, r]) x.close();
  });

  it('sends listeners only to relays, and says so when none has the stream', async () => {
    await new Promise((res) => setTimeout(res, 300));
    forgetRelays();
    const res = await t.app.inject({ method: 'GET', url: '/api/public/stations/schermer-fm/listen/live' });
    expect(res.statusCode).toBe(503);
  });

  it('sends a new plan when the routing changes while the node is connected', async () => {
    await routing({ ingest: 'local', backupIngest: null, relays: 'auto' });
    const a = agent(ingest.id, ingest.secret);
    await a.planWhere((p) => !p.ingest?.stations?.length);
    await routing({ ingest: ingest.id, backupIngest: backup.id, relays: 'auto' });
    const p = await Promise.race([a.planWhere((p) => p.ingest?.stations?.length > 0), new Promise((r) => setTimeout(() => r(null), 5000))]);
    expect(p).not.toBeNull();
    a.close();
  });

  it('passes encoders on to a direct address when one is set', async () => {
    const cur = (await t.app.inject({ method: 'GET', url: '/api/nodes/settings', headers: admin })).json();
    expect((await t.app.inject({ method: 'PUT', url: '/api/nodes/settings', headers: admin, payload: { ...cur, ingestAddress: '10.10.4.240' } })).statusCode).toBe(200);
    const a = agent(ingest.id, ingest.secret);
    const plan = await a.planWhere((p) => p.source?.upstream?.host === '10.10.4.240');
    expect(plan.source.upstream).toMatchObject({ host: '10.10.4.240', tls: false });
    a.close();
  });

  it('keeps this server as the main ingest of a Radio station', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/tenants/${tenantId}`, headers: admin, payload: { plan: 'station' } });
    const up = await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}`, headers: admin, payload: { edition: 'station' } });
    expect(up.statusCode).toBe(200);
    const got = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: admin })).json();
    expect(got.routing).toMatchObject({ ingest: 'local', backupIngest: backup.id });
    expect((await routing({ ingest: ingest.id })).statusCode).toBe(400);
  });
});

describe('relays of a station on a station node (phase 19)', () => {
  it('lets the relays be chosen while the ingest stays the station node, and lists chosen relays that can no longer carry it', async () => {
    const node = await pair({ name: 'studio-node', roles: ['station'] });
    const relay2 = await pair({ name: 'relay-two', roles: ['relay'] });
    const before = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: admin })).json();
    await t.db.update(schema.stations).set({ nodeId: node.id }).where(eq(schema.stations.id, stationId));
    try {
      const got = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: admin })).json();
      expect(got.locked).toBe('station_node');
      expect(got.canEdit).toBe(true);
      // The ingest fields are ignored on a station node; only the relays change.
      const r = await routing({ ingest: randomUUID(), relays: [relay2.id], spareRelays: false });
      expect(r.statusCode).toBe(200);
      expect(r.json().routing).toEqual({ ...before.routing, relays: [relay2.id], spareRelays: false });
      // A chosen relay that lost its relay role is listed as stale, so the panel can say why it carries nothing.
      await t.db.update(schema.nodes).set({ roles: ['source'] }).where(eq(schema.nodes.id, relay2.id));
      const stale = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: admin })).json();
      expect(stale.stale).toEqual([{ id: relay2.id, name: 'relay-two' }]);
      // Listeners are sent to the relays: the listen URL goes through the redirect, and /listen/ on this server (where
      // the station does not play) redirects too instead of ending on the panel's "Page not found".
      const detail = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}`, headers: admin })).json();
      expect(detail.connection.mounts[0].listenUrl).toContain('/api/public/stations/schermer-fm/listen/live');
      // TLS for encoders only on a public name with the node's web server: an internal name or a LAN address only ever
      // has a self-signed certificate, which RHIS Studio and encoders refuse.
      const tlsFor = async (config: Record<string, unknown>) => {
        const [row] = await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, node.id));
        await t.db.update(schema.nodes).set({ config: { ...row!.config, ...config }, status: { ...row!.status, caddy: true } }).where(eq(schema.nodes.id, node.id));
        return (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}`, headers: admin })).json().connection as { ingestHost: string; tls: { available: boolean } };
      };
      expect((await tlsFor({ publicHost: 'radionode3.mngt.onzehut.loc', lanAddress: '' })).tls.available).toBe(false);
      expect(await tlsFor({ publicHost: 'studio.radio.example.com', lanAddress: '' })).toMatchObject({ ingestHost: 'studio.radio.example.com', tls: { available: true } });
      expect(await tlsFor({ lanAddress: '10.0.0.9' })).toMatchObject({ ingestHost: '10.0.0.9', tls: { available: false } });
      const direct = await t.app.inject({ method: 'GET', url: '/listen/schermer-fm/live' });
      expect(direct.statusCode).toBe(503);
      expect(direct.json().error.code).toBe('no_relay');
      expect((await t.app.inject({ method: 'GET', url: '/listen/schermer-fm/nope' })).statusCode).toBe(404);
    } finally {
      await t.db.update(schema.stations).set({ nodeId: null, routing: before.routing }).where(eq(schema.stations.id, stationId));
      forgetRelays();
    }
  });
});
