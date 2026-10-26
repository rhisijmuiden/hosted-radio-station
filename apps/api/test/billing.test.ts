import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { billingTick } from '../src/services/billing/engine.js';
import { addMonths, vatFor } from '../src/services/billing/money.js';
import { billingSettingsSchema } from '../src/services/settings.js';
import { login, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let admin: { cookie: string };
let smtp: SMTPServer;
const inbox: { to: string; raw: string }[] = [];
let hookServer: Server;
const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
let mollie: Server;
const molliePayments = new Map<string, { status: string; metadata: unknown; amount: unknown }>();
let provisioningKey: string;

const DAY = 86400_000;
const text = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');

beforeAll(async () => {
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

  hookServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(req.url === '/fail' ? 500 : 204).end();
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));

  // A tiny stand-in for the Mollie API.
  mollie = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer test_abcdefghijklmnop') return res.writeHead(401).end(JSON.stringify({ detail: 'Unauthorized' }));
      if (req.method === 'POST' && req.url === '/payments') {
        const p = JSON.parse(body);
        const id = `tr_${molliePayments.size + 1}abc`;
        molliePayments.set(id, { status: 'open', metadata: p.metadata, amount: p.amount });
        return res.end(JSON.stringify({ id, status: 'open', metadata: p.metadata, _links: { checkout: { href: `https://checkout.example/${id}` } } }));
      }
      const m = req.url?.match(/^\/payments\/(tr_\w+)$/);
      if (m && molliePayments.has(m[1]!)) {
        const p = molliePayments.get(m[1]!)!;
        return res.end(JSON.stringify({ id: m[1], status: p.status, method: 'ideal', metadata: p.metadata, paidAt: p.status === 'paid' ? new Date().toISOString() : undefined }));
      }
      if (req.url === '/methods') return res.end(JSON.stringify({ _embedded: { methods: [{ id: 'ideal', description: 'iDEAL' }] } }));
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => mollie.listen(0, '127.0.0.1', r));
  process.env.HRS_MOLLIE_API_URL = `http://127.0.0.1:${(mollie.address() as AddressInfo).port}`;

  t = await setup({ PUBLIC_URL: 'https://radio.example.com' });
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  await t.app.inject({
    method: 'PUT',
    url: '/api/settings/smtp',
    headers: admin,
    payload: { enabled: true, host: '127.0.0.1', port: (smtp.server.address() as AddressInfo).port, security: 'none', fromAddress: 'radio@example.com' },
  });
});

afterAll(async () => {
  delete process.env.HRS_MOLLIE_API_URL;
  await t.close();
  await new Promise<void>((r) => smtp.close(r));
  await new Promise<void>((r) => hookServer.close(() => r()));
  await new Promise<void>((r) => mollie.close(() => r()));
});

const settings = (over: Partial<ReturnType<typeof billingSettingsSchema.parse>> = {}) =>
  billingSettingsSchema.parse({
    enabled: true,
    company: { company: 'RHIS', address: 'Kanaalstraat 1', postcode: '1971 AA', city: 'IJmuiden', country: 'NL', vatNumber: 'NL001234567B01', iban: 'NL91ABNA0417164300', email: 'billing@rhis.nl' },
    ...over,
  });

describe('money and VAT', () => {
  it('adds months without running past the end of a month', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonths(new Date('2026-10-26T00:00:00Z'), 12).toISOString()).toBe('2027-10-26T00:00:00.000Z');
  });

  it('charges Dutch VAT at home, reverse charges EU businesses and leaves services outside the EU out', () => {
    const s = settings();
    expect(vatFor(s, { country: 'NL', vatNumber: '' })).toEqual({ rate: 21, scheme: 'standard' });
    expect(vatFor(s, { country: 'BE', vatNumber: 'BE0123456789' })).toEqual({ rate: 0, scheme: 'reverse_charge' });
    expect(vatFor(s, { country: 'DE', vatNumber: '' })).toEqual({ rate: 21, scheme: 'standard' });
    expect(vatFor(s, { country: 'US', vatNumber: '' })).toEqual({ rate: 0, scheme: 'export' });
    expect(vatFor(s, { country: '', vatNumber: '' }).scheme).toBe('standard');
  });
});

