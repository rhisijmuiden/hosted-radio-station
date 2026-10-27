import { readFileSync } from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetRelays } from '../src/services/nodes/routing.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let owner: { cookie: string };
let tenantId: string;
let stationId: string;
let base: string;

/** A fake node agent on the control channel that answers pings. */
function agent(nodeId: string, secret: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/nodes/connect`);
  const opened = new Promise<void>((resolve) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', protocol: 1, nodeId, secret, version: '0.1.0', commit: 'abc1234', hostname: 'node-host', facts: { caddy: false, cores: 2, addresses: ['192.168.1.20'] } }));
      resolve();
    };
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', seq: m.seq }));
  };
  return { opened, send: (m: Record<string, unknown>) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

async function pair(body: Record<string, unknown>, headers = admin) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers, payload: body });
  expect(res.statusCode).toBe(201);
  const { node, pairing } = res.json();
  const p = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code, hostname: 'node-host' } });
  return { id: node.id as string, secret: p.json().secret as string };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await setup({ PUBLIC_URL: 'https://onlineradio.example.com' });
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: {
      name: 'Schermer',
      slug: 'schermer',
      plan: 'station',
      limits: { maxStations: 5, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 10, maxNodes: 2 },
      owner: { email: 'owner@schermer.nl', name: 'Owner', password: 'owner-password' },
    },
  });
  tenantId = res.json().id;
  owner = await login(t.app, 'owner@schermer.nl', 'owner-password');
  stationId = (await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Radio Schermer', slug: 'schermer-fm', maxListeners: 50 } })).json().id;
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(() => t.close());

describe('server names (phase 18)', () => {
  let relay: { id: string; secret: string };

  it('names this server after its host name, and its roles after it', async () => {
    const names = (await t.app.inject({ method: 'GET', url: '/api/nodes/names', headers: admin })).json();
    expect(names.orchestrator).toMatchObject({ name: '', default: 'onlineradio', shown: 'onlineradio', host: 'onlineradio.example.com' });
    expect(names.ingest.shown).toBe('onlineradio · ingest');
    expect(names.relay.shown).toBe('onlineradio · relay');
    expect((await t.app.inject({ method: 'GET', url: '/api/nodes/names', headers: owner })).statusCode).toBe(403);
  });

  it('renames everything in one go, and keeps every name unique', async () => {
    relay = await pair({ name: 'radionode1', location: 'Amsterdam', roles: ['relay'] });
    const put = (payload: Record<string, unknown>) => t.app.inject({ method: 'PUT', url: '/api/nodes/names', headers: admin, payload });
    const dup = await put({ orchestrator: 'hub', ingest: '', relay: '', nodes: [{ id: relay.id, name: 'HUB' }] });
    expect(dup.statusCode).toBe(409);
    expect((await put({ orchestrator: 'bad/name', ingest: '', relay: '', nodes: [] })).statusCode).toBe(400);
    const ok = await put({ orchestrator: 'hub', ingest: '', relay: 'hub-direct', nodes: [{ id: relay.id, name: 'relay1-ams' }] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ orchestrator: { shown: 'hub' }, ingest: { shown: 'hub · ingest' }, relay: { shown: 'hub-direct' } });
    expect(ok.json().nodes.find((n: { id: string }) => n.id === relay.id).name).toBe('relay1-ams');
    // A new node cannot take a name that is in use, not even with other capitals.
    expect((await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name: 'Relay1-AMS', roles: ['relay'] } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name: 'hub · ingest', roles: ['relay'] } })).statusCode).toBe(409);
  });

  it('uses the names in the topology', async () => {
    const topo = (await t.app.inject({ method: 'GET', url: '/api/nodes/topology', headers: admin })).json();
    expect(topo.main).toMatchObject({ name: 'hub', host: 'onlineradio.example.com', orchestratorOnly: false });
    expect(topo.nodes.find((n: { id: string }) => n.id === 'local:ingest')?.name).toBe('hub · ingest');
    expect(topo.nodes.find((n: { id: string }) => n.id === relay.id)?.name).toBe('relay1-ams');
    // Every station has its path for the per station view and the matrix.
    const st = topo.stations.find((s: { id: string }) => s.id === stationId);
    expect(st).toMatchObject({ name: 'Radio Schermer', ingest: 'local:ingest', backup: null, stationNode: null });
    expect(st.relays).toContain(relay.id);
    expect(st.cells[relay.id]).toBe('down');
  });
});

describe('orchestrator only (phase 18)', () => {
  let ingest: { id: string; secret: string };
  let a: ReturnType<typeof agent>;

  it('lists the stations that still use this server, and refuses to switch on while they do', async () => {
    const view = (await t.app.inject({ method: 'GET', url: '/api/nodes/orchestrator', headers: admin })).json();
    expect(view.only).toBe(false);
    expect(view.stations).toEqual([expect.objectContaining({ id: stationId, uses: expect.arrayContaining(['ingest', 'listeners']) })]);
    const res = await t.app.inject({ method: 'PUT', url: '/api/nodes/orchestrator', headers: admin, payload: { only: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('Radio Schermer');
  });

  it('switches on once every station has an ingest node', async () => {
    ingest = await pair({ name: 'ingest-ams', location: 'Amsterdam', roles: ['source'] });
    a = agent(ingest.id, ingest.secret);
    await a.opened;
    await wait(300);
    expect((await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/routing`, headers: admin, payload: { ingest: ingest.id } })).statusCode).toBe(200);
    const res = await t.app.inject({ method: 'PUT', url: '/api/nodes/orchestrator', headers: admin, payload: { only: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ only: true, stations: [], ingestNodes: 1 });
  });

  it('blocks every way back to audio on this server', async () => {
    // Not as ingest, not as backup.
    const back = await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/routing`, headers: admin, payload: { ingest: ingest.id, backupIngest: 'local' } });
    expect(back.statusCode).toBe(400);
    const routing = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: owner })).json();
    expect(routing.orchestratorOnly).toBe(true);
    // A new station gets the ingest node; a Radio station needs a station node.
    const created = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Night FM', slug: 'night-fm', maxListeners: 10 } });
    expect(created.statusCode).toBe(201);
    const r = (await t.app.inject({ method: 'GET', url: `/api/stations/${created.json().id}/routing`, headers: owner })).json();
    expect(r.routing.ingest).toBe(ingest.id);
    const radio = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Auto FM', slug: 'auto-fm', edition: 'station', maxListeners: 10 } });
    expect(radio.statusCode).toBe(409);
    // Listeners never come here: no relay has the stream, so there is nothing to hear.
    forgetRelays();
    expect((await t.app.inject({ method: 'GET', url: '/api/public/stations/schermer-fm/listen/live' })).statusCode).toBe(503);
    // No Icecast, AutoDJ or uploads here.
    const state = JSON.parse(readFileSync(join(t.ctx.config.DATA_DIR, 'run', 'streams-state.json'), 'utf8'));
    expect(state.stations.every((s: { enabled: boolean }) => !s.enabled)).toBe(true);
    expect(state.listen).toEqual([]);
    expect(state.sftpgo.enabled).toBe(false);
  });

  it('hands out the ingest node as the connection, without uploads here', async () => {
    const c = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/connection`, headers: owner })).json();
    expect(c.orchestratorOnly).toBe(true);
    expect(c.panelUrl).toBe('https://onlineradio.example.com');
    expect(c.endpoints).toEqual([expect.objectContaining({ role: 'ingest', name: 'ingest-ams', node: { id: ingest.id, name: 'ingest-ams' }, external: '127.0.0.1' })]);
    expect(c.endpoints[0].ports).toEqual(expect.arrayContaining([{ service: 'encoderPlain', port: 8010 }]));
    const detail = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}`, headers: owner })).json();
    expect(detail.connection.upload).toMatchObject({ sftpPort: null, ftpPort: null });
  });

  it('switches off again', async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/api/nodes/orchestrator', headers: admin, payload: { only: false } });
    expect(res.json().only).toBe(false);
    const c = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/connection`, headers: owner })).json();
    expect(c.endpoints.map((e: { role: string }) => e.role)).toEqual(['ingest', 'uploads']);
    a.close();
  });
});

