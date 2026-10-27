import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetting, putSetting } from '../src/services/settings.js';
import { parseStats } from '../src/services/streaming/icecast.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let owner: { cookie: string };
let dj: { cookie: string };
let tenantId: string;
let stationId: string;
let djUserId: string;

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
      limits: { maxStations: 2, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 1 },
      owner: { email: 'owner@harder.fm', name: 'Owner', password: 'owner-password' },
    },
  });
  tenantId = res.json().id;
  owner = await login(t.app, 'owner@harder.fm', 'owner-password');
  const m = await t.app.inject({
    method: 'POST',
    url: `/api/tenants/${tenantId}/members`,
    headers: owner,
    payload: { email: 'dj@harder.fm', name: 'DJ Hard', password: 'dj-password-1', role: 'dj' },
  });
  djUserId = m.json().user.id;
  dj = await login(t.app, 'dj@harder.fm', 'dj-password-1');
});
afterAll(() => t.close());

describe('stations', () => {
  it('creates a station with a /live mount and local listening', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/stations',
      headers: owner,
      payload: { tenantId, name: 'Harder FM', slug: 'harder-fm', maxListeners: 60, bitrateKbps: 320 },
    });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    stationId = s.id;
    expect(s).toMatchObject({ slug: 'harder-fm', edition: 'distribution', maxListeners: 60, role: 'owner' });
    // The bitrate is capped at the customer's limit.
    expect(s.mounts).toEqual([expect.objectContaining({ path: '/live', kind: 'source', bitrateKbps: 192, isDefault: true })]);
    expect(s.outputs).toEqual([expect.objectContaining({ type: 'local', enabled: true })]);
    expect(s.connection.mounts[0]).toMatchObject({ encoderMount: '/harder-fm/live', listenUrl: 'http://localhost:8000/listen/harder-fm/live' });

    const xml = await readFile(join(t.ctx.config.DATA_DIR, 'stations', stationId, 'icecast.xml'), 'utf8');
    expect(xml).toContain('<mount-name>/live</mount-name>');
    expect(xml).toContain('<bind-address>127.0.0.1</bind-address>');
    const state = JSON.parse(await readFile(join(t.ctx.config.DATA_DIR, 'run', 'streams-state.json'), 'utf8'));
    expect(state.listen).toEqual([{ slug: 'harder-fm', port: expect.any(Number), mounts: ['/live'] }]);
  });

  it('shares the listener limit over the stations of a customer', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Two', slug: 'two', maxListeners: 50 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/at most 40/);
    const ok = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Two', slug: 'two' } });
    expect(ok.json().maxListeners).toBe(40);
    const third = await t.app.inject({ method: 'POST', url: '/api/stations', headers: owner, payload: { tenantId, name: 'Three', slug: 'three' } });
    expect(third.json().error.message).toMatch(/2 station/);
    await t.app.inject({ method: 'DELETE', url: `/api/stations/${ok.json().id}`, headers: owner });
  });

  it('keeps the Radio station edition for customers with that plan', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}`, headers: owner, payload: { edition: 'station' } });
    expect(res.statusCode).toBe(400);
  });

  it('lets DJs see stations but not change them', async () => {
    expect((await t.app.inject({ url: '/api/stations', headers: dj })).json()).toHaveLength(1);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}`, headers: dj, payload: { name: 'X' } })).statusCode).toBe(403);
  });

  it('turns on a legacy Shoutcast port pair', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}`, headers: owner, payload: { legacy: { enabled: true } } });
    expect(res.json().legacyPort).toBe(8100);
    expect(res.json().connection.legacy).toMatchObject({ port: 8100, sourcePort: 8101, mount: '/live' });
  });
});

describe('mounts', () => {
  let liveId: string;
  it('adds a converted mount and refuses bad ones', async () => {
    const detail = (await t.app.inject({ url: `/api/stations/${stationId}`, headers: owner })).json();
    liveId = detail.mounts[0].id;
    const bad = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/mounts`, headers: owner, payload: { path: '/low', kind: 'transcode', format: 'aac', bitrateKbps: 64 } });
    expect(bad.statusCode).toBe(400);
    const tooHigh = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/mounts`, headers: owner, payload: { path: '/hq', bitrateKbps: 320 } });
    expect(tooHigh.json().error.message).toMatch(/192/);
    const ok = await t.app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/mounts`,
      headers: owner,
      payload: { path: '/low.aac', name: 'Mobile', kind: 'transcode', sourceMountId: liveId, format: 'aac', bitrateKbps: 64 },
    });
    expect(ok.statusCode).toBe(201);
    const dup = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/mounts`, headers: owner, payload: { path: '/low.aac' } });
    expect(dup.statusCode).toBe(409);
    const busy = await t.app.inject({ method: 'DELETE', url: `/api/stations/${stationId}/mounts/${liveId}`, headers: owner });
    expect(busy.statusCode).toBe(409);
  });

  it('refuses fallback loops', async () => {
    const backup = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/mounts`, headers: owner, payload: { path: '/backup', fallbackMountId: liveId } });
    expect(backup.statusCode).toBe(201);
    const loop = await t.app.inject({
      method: 'PUT',
      url: `/api/stations/${stationId}/mounts/${liveId}`,
      headers: owner,
      payload: { path: '/live', bitrateKbps: 192, isDefault: true, fallbackMountId: backup.json().id },
    });
    expect(loop.json().error.message).toMatch(/loop/);
  });
});

