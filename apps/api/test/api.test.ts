import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let adminHeaders: { cookie: string };

beforeAll(async () => {
  t = await setup();
  adminHeaders = await login(t.app, 'admin@example.com', 'admin-password');
});
afterAll(() => t.close());

describe('auth', () => {
  it('rejects a wrong password', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: 'nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
  });

  it('returns the signed-in user', async () => {
    const res = await t.app.inject({ url: '/api/auth/me', headers: adminHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: 'admin@example.com', isSuperadmin: true });
    expect(res.json().user.passwordHash).toBeUndefined();
  });

  it('requires authentication', async () => {
    expect((await t.app.inject({ url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/tenants' })).statusCode).toBe(401);
  });

  it('updates language preference', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: '/api/auth/me', headers: adminHeaders, payload: { locale: 'nl' } });
    expect(res.json().locale).toBe('nl');
  });
});

describe('customers, members and roles', () => {
  let tenantId: string;
  let ownerHeaders: { cookie: string };
  let djHeaders: { cookie: string };

  it('creates a customer with an owner', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: adminHeaders,
      payload: { name: 'Harder.fm', slug: 'harder-fm', plan: 'station', owner: { email: 'owner@harder.fm', name: 'Owner', password: 'owner-password' } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: 'harder-fm', plan: 'station', memberCount: 1 });
    tenantId = res.json().id;
    ownerHeaders = await login(t.app, 'owner@harder.fm', 'owner-password');
  });

  it('rejects a duplicate short name', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/tenants', headers: adminHeaders, payload: { name: 'X', slug: 'harder-fm' } });
    expect(res.statusCode).toBe(409);
  });

  it('validates input', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/tenants', headers: adminHeaders, payload: { name: 'X', slug: 'Not Valid!' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('lets the owner add a DJ but not change the plan', async () => {
    const add = await t.app.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/members`,
      headers: ownerHeaders,
      payload: { email: 'dj@harder.fm', name: 'DJ', password: 'dj-password-1', role: 'dj' },
    });
    expect(add.statusCode).toBe(201);
    djHeaders = await login(t.app, 'dj@harder.fm', 'dj-password-1');

    const plan = await t.app.inject({ method: 'PATCH', url: `/api/tenants/${tenantId}`, headers: ownerHeaders, payload: { plan: 'distribution' } });
    expect(plan.statusCode).toBe(403);
    const rename = await t.app.inject({ method: 'PATCH', url: `/api/tenants/${tenantId}`, headers: ownerHeaders, payload: { name: 'Harder FM' } });
    expect(rename.json().name).toBe('Harder FM');
  });

  it('keeps DJs out of member management and other customers', async () => {
    expect((await t.app.inject({ url: `/api/tenants/${tenantId}/members`, headers: djHeaders })).statusCode).toBe(403);
    const other = await t.app.inject({ method: 'POST', url: '/api/tenants', headers: adminHeaders, payload: { name: 'Radio Schermer', slug: 'radio-schermer' } });
    expect((await t.app.inject({ url: `/api/tenants/${other.json().id}`, headers: djHeaders })).statusCode).toBe(403);
    const list = await t.app.inject({ url: '/api/tenants', headers: djHeaders });
    expect(list.json().map((x: { slug: string }) => x.slug)).toEqual(['harder-fm']);
    expect((await t.app.inject({ url: '/api/users', headers: djHeaders })).statusCode).toBe(403);
  });

  it('does not let a manager create an owner', async () => {
    await t.app.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/members`,
      headers: ownerHeaders,
      payload: { email: 'mgr@harder.fm', name: 'Manager', password: 'mgr-password-1', role: 'manager' },
    });
    const mgr = await login(t.app, 'mgr@harder.fm', 'mgr-password-1');
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/members`,
      headers: mgr,
      payload: { email: 'x@harder.fm', name: 'X', role: 'owner' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('users', () => {
  it('protects the last administrator', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: `/api/users/${t.admin.id}`, headers: adminHeaders, payload: { isSuperadmin: false } });
    expect(res.statusCode).toBe(400);
  });

  it('signs a user out when an administrator resets the password', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: adminHeaders,
      payload: { email: 'temp@example.com', name: 'Temp', password: 'temp-password-1' },
    });
    expect(created.statusCode).toBe(201);
    const temp = await login(t.app, 'temp@example.com', 'temp-password-1');
    await t.app.inject({ method: 'PATCH', url: `/api/users/${created.json().id}`, headers: adminHeaders, payload: { password: 'temp-password-2' } });
    expect((await t.app.inject({ url: '/api/auth/me', headers: temp })).statusCode).toBe(401);
  });
});

describe('api keys', () => {
  it('authenticates with a bearer key and enforces read-only', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/api-keys', headers: adminHeaders, payload: { name: 'RHIS website', readOnly: true } });
    expect(created.statusCode).toBe(201);
    const { secret } = created.json();
    expect(secret).toMatch(/^hrs_/);
    const auth = { authorization: `Bearer ${secret}` };
    expect((await t.app.inject({ url: '/api/tenants', headers: auth })).statusCode).toBe(200);
    const write = await t.app.inject({ method: 'POST', url: '/api/tenants', headers: auth, payload: { name: 'Y', slug: 'y' } });
    expect(write.statusCode).toBe(403);
    const list = await t.app.inject({ url: '/api/api-keys', headers: adminHeaders });
    expect(list.json()[0].secret).toBeUndefined();
    await t.app.inject({ method: 'DELETE', url: `/api/api-keys/${created.json().id}`, headers: adminHeaders });
    expect((await t.app.inject({ url: '/api/tenants', headers: auth })).statusCode).toBe(401);
  });
});

describe('settings', () => {
  it('stores SMTP secrets encrypted and masks them', async () => {
    const smtp = { enabled: true, host: 'smtp.example.com', port: 587, security: 'starttls', username: 'u', password: 's3cret', fromAddress: 'radio@example.com' };
    const put = await t.app.inject({ method: 'PUT', url: '/api/settings/smtp', headers: adminHeaders, payload: smtp });
    expect(put.statusCode).toBe(200);
    expect(put.json().password).toBe('••••••••');
    // Saving the mask keeps the stored secret.
    await t.app.inject({ method: 'PUT', url: '/api/settings/smtp', headers: adminHeaders, payload: { ...smtp, password: '••••••••' } });
    const { getSetting } = await import('../src/services/settings.js');
    expect((await getSetting(t.ctx, 'smtp')).password).toBe('s3cret');
    const raw = await t.ctx.db.query.settings.findFirst();
    expect(JSON.stringify(raw)).not.toContain('s3cret');
  });

  it('validates the reverse proxy settings', async () => {
    const bad = await t.app.inject({ method: 'PUT', url: '/api/settings/proxy', headers: adminHeaders, payload: { mode: 'external', trustedProxies: ['not an ip'] } });
    expect(bad.statusCode).toBe(400);
    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/settings/proxy',
      headers: adminHeaders,
      payload: { mode: 'external', trustedProxies: ['10.0.0.0/8'], domain: 'Radio.Example.com' },
    });
    expect(ok.json()).toMatchObject({ mode: 'external', domain: 'radio.example.com' });
  });
});

describe('system', () => {
  it('reports the version', async () => {
    const res = await t.app.inject({ url: '/api/system/info', headers: adminHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Hosted Radio Station', channel: 'main', helpers: false });
    expect(res.json().version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('refuses UI updates without the system helpers', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/system/update', headers: adminHeaders, payload: { channel: 'test' } });
    expect(res.statusCode).toBe(501);
  });

  it('serves the OpenAPI document', async () => {
    const res = await t.app.inject({ url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().paths['/api/tenants/']).toBeDefined();
  });
});
