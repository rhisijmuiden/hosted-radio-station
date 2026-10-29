import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { buildPlan } from '../src/services/nodes/plan.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };

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
});
afterAll(() => t.close());

describe('node firewall (security hardening for external nodes)', () => {
  let ingest: string;
  let relay: string;

  it('is off by default, so nothing changes on nodes after the update', async () => {
    ingest = await pair({ name: 'ingest-fw', roles: ['source'] });
    const plan = await buildPlan(t.ctx, await nodeRow(ingest));
    expect(plan.firewall).toEqual({ enabled: false, takeOver: false, tcp: [], udp: [] });
  });

  it('lets in the ports of the node\'s roles once it is switched on', async () => {
    expect((await patch(ingest, { firewall: { enabled: true } })).statusCode).toBe(200);
    expect((await buildPlan(t.ctx, await nodeRow(ingest))).firewall).toEqual({ enabled: true, takeOver: false, tcp: ['8200', '8201'], udp: [] });

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
    expect((await buildPlan(t.ctx, await nodeRow(ingest))).firewall).toEqual({ enabled: true, takeOver: true, tcp: ['8200', '8201', '9000-9010'], udp: ['5353'] });
  });

  it('refuses invalid extra ports', async () => {
    expect((await patch(ingest, { firewall: { extraPorts: [{ port: 9010, to: 9000 }] } })).statusCode).toBe(400);
    expect((await patch(ingest, { firewall: { extraPorts: [{ port: 70000 }] } })).statusCode).toBe(400);
  });

  it('sends nothing to let in once it is switched off again', async () => {
    await patch(ingest, { firewall: { enabled: false } });
    expect((await buildPlan(t.ctx, await nodeRow(ingest))).firewall).toEqual({ enabled: false, takeOver: false, tcp: [], udp: [] });
  });
});