describe('outputs', () => {
  it('stores external servers with masked passwords', async () => {
    const detail = (await t.app.inject({ url: `/api/stations/${stationId}`, headers: owner })).json();
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/outputs`,
      headers: owner,
      payload: { type: 'shoutcast2', name: 'Old server', mountId: detail.mounts[0].id, config: { host: 'radio.example.net', port: 8000, password: 'secret', streamId: 2 } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().config).toMatchObject({ host: 'radio.example.net', password: '••••••••', streamId: 2, push: true });
    const put = await t.app.inject({
      method: 'PUT',
      url: `/api/stations/${stationId}/outputs/${res.json().id}`,
      headers: owner,
      payload: { type: 'shoutcast2', name: 'Old server', mountId: detail.mounts[0].id, config: { host: 'radio.example.net', port: 8000, password: '••••••••', streamId: 2 } },
    });
    expect(put.statusCode).toBe(200);
    const [row] = await t.db.query.stationOutputs.findMany({ where: (o, { eq }) => eq(o.id, res.json().id) });
    expect(t.ctx.box.decrypt(row!.config.password!)).toBe('secret');
  });

  it('only allows one local output', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/outputs`, headers: owner, payload: { type: 'local', name: 'Again' } });
    expect(res.statusCode).toBe(409);
  });
});

