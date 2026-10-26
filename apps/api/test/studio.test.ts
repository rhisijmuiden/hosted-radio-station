import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateSource } from '../src/services/streaming/sources.js';
import { clearStudioReleaseCache, compareVersions, studioReleases } from '../src/services/studio.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let owner: { cookie: string };
let dj: { cookie: string };
let stationId: string;
let mountId: string;
let djAccountId: string;
let otherAccountId: string;

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const tenant = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: { name: 'Studio FM', slug: 'studio', plan: 'station', owner: { email: 'owner@studio.fm', name: 'Owner', password: 'owner-password' } },
  });
  owner = await login(t.app, 'owner@studio.fm', 'owner-password');
  const m = await t.app.inject({
    method: 'POST',
    url: `/api/tenants/${tenant.json().id}/members`,
    headers: owner,
    payload: { email: 'dj@studio.fm', name: 'DJ Studio', password: 'dj-password-1', role: 'dj' },
  });
  dj = await login(t.app, 'dj@studio.fm', 'dj-password-1');
  const station = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId: tenant.json().id, name: 'Studio FM', slug: 'studio-fm' } });
  stationId = station.json().id;
  mountId = station.json().mounts[0].id;
  const a = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/accounts`, headers: owner, payload: { username: 'djstudio', userId: m.json().user.id } });
  djAccountId = a.json().id;
  const b = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/accounts`, headers: owner, payload: { username: 'someone', password: 'someone-password' } });
  otherAccountId = b.json().id;
});
afterAll(() => t.close());

describe('linking a studio PC', () => {
  let code: string;
  let deviceSecret: string;

  it('starts a link request without signing in', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/studio/link', payload: { deviceName: 'STUDIO-1', clientVersion: '0.9.0' } });
    expect(res.statusCode).toBe(201);
    ({ code, deviceSecret } = res.json());
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(res.json().verifyUrl).toContain(`/link?code=${code}`);
    const poll = await t.app.inject({ method: 'POST', url: '/api/studio/link/poll', payload: { deviceSecret } });
    expect(poll.json()).toEqual({ state: 'pending' });
  });

  it('shows the request to a signed-in user, also without the dash', async () => {
    expect((await t.app.inject({ url: `/api/studio/link/${code}` })).statusCode).toBe(401);
    const res = await t.app.inject({ url: `/api/studio/link/${code.replace('-', '').toLowerCase()}`, headers: dj });
    expect(res.json()).toMatchObject({ deviceName: 'STUDIO-1', clientVersion: '0.9.0', state: 'pending' });
  });

  it('hands out the key once after approval', async () => {
    const ok = await t.app.inject({ method: 'POST', url: `/api/studio/link/${code}/approve`, headers: dj });
    expect(ok.json().state).toBe('approved');
    expect((await t.app.inject({ method: 'POST', url: `/api/studio/link/${code}/approve`, headers: dj })).statusCode).toBe(409);
    const poll = await t.app.inject({ method: 'POST', url: '/api/studio/link/poll', payload: { deviceSecret } });
    expect(poll.json()).toMatchObject({ state: 'approved', user: { email: 'dj@studio.fm' } });
    const key = poll.json().apiKey as string;
    expect(key).toMatch(/^hrs_/);
    expect((await t.app.inject({ method: 'POST', url: '/api/studio/link/poll', payload: { deviceSecret } })).statusCode).toBe(404);
    const me = await t.app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${key}` } });
    expect(me.json().user.email).toBe('dj@studio.fm');
    // The key cannot approve other PCs.
    const second = (await t.app.inject({ method: 'POST', url: '/api/studio/link', payload: { deviceName: 'STUDIO-2' } })).json();
    expect((await t.app.inject({ method: 'POST', url: `/api/studio/link/${second.code}/approve`, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(403);
    await t.app.inject({ method: 'POST', url: `/api/studio/link/${second.code}/deny`, headers: dj });
    expect((await t.app.inject({ method: 'POST', url: '/api/studio/link/poll', payload: { deviceSecret: second.deviceSecret } })).json().state).toBe('denied');

    await t.app.inject({ method: 'POST', url: '/api/studio/hello', headers: { authorization: `Bearer ${key}` }, payload: { clientVersion: '0.9.1' } });
    const devices = await t.app.inject({ url: '/api/studio/devices', headers: dj });
    expect(devices.json()).toHaveLength(1);
    expect(devices.json()[0]).toMatchObject({ deviceName: 'STUDIO-1', clientVersion: '0.9.1' });
    expect((await t.app.inject({ url: '/api/studio/devices', headers: owner })).json()).toHaveLength(0);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/studio/devices/${devices.json()[0].id}`, headers: dj })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
  });
});

