import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mayPlace, scopeOf, serves } from '../src/services/nodes/dedication.js';
import { relaysByStation } from '../src/services/nodes/plan.js';
import { forgetRelays } from '../src/services/nodes/routing.js';
import { login, setup } from './helpers.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';

describe('shared or dedicated nodes (1.1.1)', () => {
  const relay = (config = {}, tenantId: string | null = null) => ({ id: 'n1', tenantId, roles: ['relay'], config });
  const a1 = { id: S1, tenantId: A };
  const b2 = { id: S2, tenantId: B };

  it('shares relay and ingest nodes of the platform by default', () => {
    expect(scopeOf(relay())).toEqual({ kind: 'shared' });
    expect(serves(relay(), a1) && serves(relay(), b2)).toBe(true);
    expect(scopeOf({ ...relay(), roles: ['source'] })).toEqual({ kind: 'shared' });
  });

  it('dedicates a customer node to its customer, also when set to shared', () => {
    expect(scopeOf(relay({}, A))).toEqual({ kind: 'customer', tenantId: A });
    expect(serves(relay({ dedication: 'shared' }, A), b2)).toBe(false);
    expect(serves(relay({ dedication: 'station', dedicatedStationId: S1 }, A), a1)).toBe(true);
  });

  it('dedicates a platform node to one customer or one station', () => {
    expect(serves(relay({ dedication: 'customer', dedicatedTenantId: A }), a1)).toBe(true);
    expect(serves(relay({ dedication: 'customer', dedicatedTenantId: A }), b2)).toBe(false);
    expect(serves(relay({ dedication: 'station', dedicatedStationId: S2 }), a1)).toBe(false);
    expect(serves(relay({ dedication: 'customer' }), a1)).toBe(false);
  });

  it('dedicates a station node of the platform to the stations on it, of one customer', () => {
    const node = { id: 'sn', tenantId: null, roles: ['station'], config: {} };
    expect(scopeOf(node)).toEqual({ kind: 'placed' });
    expect(serves(node, { ...a1, nodeId: 'sn' })).toBe(true);
    expect(serves(node, { ...b2, nodeId: null })).toBe(false);
    expect(mayPlace(node, b2, [{ ...a1, nodeId: 'sn' }])).toBe(false);
    expect(mayPlace(node, { id: 'x', tenantId: A }, [{ ...a1, nodeId: 'sn' }])).toBe(true);
    expect(mayPlace({ ...node, config: { dedication: 'shared' } }, b2, [{ ...a1, nodeId: 'sn' }])).toBe(true);
  });
});

describe('dedicated nodes in routing (1.1.1)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let admin: { cookie: string };
  const tenants: { id: string; owner: { cookie: string }; station: string }[] = [];
  let relayId: string;

  async function customer(slug: string) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: admin,
      payload: {
        name: slug,
        slug,
        plan: 'distribution',
        limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 1, maxNodes: 1 },
        owner: { email: `owner@${slug}.nl`, name: 'Owner', password: 'owner-password' },
      },
    });
    const owner = await login(t.app, `owner@${slug}.nl`, 'owner-password');
    const st = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId: res.json().id, name: slug, slug: `${slug}-fm` } });
    tenants.push({ id: res.json().id, owner, station: st.json().id });
  }
  const patch = (config: Record<string, unknown>) => t.app.inject({ method: 'PATCH', url: `/api/nodes/${relayId}`, headers: admin, payload: { config } });

  beforeAll(async () => {
    t = await setup();
    admin = await login(t.app, 'admin@example.com', 'admin-password');
    await customer('harder');
    await customer('schermer');
    const res = await t.app.inject({ method: 'POST', url: '/api/nodes', headers: admin, payload: { name: 'relay-studio', roles: ['relay'] } });
    relayId = res.json().node.id;
    await t.app.inject({ method: 'POST', url: '/api/nodes/pair', payload: { code: res.json().pairing.code, hostname: 'node-test' } });
  });
  afterAll(() => t.close());

  it('shows a new relay as shared and lets it carry every station', async () => {
    const node = (await t.app.inject({ method: 'GET', url: `/api/nodes/${relayId}`, headers: admin })).json();
    expect(node.scope).toEqual({ kind: 'shared', tenantId: null, stationId: null });
    forgetRelays();
    const map = await relaysByStation(t.ctx);
    expect(map.get(tenants[0]!.station)?.map((n) => n.id)).toEqual([relayId]);
    expect(map.get(tenants[1]!.station)?.map((n) => n.id)).toEqual([relayId]);
  });

  it('needs the customer or station a node is dedicated to', async () => {
    expect((await patch({ dedication: 'customer' })).statusCode).toBe(400);
    expect((await patch({ dedication: 'station', dedicatedStationId: '00000000-0000-4000-8000-000000000999' })).statusCode).toBe(400);
  });

  it('refuses to dedicate a node that another customer still routes to', async () => {
    const [harder, schermer] = tenants as [(typeof tenants)[0], (typeof tenants)[0]];
    const r = await t.app.inject({ method: 'PUT', url: `/api/stations/${harder.station}/routing`, headers: admin, payload: { ingest: 'local', relays: [relayId] } });
    expect(r.statusCode).toBe(200);
    const res = await patch({ dedication: 'customer', dedicatedTenantId: schermer.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('harder');
    await t.app.inject({ method: 'PUT', url: `/api/stations/${harder.station}/routing`, headers: admin, payload: { ingest: 'local', relays: 'auto' } });
  });

  it('only carries and offers the stations of the customer it is dedicated to', async () => {
    const [harder, schermer] = tenants as [(typeof tenants)[0], (typeof tenants)[0]];
    const res = await patch({ dedication: 'customer', dedicatedTenantId: schermer.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toEqual({ kind: 'customer', tenantId: schermer.id, stationId: null });
    forgetRelays();
    const map = await relaysByStation(t.ctx);
    expect(map.get(harder.station)).toBeUndefined();
    expect(map.get(schermer.station)?.map((n) => n.id)).toEqual([relayId]);
    // Routing of the other customer neither offers nor accepts it.
    const view = (await t.app.inject({ method: 'GET', url: `/api/stations/${harder.station}/routing`, headers: admin })).json();
    expect(JSON.stringify(view)).not.toContain(relayId);
    const r = await t.app.inject({ method: 'PUT', url: `/api/stations/${harder.station}/routing`, headers: admin, payload: { ingest: 'local', relays: [relayId] } });
    expect(r.statusCode).toBe(403);
    // The node cannot be told to carry the other customer's station either.
    expect((await patch({ relayStations: [harder.station] })).statusCode).toBe(400);
    // The other customer's topology does not show it.
    const topo = (await t.app.inject({ method: 'GET', url: '/api/nodes/topology', headers: harder.owner })).json();
    expect(topo.nodes.some((n: { id: string }) => n.id === relayId)).toBe(false);
  });

  it('becomes shared again', async () => {
    expect((await patch({ dedication: 'shared' })).json().scope.kind).toBe('shared');
    forgetRelays();
    expect((await relaysByStation(t.ctx)).get(tenants[0]!.station)?.map((n) => n.id)).toEqual([relayId]);
  });
});