describe('firewall checklist (phase 18)', () => {
  it('lists the ports of a customer node and checks them from outside', async () => {
    const node = await pair({ name: 'schermer-ingest', tenantId, roles: ['source'] }, owner);
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const open = (server.address() as AddressInfo).port;
    // One port that answers, one that does not.
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${node.id}`, headers: owner, payload: { config: { sourcePlainPort: open, sourceTlsPort: open === 65000 ? 65001 : 65000 } } });
    const a = agent(node.id, node.secret);
    await a.opened;
    await wait(300);
    const fw = (await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}/firewall`, headers: owner })).json();
    expect(fw).toMatchObject({ selfHosted: true, external: '127.0.0.1', internal: '192.168.1.20' });
    expect(fw.ports.map((p: { service: string }) => p.service).sort()).toEqual(['encoderPlain', 'encoderTls']);
    const checked = (await t.app.inject({ method: 'POST', url: `/api/nodes/${node.id}/firewall/check`, headers: owner })).json();
    expect(checked.checks[String(open)]).toMatchObject({ ok: true });
    expect(Object.values(checked.checks).filter((c) => !(c as { ok: boolean }).ok)).toHaveLength(1);
    // Another customer's node is not yours to see.
    expect((await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}/firewall`, headers: { cookie: '' } })).statusCode).toBe(401);
    a.close();
    server.close();
  });

  it('checks on the node\'s own address when its name is not in DNS (phase 19)', async () => {
    const node = await pair({ name: 'dc-relay', tenantId, roles: ['source'] }, owner);
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const open = (server.address() as AddressInfo).port;
    const patch = await t.app.inject({ method: 'PATCH', url: `/api/nodes/${node.id}`, headers: admin, payload: { config: { publicHost: 'dc-relay.invalid', publicAddress: '127.0.0.1', sourcePlainPort: open, sourceTlsPort: open === 65003 ? 65004 : 65003 } } });
    expect(patch.json()).not.toHaveProperty('error');
    const a = agent(node.id, node.secret);
    await a.opened;
    await wait(300);
    const checked = (await t.app.inject({ method: 'POST', url: `/api/nodes/${node.id}/firewall/check`, headers: owner })).json();
    expect(checked.dns).toEqual({ host: 'dc-relay.invalid', state: 'missing', checkedOn: '127.0.0.1' });
    expect(checked.checks[String(open)]).toMatchObject({ ok: true });
    a.close();
    server.close();
  }, 15_000);

  it('uses the public address a node looks up itself (phase 19)', async () => {
    const node = await pair({ name: 'nat-relay', roles: ['relay'] });
    const a = agent(node.id, node.secret);
    await a.opened;
    await wait(300);
    a.send({ t: 'stats', cpu: 0, memory: 0, load: 0, uptime: 1, rxBps: 0, txBps: 0, listeners: 0, encoders: 0, icmp: null, problems: [], update: null, revision: null, publicIp: '203.0.113.50' });
    await wait(300);
    const got = (await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}`, headers: admin })).json();
    expect(got.status.ip).toBe('203.0.113.50');
    // A private or malformed address is ignored.
    a.send({ t: 'stats', cpu: 0, memory: 0, load: 0, uptime: 1, rxBps: 0, txBps: 0, listeners: 0, encoders: 0, icmp: null, problems: [], update: null, revision: null, publicIp: '10.0.0.5' });
    await wait(300);
    expect((await t.app.inject({ method: 'GET', url: `/api/nodes/${node.id}`, headers: admin })).json().status.ip).toBe('203.0.113.50');
    a.close();
  });

  it('shows the push port of a relay as not in use while nothing pushes to it', async () => {
    // A customer without stations: nothing pushes to its relay.
    const other = await t.app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: admin,
      payload: { name: 'Quiet', slug: 'quiet', plan: 'distribution', limits: { maxStations: 1, maxListeners: 10, maxBitrateKbps: 128, storageQuotaMb: 10, maxNodes: 1 } },
    });
    const node = await pair({ name: 'quiet-relay', tenantId: other.json().id, roles: ['relay'] });
    await t.app.inject({ method: 'PATCH', url: `/api/nodes/${node.id}`, headers: admin, payload: { config: { pushPort: 65002 } } });
    const a = agent(node.id, node.secret);
    await a.opened;
    await wait(300);
    const checked = (await t.app.inject({ method: 'POST', url: `/api/nodes/${node.id}/firewall/check`, headers: admin })).json();
    expect(checked.checks['65002']).toMatchObject({ ok: false, message: 'idle' });
    a.close();
  });
});
