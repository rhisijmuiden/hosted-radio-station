import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
const inbox: { to: string; raw: string }[] = [];
let smtp: SMTPServer;

beforeAll(async () => {
  t = await setup();
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c: Buffer) => (raw += c.toString()));
      stream.on('end', () => {
        inbox.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  const port = (smtp.server.address() as AddressInfo).port;
  await t.app.inject({
    method: 'PUT',
    url: '/api/settings/smtp',
    headers: admin,
    payload: { enabled: true, host: '127.0.0.1', port, security: 'none', fromAddress: 'radio@example.com' },
  });
});
afterAll(async () => {
  await t.close();
  await new Promise<void>((r) => smtp.close(r));
});

/** Pulls the reset link out of the (quoted-printable) text part. */
const tokenFrom = (raw: string) => {
  const text = raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  return decodeURIComponent(text.match(/reset-password\?token=([A-Za-z0-9_%-]+)/)![1]!);
};

describe('audit log', () => {
  it('records sign-ins, failed sign-ins and changes', async () => {
    await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: 'wrong' } });
    const created = await t.app.inject({ method: 'POST', url: '/api/tenants', headers: admin, payload: { name: 'Harder.fm', slug: 'harder-fm' } });
    const tenantId = created.json().id;
    const res = await t.app.inject({ url: '/api/audit?limit=20', headers: admin });
    expect(res.statusCode).toBe(200);
    const actions = res.json().items.map((i: { action: string; success: boolean }) => `${i.action}:${i.success}`);
    expect(actions).toContain('auth.login:true');
    expect(actions).toContain('auth.login:false');
    const create = res.json().items.find((i: { action: string }) => i.action === 'tenant.create');
    expect(create).toMatchObject({ tenantId, tenantName: 'Harder.fm', actorEmail: 'admin@example.com', via: 'session' });
    expect(JSON.stringify(res.json())).not.toContain('admin-password');
  });

  it('shows owners only their own customer', async () => {
    const harder = (await t.app.inject({ url: '/api/tenants', headers: admin })).json()[0];
    await t.app.inject({
      method: 'POST',
      url: `/api/tenants/${harder.id}/members`,
      headers: admin,
      payload: { email: 'owner@harder.fm', name: 'Owner', password: 'owner-password', role: 'owner' },
    });
    await t.app.inject({ method: 'POST', url: '/api/tenants', headers: admin, payload: { name: 'Other', slug: 'other' } });
    const owner = await login(t.app, 'owner@harder.fm', 'owner-password');
    expect((await t.app.inject({ url: '/api/audit', headers: owner })).statusCode).toBe(403);
    const own = await t.app.inject({ url: `/api/audit?tenantId=${harder.id}`, headers: owner });
    expect(own.statusCode).toBe(200);
    expect(own.json().items.every((i: { tenantId: string }) => i.tenantId === harder.id)).toBe(true);
    expect(own.json().items.map((i: { action: string }) => i.action)).toContain('member.add');
  });

  it('filters, pages and exports', async () => {
    const page1 = (await t.app.inject({ url: '/api/audit?limit=2', headers: admin })).json();
    expect(page1.items).toHaveLength(2);
    const page2 = (await t.app.inject({ url: `/api/audit?limit=2&before=${page1.nextBefore}`, headers: admin })).json();
    expect(page2.items[0].id).toBeLessThan(page1.items[1].id);
    const tenants = (await t.app.inject({ url: '/api/audit?action=tenant', headers: admin })).json();
    expect(tenants.items.every((i: { action: string }) => i.action.startsWith('tenant.'))).toBe(true);
    const csv = await t.app.inject({ url: '/api/audit/export.csv?action=tenant.create', headers: admin });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('"tenant.create"');
    expect(csv.body.trim().split('\r\n')).toHaveLength(3);
  });
});

describe('password reset and invitations', () => {
  it('sends a reset link and lets the user choose a new password', async () => {
    await t.app.inject({ method: 'POST', url: '/api/users', headers: admin, payload: { email: 'dj@example.com', name: 'DJ Dutch', password: 'old-password-1', locale: 'nl' } });
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'dj@example.com' } });
    expect(res.statusCode).toBe(200);
    const mail = inbox.find((m) => m.to === 'dj@example.com')!;
    expect(mail.raw).toContain('Stel je wachtwoord opnieuw in');
    const token = tokenFrom(mail.raw);
    expect((await t.app.inject({ url: `/api/auth/reset/${token}` })).json()).toMatchObject({ email: 'dj@example.com', purpose: 'reset' });
    const reset = await t.app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'new-password-1' } });
    expect(reset.statusCode).toBe(200);
    await login(t.app, 'dj@example.com', 'new-password-1');
    const again = await t.app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'another-pass-1' } });
    expect(again.statusCode).toBe(404);
  });

  it('answers the same for unknown addresses', async () => {
    const before = inbox.length;
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'nobody@example.com' } });
    expect(res.statusCode).toBe(200);
    expect(inbox.length).toBe(before);
  });

  it('invites a new member by e-mail', async () => {
    const harder = (await t.app.inject({ url: '/api/tenants', headers: admin })).json().find((x: { slug: string }) => x.slug === 'harder-fm');
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/tenants/${harder.id}/members`,
      headers: admin,
      payload: { email: 'new@harder.fm', name: 'New DJ', role: 'dj', sendInvite: true },
    });
    expect(res.statusCode).toBe(201);
    const mail = inbox.find((m) => m.to === 'new@harder.fm')!;
    expect(mail.raw).toContain('Harder.fm');
    const token = tokenFrom(mail.raw);
    expect((await t.app.inject({ url: `/api/auth/reset/${token}` })).json().purpose).toBe('invite');
    const accept = await t.app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'my-first-password' } });
    expect(accept.json().memberships[0].tenantName).toBe('Harder.fm');
  });

  it('tells the sign-in page what it can offer', async () => {
    expect((await t.app.inject({ url: '/api/auth/options' })).json()).toEqual({ passwordReset: true, sso: false });
  });
});