describe('DJ and upload accounts', () => {
  let accountId: string;
  let generated: string;
  it('generates a password once', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/accounts`,
      headers: owner,
      payload: { username: 'hardstyle', displayName: 'DJ Hard', userId: djUserId, canUpload: true },
    });
    expect(res.statusCode).toBe(201);
    accountId = res.json().id;
    generated = res.json().password;
    expect(generated).toHaveLength(16);
    expect(res.json().uploadLogin).toBe('harder-fm.hardstyle');
    const list = await t.app.inject({ url: `/api/stations/${stationId}/accounts`, headers: owner });
    expect(list.json()[0].password).toBeUndefined();
  });

  it('lets a DJ see and reset only their own account', async () => {
    await t.app.inject({ method: 'POST', url: `/api/stations/${stationId}/accounts`, headers: owner, payload: { username: 'other', password: 'other-password' } });
    expect((await t.app.inject({ url: `/api/stations/${stationId}/accounts`, headers: dj })).json()).toHaveLength(1);
    const own = await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}/accounts/${accountId}`, headers: dj, payload: { password: 'my-own-password' } });
    expect(own.statusCode).toBe(200);
    const more = await t.app.inject({ method: 'PATCH', url: `/api/stations/${stationId}/accounts/${accountId}`, headers: dj, payload: { canUpload: false } });
    expect(more.statusCode).toBe(403);
  });

  it('checks upload log-ins for SFTPGo', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/internal/sftpgo/auth', payload: { username: 'harder-fm.hardstyle', password: 'wrong' } });
    expect(bad.json()).toEqual({ username: '' });
    const res = await t.app.inject({ method: 'POST', url: '/api/internal/sftpgo/auth', payload: { username: 'harder-fm.hardstyle', password: 'my-own-password', protocol: 'SSH' } });
    expect(res.json()).toMatchObject({ username: 'harder-fm.hardstyle', status: 1, permissions: { '/': ['*'] }, quota_size: 1024 * 1024 });
    expect(res.json().home_dir).toBe(join(t.ctx.config.DATA_DIR, 'stations', stationId, 'media'));
    const noUpload = await t.app.inject({ method: 'POST', url: '/api/internal/sftpgo/auth', payload: { username: 'harder-fm.other', password: 'other-password' } });
    expect(noUpload.json()).toEqual({ username: '' });
  });

  it('refuses internal hooks through the web server', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/internal/sftpgo/auth', headers: { 'x-forwarded-for': '1.2.3.4' }, payload: { username: 'x', password: 'y' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('domains', () => {
  let domainId: string;
  it('sends encoders to the encoder address when the domain runs behind a proxy such as Cloudflare', async () => {
    const streaming = await getSetting(t.ctx, 'streaming');
    await putSetting(t.ctx, 'streaming', { ...streaming, encoderHost: 'src.radio.invalid' });
    try {
      const s = (await t.app.inject({ url: `/api/stations/${stationId}`, headers: owner })).json();
      expect(s.connection.ingestHost).toBe('src.radio.invalid');
      expect(s.connection.tls.available).toBe(false);
    } finally {
      await putSetting(t.ctx, 'streaming', streaming);
    }
  });

  it('adds a domain and only issues certificates once it is verified', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/domains`, headers: owner, payload: { domain: 'harder.invalid' } });
    expect(res.statusCode).toBe(201);
    domainId = res.json().id;
    expect(res.json()).toMatchObject({ panelHost: 'stream.harder.invalid', ingestHost: 'src.harder.invalid' });
    expect(res.json().status).not.toBe('verified');
    expect((await t.app.inject({ url: '/api/internal/tls-ask?domain=src.harder.invalid' })).statusCode).toBe(404);

    expect((await t.app.inject({ method: 'PATCH', url: `/api/tenants/${tenantId}/domains/${domainId}`, headers: owner, payload: { verifiedManually: true } })).statusCode).toBe(403);
    const manual = await t.app.inject({ method: 'PATCH', url: `/api/tenants/${tenantId}/domains/${domainId}`, headers: admin, payload: { verifiedManually: true } });
    expect(manual.json().status).toBe('verified');
    expect((await t.app.inject({ url: '/api/internal/tls-ask?domain=src.harder.invalid' })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/internal/tls-ask?domain=evil.example.com' })).statusCode).toBe(404);
  });

  it('uses the customer domain for encoders and listen URLs', async () => {
    const s = (await t.app.inject({ url: `/api/stations/${stationId}`, headers: owner })).json();
    expect(s.connection.ingestHost).toBe('src.harder.invalid');
    expect(s.connection.mounts[0].listenUrl).toBe('https://stream.harder.invalid/listen/harder-fm/live');
  });

  it('refuses names outside the domain', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/domains`, headers: owner, payload: { domain: 'a.invalid', panelHost: 'stream.b.invalid' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('limits and public status', () => {
  it('reports usage', async () => {
    const res = await t.app.inject({ url: `/api/tenants/${tenantId}/usage`, headers: owner });
    expect(res.json()).toMatchObject({ stations: { used: 1, limit: 2 }, listeners: { allocated: 60, limit: 100 }, storage: { limitBytes: 1024 * 1024 } });
  });

  it('serves the public status without signing in', async () => {
    const res = await t.app.inject({ url: '/api/public/stations/harder-fm' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Harder FM', live: false, mounts: expect.arrayContaining([expect.objectContaining({ path: '/live', isDefault: true })]) });
    expect((await t.app.inject({ url: '/api/public/stations/nope' })).statusCode).toBe(404);
  });

  it('validates streaming ports', async () => {
    const current = (await t.app.inject({ url: '/api/settings/streaming', headers: admin })).json();
    const clash = await t.app.inject({ method: 'PUT', url: '/api/settings/streaming', headers: admin, payload: { ...current, ingestPlainPort: 8443 } });
    expect(clash.json().error.message).toMatch(/share port 8443/);
    const inRange = await t.app.inject({ method: 'PUT', url: '/api/settings/streaming', headers: admin, payload: { ...current, ingestTlsPort: 8150 } });
    expect(inRange.json().error.message).toMatch(/inside the Legacy/);
    const ok = await t.app.inject({ method: 'PUT', url: '/api/settings/streaming', headers: admin, payload: { ...current, cnameTarget: 'radio.example.com' } });
    expect(ok.statusCode).toBe(200);
    const env = await readFile(join(t.ctx.config.DATA_DIR, 'sftpgo', 'sftpgo.env'), 'utf8');
    expect(env).toContain('SFTPGO_SFTPD__BINDINGS__0__PORT=2022');
  });
});

describe('icecast stats parsing', () => {
  it('reads mounts, titles and bitrates', () => {
    const stats = parseStats(
      '<icestats><source mount="/live"><audio_info>bitrate=128</audio_info><listeners>3</listeners><title>Artist - T&#xC3;&#xAD;tle</title><server_type>audio/mpeg</server_type></source><source mount="/low"><listeners>1</listeners></source></icestats>',
    );
    expect(stats[0]).toMatchObject({ mount: '/live', listeners: 3, title: 'Artist - Títle', bitrateKbps: 128 });
    expect(stats[1]).toMatchObject({ mount: '/low', listeners: 1, title: null, bitrateKbps: null });
  });
});
