import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { buildPlan } from '../src/services/nodes/plan.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let base: string;

/** A node agent on the control channel that says hello with these addresses and features, and answers pings. */
function agent(nodeId: string, secret: string, addresses: string[], features: string[]) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/nodes/connect`);
  const welcomed = new Promise<void>((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, nodeId, secret, version: '0.1.0', commit: 'abc1234', hostname: 'node', facts: { caddy: false, cores: 1, addresses, features } }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', seq: m.seq }));
      if (m.t === 'welcome') resolve();
    };
  });
  return { welcomed, close: () => ws.close() };
}

/** A node created and paired the way a new one is, with its secret. */
async function created(name: string) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name, roles: ['relay'] } });
  const { node, pairing } = res.json();
  const paired = await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code, hostname: 'node-host' } });
  return { id: node.id as string, secret: paired.json().secret as string };
}

async function pair(body: Record<string, unknown>) {
  const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: body });
  expect(res.statusCode).toBe(201);
  const { node, pairing } = res.json();
  await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: pairing.code, hostname: 'node-host' } });
  return node.id as string;
}
const nodeRow = async (id: string) => (await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, id)))[0]!;
const patch = (id: string, config: Record<string, unknown>) => t.app.inject({ method: 'PATCH', url: `/api/nodes/${id}`, headers: admin, payload: { config } });

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  base = await t.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => t.close());

describe('node firewall (security hardening for external nodes)', () => {
  let ingest: string;
  let relay: string;

  it('is off by default, so nothing changes on nodes after the update', async () => {
    ingest = await pair({ name: 'ingest-fw', roles: ['source'] });
    const plan = await buildPlan(t.ctx, await nodeRow(ingest));
    expect(plan.firewall).toEqual({ enabled: false, takeOver: false, tcp: [], udp: [], sshFrom: [], sshLimit: true });
  });

  it('lets in the ports of the node\'s roles once it is switched on', async () => {
    expect((await patch(ingest, { firewall: { enabled: true } })).statusCode).toBe(200);
    expect((await buildPlan(t.ctx, await nodeRow(ingest))).firewall).toEqual({ enabled: true, takeOver: false, tcp: ['8200', '8201'], udp: [], sshFrom: [], sshLimit: true });

    relay = await pair({ name: 'relay-fw', roles: ['relay'] });
    await t.db.update(schema.nodes).set({ status: { online: true, caddy: true } }).where(eq(schema.nodes.id, relay));
    await patch(relay, { publicHost: 'relay-fw.example.com', firewall: { enabled: true } });
    // Listeners on 80 and 443, the push port, and 80 also for certificates.
    expect((await buildPlan(t.ctx, await nodeRow(relay))).firewall!.tcp).toEqual(['80', '443', '8301']);
  });

  it('keeps the other firewall settings when one of them changes, and adds extra ports', async () => {
    await patch(ingest, { firewall: { takeOver: true } });
    await patch(ingest, { firewall: { extraPorts: [{ port: 9000, to: 9010 }, { port: 5353, proto: 'udp' }] } });
    const c = (await nodeRow(ingest)).config.firewall;
    expect(c).toMatchObject({ enabled: true, takeOver: true });
    expect((await buildPlan(t.ctx, await nodeRow(ingest))).firewall).toEqual({ enabled: true, takeOver: true, tcp: ['8200', '8201', '9000-9010'], udp: ['5353'], sshFrom: [], sshLimit: true });
  });

  it('refuses invalid extra ports', async () => {
    expect((await patch(ingest, { firewall: { extraPorts: [{ port: 9010, to: 9000 }] } })).statusCode).toBe(400);
    expect((await patch(ingest, { firewall: { extraPorts: [{ port: 70000 }] } })).statusCode).toBe(400);
  });

  it('limits SSH to admin addresses and networks, and checks them', async () => {
    expect((await patch(ingest, { firewall: { sshFrom: ['203.0.113.5', '198.51.100.0/24', '2001:db8::/32'], sshLimit: false } })).statusCode).toBe(200);
    expect((await buildPlan(t.ctx, await nodeRow(ingest))).firewall).toMatchObject({ sshFrom: ['203.0.113.5', '198.51.100.0/24', '2001:db8::/32'], sshLimit: false });
    for (const bad of ['203.0.113.5/33', 'relay.example.com', '10.0.0.0/8/1', '2001:db8::/129', '1.2.3.4; drop']) {
      expect((await patch(ingest, { firewall: { sshFrom: [bad] } })).statusCode, bad).toBe(400);
    }
  });

  it('sends nothing to let in once it is switched off again', async () => {
    await patch(ingest, { firewall: { enabled: false } });
    expect((await buildPlan(t.ctx, await nodeRow(ingest))).firewall).toEqual({ enabled: false, takeOver: false, tcp: [], udp: [], sshFrom: [], sshLimit: true });
  });
});

describe('firewall by default for new nodes (step 4)', () => {
  const firewallOf = async (id: string) => (await nodeRow(id)).config.firewall;

  it('switches it on at the first connection of a new node with a public address of its own', async () => {
    const n = await created('dc-relay-fw');
    expect(await firewallOf(n.id)).toMatchObject({ auto: true });
    const a = agent(n.id, n.secret, ['198.51.100.9', '10.0.0.9'], ['firewall']);
    await a.welcomed;
    expect(await firewallOf(n.id)).toMatchObject({ enabled: true, auto: false });
    expect((await buildPlan(t.ctx, await nodeRow(n.id))).firewall).toMatchObject({ enabled: true });
    a.close();
  });

  it('leaves it off for a new node behind a router', async () => {
    const n = await created('lan-relay-fw');
    const a = agent(n.id, n.secret, ['10.10.4.130'], ['firewall']);
    await a.welcomed;
    expect(await firewallOf(n.id)).toMatchObject({ enabled: false, auto: false });
    a.close();
  });

  it('waits for software that has a firewall', async () => {
    const n = await created('old-agent-fw');
    const a = agent(n.id, n.secret, ['198.51.100.10'], []);
    await a.welcomed;
    expect(await firewallOf(n.id)).toMatchObject({ auto: true });
    a.close();
  });

  it('gives nodes from before the same default, except a firewall switched on by hand', async () => {
    const untouched = await created('existing-fw');
    const off = await created('existing-off-fw');
    const on = await created('existing-on-fw');
    await t.db.update(schema.nodes).set({ config: {} }).where(eq(schema.nodes.id, untouched.id));
    await t.db.update(schema.nodes).set({ config: { firewall: { enabled: false, takeOver: false, extraPorts: [] } } as never }).where(eq(schema.nodes.id, off.id));
    await t.db.update(schema.nodes).set({ config: { firewall: { enabled: true, takeOver: true, extraPorts: [] } } as never }).where(eq(schema.nodes.id, on.id));
    await t.db.execute(sql.raw(readFileSync(new URL('../drizzle/0031_node_firewall_existing.sql', import.meta.url), 'utf8')));
    expect(await firewallOf(untouched.id)).toEqual({ auto: true });
    expect(await firewallOf(off.id)).toMatchObject({ enabled: false, auto: true });
    expect(await firewallOf(on.id)).toEqual({ enabled: true, takeOver: true, extraPorts: [] });

    const b = agent(untouched.id, untouched.secret, ['198.51.100.11'], ['firewall']);
    await b.welcomed;
    expect(await firewallOf(untouched.id)).toMatchObject({ enabled: true, auto: false });
    b.close();
  });

  it('keeps a choice made by hand before the first connection', async () => {
    const n = await created('chosen-fw');
    await patch(n.id, { firewall: { enabled: false } });
    const a = agent(n.id, n.secret, ['198.51.100.12'], ['firewall']);
    await a.welcomed;
    expect(await firewallOf(n.id)).toMatchObject({ enabled: false, auto: false });
    a.close();
  });
});
