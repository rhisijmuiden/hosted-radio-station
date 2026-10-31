import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let owner: { cookie: string };
let tenantId: string;
let stationId: string;

const limits = { maxStations: 3, maxRadioStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 100, maxNodes: 1 };
const setLimits = (extra: Record<string, unknown>) => t.app.inject({ method: 'PATCH', url: `/api/tenants/${tenantId}`, headers: admin, payload: { limits: { ...limits, ...extra } } });

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: { name: 'Uptempo', slug: 'uptempo', limits, owner: { email: 'owner@uptempo.fm', name: 'Owner', password: 'owner-password' } },
  });
  tenantId = res.json().id;
  owner = await login(t.app, 'owner@uptempo.fm', 'owner-password');
  const st = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Uptempo FM', slug: 'uptempo-fm', maxListeners: 10 } });
  expect(st.statusCode).toBe(201);
  stationId = st.json().id;
});

afterAll(async () => {
  await t.close();
});

describe('customer permissions (customer navigation step 4)', () => {
  it('stores the permissions and keeps them when a client leaves them out', async () => {
    const set = await setLimits({ mayRoute: false, mayCreateStations: false, maySwitchEdition: false, nodeRoles: ['station', 'relay'] });
    expect(set.statusCode).toBe(200);
    expect(set.json().limits).toMatchObject({ mayRoute: false, mayCreateStations: false, maySwitchEdition: false, nodeRoles: ['station', 'relay'] });
    const older = await setLimits({});
    expect(older.json().limits).toMatchObject({ mayRoute: false, mayCreateStations: false, maySwitchEdition: false, nodeRoles: ['station', 'relay'] });
  });

  it('stops the customer, never the administrator', async () => {
    const create = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Second', slug: 'second', maxListeners: 10 } });
    expect(create.statusCode).toBe(403);
    expect(create.json().error.message).toMatch(/create stations/);
    expect((await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId, name: 'Second', slug: 'second', maxListeners: 10 } })).statusCode).toBe(201);

    const upgrade = await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}`, headers: owner, payload: { edition: 'station' } });
    expect(upgrade.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/upgrade`, headers: owner, payload: {} })).statusCode).toBe(403);

    const view = (await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: owner })).json();
    expect(view.canEdit).toBe(false);
    const put = await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/routing`, headers: owner, payload: view.routing });
    expect(put.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'PUT', url: `/api/stations/${stationId}/placement`, headers: owner, payload: { nodeId: null } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: admin })).json().canEdit).toBe(true);
  });

  it('allows it again when switched back on', async () => {
    await setLimits({ mayRoute: true, mayCreateStations: true, maySwitchEdition: true });
    expect((await t.app.inject({ method: 'GET', url: `/api/stations/${stationId}/routing`, headers: owner })).json().canEdit).toBe(true);
    expect((await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Third', slug: 'third', maxListeners: 10 } })).statusCode).toBe(201);
  });
});