describe('live broadcasts from the studio client', () => {
  it('gives DJs an encoder password for their own account only', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/studio/live-token`, headers: dj, payload: { accountId: djAccountId } });
    expect(res.statusCode).toBe(404);
    const own = await t.app.inject({ method: 'POST', url: `/api/studio/stations/${stationId}/live-token`, headers: dj, payload: { accountId: djAccountId } });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ username: 'djstudio' });
    expect(own.json().password).toMatch(/^hrsl_/);
    const other = await t.app.inject({ method: 'POST', url: `/api/studio/stations/${stationId}/live-token`, headers: dj, payload: { accountId: otherAccountId } });
    expect(other.statusCode).toBe(403);
    const manager = await t.app.inject({ method: 'POST', url: `/api/studio/stations/${stationId}/live-token`, headers: owner, payload: { accountId: otherAccountId } });
    expect(manager.statusCode).toBe(200);

    const token = own.json().password as string;
    expect((await authenticateSource(t.ctx, stationId, mountId, 'djstudio', token))?.id).toBe(djAccountId);
    // Shoutcast style "user:password" works too, but not for another account.
    expect((await authenticateSource(t.ctx, stationId, mountId, null, `djstudio:${token}`))?.id).toBe(djAccountId);
    expect(await authenticateSource(t.ctx, stationId, mountId, 'someone', token)).toBeNull();
    expect(await authenticateSource(t.ctx, stationId, mountId, 'djstudio', `${token}x`)).toBeNull();
    expect((await authenticateSource(t.ctx, stationId, mountId, 'someone', 'someone-password'))?.id).toBe(otherAccountId);
  });

  it('refuses accounts that may not broadcast and expired passwords', async () => {
    const own = (await t.app.inject({ method: 'POST', url: `/api/studio/stations/${stationId}/live-token`, headers: dj, payload: { accountId: djAccountId } })).json();
    await t.db.update((await import('../src/db/index.js')).schema.studioLiveTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await authenticateSource(t.ctx, stationId, mountId, 'djstudio', own.password)).toBeNull();
    await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}/accounts/${otherAccountId}`, headers: owner, payload: { canBroadcast: false } });
    const res = await t.app.inject({ method: 'POST', url: `/api/studio/stations/${stationId}/live-token`, headers: owner, payload: { accountId: otherAccountId } });
    expect(res.statusCode).toBe(400);
  });
});

describe('studio client releases', () => {
  it('orders versions with test builds', () => {
    expect(compareVersions('0.9.1', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0-test.4', '0.9.0')).toBeLessThan(0);
    expect(compareVersions('0.9.0-test.12', '0.9.0-test.4')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0-test.1', '0.9.9')).toBeGreaterThan(0);
  });

  it('picks the newest release per channel with its checksum', async () => {
    clearStudioReleaseCache();
    const asset = (v: string) => ({ name: `RHIS Studio_${v}_x64-setup.exe`, browser_download_url: `https://dl/${v}.exe`, size: 1234 });
    const sums = (v: string) => ({ name: 'SHA256SUMS.txt', browser_download_url: `https://dl/${v}.sums`, size: 80 });
    const releases = [
      { tag_name: 'studio-v0.9.0', prerelease: false, draft: false, published_at: '2026-10-26T10:00:00Z', body: 'First', html_url: 'https://gh/r1', assets: [asset('0.9.0'), sums('0.9.0')] },
      { tag_name: 'studio-v0.9.1-test.7', prerelease: true, draft: false, published_at: '2026-10-26T11:00:00Z', body: '', html_url: 'https://gh/r2', assets: [asset('0.9.1-test.7')] },
      { tag_name: 'studio-v0.9.1-test.12', prerelease: true, draft: false, published_at: '2026-10-26T12:00:00Z', body: '', html_url: 'https://gh/r3', assets: [asset('0.9.1-test.12')] },
      { tag_name: 'studio-v1.0.0', prerelease: false, draft: true, published_at: null, body: '', html_url: 'https://gh/r4', assets: [] },
      { tag_name: 'v7', prerelease: false, draft: false, published_at: null, body: '', html_url: 'https://gh/r5', assets: [] },
    ];
    const fake = (async (url: string) => {
      if (url.includes('api.github.com')) return new Response(JSON.stringify(releases));
      if (url === 'https://dl/0.9.0.sums') return new Response(`ABCDEF0123  RHIS Studio_0.9.0_x64-setup.exe\n`);
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const out = await studioReleases(t.ctx, fake);
    expect(out.production).toMatchObject({ version: '0.9.0', installerUrl: 'https://dl/0.9.0.exe', sha256: 'abcdef0123', notes: 'First' });
    expect(out.test).toMatchObject({ version: '0.9.1-test.12', sha256: null });
    expect(out.error).toBeNull();
    clearStudioReleaseCache();
  });
});