describe('hosted service', () => {
  let basic: { id: string };
  let pro: { id: string };

  it('saves the billing settings with the Mollie key masked', async () => {
    const s = settings({ mollie: { enabled: true, apiKey: 'test_abcdefghijklmnop' } });
    const res = await t.app.inject({ method: 'PUT', url: '/api/billing/settings', headers: admin, payload: s });
    expect(res.statusCode).toBe(200);
    expect(res.json().mollie.apiKey).toBe('••••••••');
    const check = await t.app.inject({ method: 'POST', url: '/api/billing/settings/mollie-test', headers: admin, payload: { apiKey: '••••••••' } });
    expect(check.json()).toEqual({ ok: true, testMode: true, methods: ['iDEAL'] });
  });

  it('manages packages and lists the public ones for the website', async () => {
    const make = (code: string, name: string, edition: string, price: number, extra = {}) =>
      t.app.inject({
        method: 'POST',
        url: '/api/billing/packages',
        headers: admin,
        payload: {
          code,
          name,
          edition,
          limits: { maxStations: 1, maxListeners: 100, maxBitrateKbps: 128, storageQuotaMb: 1024, maxNodes: 0 },
          priceMonthCents: price,
          priceYearCents: price * 10,
          description: { en: `${name} for small stations`, nl: `${name} voor kleine stations` },
          features: [{ en: 'Statistics', nl: 'Statistieken' }],
          ...extra,
        },
      });
    const b = await make('stream-basic', 'Stream Basic', 'distribution', 1000, { trialDays: 14, setupFeeCents: 2500 });
    expect(b.statusCode).toBe(201);
    basic = b.json();
    pro = (await make('radio-pro', 'Radio Pro', 'station', 3000, { limits: { maxStations: 3, maxListeners: 500, maxBitrateKbps: 320, storageQuotaMb: 20480, maxNodes: 1 } })).json();
    await make('hidden', 'Hidden deal', 'station', 500, { public: false });
    expect((await make('stream-basic', 'Dup', 'distribution', 1)).statusCode).toBe(409);

    const pub = await t.app.inject({ url: '/api/public/packages' });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().vatRate).toBe(21);
    expect(pub.json().packages.map((p: { code: string }) => p.code)).toEqual(['stream-basic', 'radio-pro']);
    expect(pub.headers['access-control-allow-origin']).toBe('*');
  });

  it('creates a provisioning key that only works for the sign-up API', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/api-keys', headers: admin, payload: { name: 'RHIS website', scope: 'provisioning' } });
    expect(res.statusCode).toBe(201);
    provisioningKey = res.json().secret;
    const auth = { authorization: `Bearer ${provisioningKey}` };
    expect((await t.app.inject({ url: '/api/tenants', headers: auth })).statusCode).toBe(403);
    expect((await t.app.inject({ url: '/api/provisioning/packages', headers: auth })).json()).toHaveLength(3);
  });

  it('delivers signed webhooks', async () => {
    const port = (hookServer.address() as AddressInfo).port;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/billing/webhooks',
      headers: admin,
      payload: { name: 'Website', url: `http://127.0.0.1:${port}/hook`, events: ['*'] },
    });
    expect(res.statusCode).toBe(201);
    const { id, secret } = res.json();
    expect(secret).toMatch(/^whsec_/);
    const test = await t.app.inject({ method: 'POST', url: `/api/billing/webhooks/${id}/test`, headers: admin });
    expect(test.json()).toMatchObject({ state: 'delivered', responseStatus: 204, event: 'webhook.test' });
    const last = received.at(-1)!;
    const sig = String(last.headers['x-hrs-signature']);
    const [, ts, v1] = sig.match(/^t=(\d+),v1=([0-9a-f]+)$/)!;
    expect(createHmac('sha256', secret).update(`${ts}.${last.body}`).digest('hex')).toBe(v1);
    (globalThis as { hookSecret?: string }).hookSecret = secret;
  });

  let tenantId: string;
  it('signs a customer up from the website in one call, once per Idempotency-Key', async () => {
    received.length = 0;
    inbox.length = 0;
    const payload = {
      package: 'stream-basic',
      customer: { name: 'Radio Zeezicht', externalRef: 'web-1001' },
      owner: { email: 'Info@Zeezicht.nl', name: 'Anna de Vries', locale: 'nl' },
      billing: { company: 'Zeezicht Media BV', address: 'Strandweg 5', postcode: '1976 AB', city: 'IJmuiden', country: 'NL' },
      station: { name: 'Zeezicht FM' },
    };
    const headers = { authorization: `Bearer ${provisioningKey}`, 'idempotency-key': 'order-1001-abc' };
    const res = await t.app.inject({ method: 'POST', url: '/api/provisioning/signup', headers, payload });
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json();
    tenantId = out.tenant.id;
    expect(out.tenant).toMatchObject({ slug: 'radio-zeezicht', plan: 'distribution', externalRef: 'web-1001', limits: { maxStations: 1, maxBitrateKbps: 128 } });
    expect(out.subscription).toMatchObject({ status: 'trialing', interval: 'month', package: { code: 'stream-basic' }, billing: { email: 'info@zeezicht.nl', vatNumber: '' } });
    expect(out.owner).toMatchObject({ email: 'info@zeezicht.nl', created: true });
    expect(out.station).toMatchObject({ slug: 'zeezicht-fm', publicUrl: 'https://radio.example.com/public/zeezicht-fm' });
    expect(out.stationError).toBeNull();
    expect(out.welcomeSent).toBe(true);
    expect(out.activationUrl).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    const welcome = inbox.find((m) => m.to === 'info@zeezicht.nl')!;
    expect(text(welcome.raw)).toContain('Welkom bij Hosted Radio Station');
    expect(text(welcome.raw)).toMatch(/reset-password\?token=/);
    expect(received.map((r) => JSON.parse(r.body).event)).toEqual(expect.arrayContaining(['subscription.created', 'customer.created']));

    // A retry gives the same answer and creates nothing.
    const again = await t.app.inject({ method: 'POST', url: '/api/provisioning/signup', headers, payload });
    expect(again.statusCode).toBe(200);
    expect(again.json().tenant.id).toBe(tenantId);
    const other = await t.app.inject({ method: 'POST', url: '/api/provisioning/signup', headers, payload: { ...payload, interval: 'year' } });
    expect(other.statusCode).toBe(409);
    const dup = await t.app.inject({ method: 'POST', url: '/api/provisioning/signup', headers: { authorization: headers.authorization }, payload });
    expect(dup.statusCode).toBe(409);

    const found = await t.app.inject({ url: '/api/provisioning/customers?externalRef=web-1001', headers: { authorization: headers.authorization } });
    expect(found.json()).toHaveLength(1);
    expect(found.json()[0].owners[0].email).toBe('info@zeezicht.nl');
  });

  let invoiceId: string;
  it('invoices the first period when the trial ends, with the setup fee and Dutch VAT', async () => {
    inbox.length = 0;
    const [sub] = await t.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    await billingTick(t.ctx, new Date(sub!.currentPeriodEnd.getTime() + 1000));
    const list = await t.app.inject({ url: `/api/billing/invoices?tenantId=${tenantId}`, headers: admin });
    expect(list.json().total).toBe(1);
    const inv = list.json().items[0];
    invoiceId = inv.id;
    expect(inv.number).toMatch(/^HRS-\d{4}-0001$/);
    expect(inv).toMatchObject({ status: 'open', subtotalCents: 3500, vatRate: 21, vatCents: 735, totalCents: 4235, vatScheme: 'standard', payable: true, locale: 'nl' });
    expect(inv.lines.map((l: { description: string }) => l.description)).toEqual([expect.stringMatching(/^Pakket Stream Basic \(per maand\)/), 'Eenmalige opstartkosten']);
    const [fresh] = await t.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    expect(fresh!.status).toBe('active');

    await new Promise((r) => setTimeout(r, 300));
    const mail = inbox.find((m) => m.to === 'info@zeezicht.nl')!;
    expect(mail.raw).toContain('application/pdf');
    expect(text(mail.raw)).toContain(`Factuur ${inv.number}`);

    const pdf = await t.app.inject({ url: `/api/billing/invoices/${invoiceId}/pdf`, headers: admin });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('lets the customer pay online through Mollie from the link in the e-mail', async () => {
    const inv = (await t.app.inject({ url: `/api/billing/invoices/${invoiceId}`, headers: admin })).json();
    const url = new URL(inv.publicUrl);
    const page = await t.app.inject({ url: url.pathname + url.search });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(inv.number);
    expect(page.body).toContain('Online betalen');
    expect((await t.app.inject({ url: `${url.pathname}?t=wrong` })).statusCode).toBe(404);

    const pay = await t.app.inject({ url: `${url.pathname}/pay${url.search}` });
    expect(pay.statusCode).toBe(302);
    expect(pay.headers.location).toMatch(/^https:\/\/checkout\.example\/tr_/);
    const paymentId = String(pay.headers.location).split('/').pop()!;
    expect(molliePayments.get(paymentId)!.amount).toEqual({ currency: 'EUR', value: '42.35' });

    // Not paid yet: the customer comes back to "pending".
    const back = await t.app.inject({ url: `${url.pathname}/return${url.search}` });
    expect(back.headers.location).toContain('status=pending');
    molliePayments.get(paymentId)!.status = 'paid';
    const hook = await t.app.inject({ method: 'POST', url: '/api/billing/mollie/webhook', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `id=${paymentId}` });
    expect(hook.statusCode).toBe(200);
    const paid = (await t.app.inject({ url: `/api/billing/invoices/${invoiceId}`, headers: admin })).json();
    expect(paid).toMatchObject({ status: 'paid', paymentMethod: 'mollie:ideal', paymentRef: paymentId });
  });

  it('upgrades right away with a prorated invoice and downgrades at the end of the period', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/subscription/change`, headers: admin, payload: { packageCode: 'radio-pro' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().applied).toBe('now');
    expect(res.json().invoice.lines[0].description).toMatch(/^Upgrade van Stream Basic naar Radio Pro/);
    // Almost the whole month is left: close to the 20 euro difference.
    expect(res.json().invoice.subtotalCents).toBeGreaterThan(1800);
    expect(res.json().invoice.subtotalCents).toBeLessThanOrEqual(2000);
    const [tenant] = await t.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    expect(tenant).toMatchObject({ plan: 'station', limits: { maxStations: 3, maxNodes: 1 } });

    const down = await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/subscription/change`, headers: admin, payload: { packageId: basic.id } });
    expect(down.json()).toMatchObject({ applied: 'period_end', invoice: null, subscription: { package: { code: 'radio-pro' }, pendingPackage: { code: 'stream-basic' } } });
    const info = await t.app.inject({ url: `/api/tenants/${tenantId}/subscription`, headers: admin });
    expect(info.json().next).toMatchObject({ subtotalCents: 1000, vatCents: 210, totalCents: 1210 });
    // Undo the downgrade for the next tests.
    await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/subscription/change`, headers: admin, payload: { packageId: pro.id } });
  });

  it('reminds, then takes an unpaid customer off the air, and brings it back when paid', async () => {
    inbox.length = 0;
    const open = (await t.app.inject({ url: `/api/billing/invoices?tenantId=${tenantId}&status=open`, headers: admin })).json().items;
    expect(open).toHaveLength(1);
    const upgrade = open[0];
    const due = new Date(upgrade.dueAt).getTime();
    await billingTick(t.ctx, new Date(due + 4 * DAY));
    let [sub] = await t.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    expect(sub!.status).toBe('past_due');
    await new Promise((r) => setTimeout(r, 300));
    expect(inbox.some((m) => text(m.raw).includes('Herinnering'))).toBe(true);

    await billingTick(t.ctx, new Date(due + 15 * DAY));
    [sub] = await t.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    expect(sub!.status).toBe('suspended');
    let [tenant] = await t.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    expect(tenant!.active).toBe(false);

    const paid = await t.app.inject({ method: 'POST', url: `/api/billing/invoices/${upgrade.id}/paid`, headers: admin, payload: { method: 'bank_transfer', reference: 'ABN 123' } });
    expect(paid.json().status).toBe('paid');
    [sub] = await t.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    expect(sub!.status).toBe('active');
    [tenant] = await t.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    expect(tenant!.active).toBe(true);
  });

  it('shows customers their own invoices only, and lets owners cancel at the end of the period', async () => {
    await t.db.update(schema.users).set({ passwordHash: (await import('../src/lib/auth.js').then((m) => m.hashPassword('owner-password'))) }).where(eq(schema.users.email, 'info@zeezicht.nl'));
    const owner = await login(t.app, 'info@zeezicht.nl', 'owner-password');
    const mine = await t.app.inject({ url: `/api/billing/invoices?tenantId=${tenantId}`, headers: owner });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().total).toBeGreaterThan(0);
    expect((await t.app.inject({ url: '/api/billing/invoices', headers: owner })).statusCode).toBe(400);
    expect((await t.app.inject({ url: '/api/billing/subscriptions', headers: owner })).statusCode).toBe(403);
    const pkgs = await t.app.inject({ url: '/api/billing/packages', headers: owner });
    expect(pkgs.json().map((p: { code: string }) => p.code)).toEqual(['stream-basic', 'radio-pro']);
    // Owners change billing details but not the price.
    expect((await t.app.inject({ method: 'PATCH', url: `/api/tenants/${tenantId}/subscription`, headers: owner, payload: { discountPercent: 50 } })).statusCode).toBe(403);
    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/api/tenants/${tenantId}/subscription`,
      headers: owner,
      payload: { billing: { company: 'Zeezicht Media BV', email: 'boekhouding@zeezicht.nl', country: 'BE', vatNumber: 'be 0123 456 789' } },
    });
    expect(patched.json().billing).toMatchObject({ email: 'boekhouding@zeezicht.nl', vatNumber: 'BE0123456789' });

    const cancel = await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/subscription/cancel`, headers: owner, payload: {} });
    expect(cancel.json()).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect((await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/subscription/cancel`, headers: owner, payload: { immediate: true } })).statusCode).toBe(403);
    const [sub] = await t.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    await billingTick(t.ctx, new Date(sub!.currentPeriodEnd.getTime() + 1000));
    const [ended] = await t.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    expect(ended!.status).toBe('cancelled');
    const [tenant] = await t.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    expect(tenant!.active).toBe(false);
  });

  it('reverse charges an EU business and makes manual invoices', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/subscription/resume`, headers: admin });
    expect(res.json().status).toBe('active');
    const list = (await t.app.inject({ url: `/api/billing/invoices?tenantId=${tenantId}&status=open`, headers: admin })).json().items;
    expect(list[0]).toMatchObject({ vatScheme: 'reverse_charge', vatCents: 0, buyer: { country: 'BE' } });
    const manual = await t.app.inject({
      method: 'POST',
      url: '/api/billing/invoices',
      headers: admin,
      payload: { tenantId, lines: [{ description: 'Extra storage', quantity: 2, unitCents: 500 }], send: false },
    });
    expect(manual.statusCode).toBe(201);
    expect(manual.json()).toMatchObject({ subtotalCents: 1000, totalCents: 1000 });
    const voided = await t.app.inject({ method: 'POST', url: `/api/billing/invoices/${manual.json().id}/void`, headers: admin });
    expect(voided.json().status).toBe('void');
    const ov = await t.app.inject({ url: '/api/billing/overview', headers: admin });
    expect(ov.json()).toMatchObject({ enabled: true, mrrCents: 3000, arrCents: 36000 });
  });

  it('refuses a package the customer has outgrown', async () => {
    await t.db.update(schema.tenants).set({ limits: { maxStations: 5, maxListeners: 1000, maxBitrateKbps: 128, storageQuotaMb: 1024, maxNodes: 0 } }).where(eq(schema.tenants.id, tenantId));
    for (const name of ['Zeezicht Two']) {
      const r = await t.app.inject({ method: 'POST', url: '/api/stations', headers: admin, payload: { tenantId, name, slug: 'zeezicht-two' } });
      expect(r.statusCode, r.body).toBe(201);
    }
    const down = await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/subscription/change`, headers: admin, payload: { packageCode: 'stream-basic', when: 'now' } });
    expect(down.statusCode).toBe(400);
    expect(down.json().error.message).toContain('2 stations');
  });
});
