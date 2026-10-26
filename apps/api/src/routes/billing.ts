import fastifyFormbody from '@fastify/formbody';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { requireSuperadmin, requireTenantRole, requireUser } from '../lib/auth.js';
import { randomToken } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../lib/errors.js';
import { idParam, okOut, planSchema, tenantLimitsSchema } from '../lib/schemas.js';
import {
  billingOverview,
  billingTick,
  cancelSubscription,
  changePackage,
  createInvoice,
  createSubscription,
  emptyContact,
  invoicePageUrl,
  line,
  markInvoicePaid,
  resumeSubscription,
  sendInvoiceEmail,
  startPayment,
  suspendSubscription,
  syncMolliePayment,
  unsuspendSubscription,
  voidInvoice,
  type Invoice,
  type Package,
} from '../services/billing/engine.js';
import { verifyKey } from '../services/billing/mollie.js';
import { basePrice, monthlyValue, packagePrice, vatFor } from '../services/billing/money.js';
import { renderInvoicePdf } from '../services/billing/pdf.js';
import { deliverDue, emitEvent, WEBHOOK_EVENTS } from '../services/billing/webhooks.js';
import { billingSettingsSchema, getMaskedSetting, getSetting, putSetting, SECRET_MASK } from '../services/settings.js';

// Shapes

const localized = z.object({ en: z.string().trim().max(2000).default(''), nl: z.string().trim().max(2000).default('') });
const cents = z.number().int().min(0).max(100_000_000);

export const packageIn = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/, 'Use lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(80),
  description: localized.default({ en: '', nl: '' }),
  features: z.array(localized).max(20).default([]),
  edition: planSchema,
  limits: tenantLimitsSchema,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('EUR'),
  priceMonthCents: cents,
  priceYearCents: cents.nullable().default(null),
  setupFeeCents: cents.default(0),
  trialDays: z.number().int().min(0).max(365).default(0),
  public: z.boolean().default(true),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export const packageOut = packageIn.extend({
  id: z.uuid(),
  subscriberCount: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const contactSchema = z.object({
  company: z.string().trim().max(200).default(''),
  name: z.string().trim().max(200).default(''),
  email: z.string().trim().toLowerCase().refine((v) => v === '' || z.email().safeParse(v).success, 'Invalid e-mail address').default(''),
  address: z.string().trim().max(300).default(''),
  postcode: z.string().trim().max(20).default(''),
  city: z.string().trim().max(100).default(''),
  country: z.string().trim().toUpperCase().refine((v) => v === '' || /^[A-Z]{2}$/.test(v), 'Use a two-letter country code').default(''),
  vatNumber: z.string().trim().toUpperCase().max(30).transform((v) => v.replace(/[\s.-]/g, '')).default(''),
  reference: z.string().trim().max(100).default(''),
});

const contactOut = z.object({
  company: z.string(),
  name: z.string(),
  email: z.string(),
  address: z.string(),
  postcode: z.string(),
  city: z.string(),
  country: z.string(),
  vatNumber: z.string(),
  reference: z.string(),
});

const statusSchema = z.enum(['trialing', 'active', 'past_due', 'suspended', 'cancelled']);
const intervalSchema = z.enum(['month', 'year']);

const pkgBrief = z.object({ id: z.uuid(), code: z.string(), name: z.string(), edition: planSchema, currency: z.string() });

export const subscriptionOut = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  tenantName: z.string(),
  tenantSlug: z.string(),
  package: pkgBrief,
  pendingPackage: pkgBrief.nullable(),
  interval: intervalSchema,
  pendingInterval: intervalSchema.nullable(),
  status: statusSchema,
  trialEndsAt: z.date().nullable(),
  currentPeriodStart: z.date(),
  currentPeriodEnd: z.date(),
  cancelAtPeriodEnd: z.boolean(),
  cancelledAt: z.date().nullable(),
  suspendedAt: z.date().nullable(),
  customPriceCents: z.number().int().nullable(),
  discountPercent: z.number().int(),
  customLimits: z.boolean(),
  billing: contactOut,
  locale: z.string(),
  notes: z.string(),
  /** Price per interval without VAT, after discount. */
  priceCents: z.number().int(),
  monthlyCents: z.number().int(),
  createdAt: z.date(),
});

const lineOut = z.object({ description: z.string(), quantity: z.number(), unitCents: z.number().int(), amountCents: z.number().int() });
const partyOut = z.object({
  company: z.string(),
  name: z.string(),
  email: z.string(),
  address: z.string(),
  postcode: z.string(),
  city: z.string(),
  country: z.string(),
  vatNumber: z.string(),
});

export const invoiceOut = z.object({
  id: z.uuid(),
  number: z.string(),
  tenantId: z.uuid().nullable(),
  tenantName: z.string(),
  subscriptionId: z.uuid().nullable(),
  status: z.enum(['open', 'paid', 'void']),
  overdue: z.boolean(),
  issuedAt: z.date(),
  dueAt: z.date(),
  periodStart: z.date().nullable(),
  periodEnd: z.date().nullable(),
  currency: z.string(),
  lines: z.array(lineOut),
  subtotalCents: z.number().int(),
  vatRate: z.number(),
  vatScheme: z.string(),
  vatCents: z.number().int(),
  totalCents: z.number().int(),
  buyer: partyOut.extend({ reference: z.string() }),
  locale: z.string(),
  notes: z.string(),
  paidAt: z.date().nullable(),
  paymentMethod: z.string().nullable(),
  paymentRef: z.string().nullable(),
  /** Online payment possible (Mollie). */
  payable: z.boolean(),
  sentAt: z.date().nullable(),
  remindedAt: z.date().nullable(),
  /** Page that works without signing in, as sent in the e-mail. */
  publicUrl: z.string(),
});

const webhookOut = z.object({
  id: z.uuid(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  active: z.boolean(),
  createdAt: z.date(),
  lastDelivery: z.object({ state: z.string(), event: z.string(), responseStatus: z.number().nullable(), at: z.date() }).nullable(),
});

const deliveryOut = z.object({
  id: z.uuid(),
  event: z.string(),
  state: z.string(),
  attempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  nextAttemptAt: z.date(),
  deliveredAt: z.date().nullable(),
  createdAt: z.date(),
  payload: z.record(z.string(), z.unknown()),
});

const eventSchema = z.enum([...WEBHOOK_EVENTS, '*']);

// Helpers shared with the provisioning and tenant routes

export async function subscriberCounts(ctx: Parameters<FastifyPluginAsyncZod>[0]['ctx']) {
  const rows = await ctx.db
    .select({ id: schema.subscriptions.packageId, n: sql<number>`count(*)::int` })
    .from(schema.subscriptions)
    .where(sql`${schema.subscriptions.status} <> 'cancelled'`)
    .groupBy(schema.subscriptions.packageId);
  return new Map(rows.map((r) => [r.id, r.n]));
}

export function toPackageOut(p: Package, counts: Map<string, number>) {
  return { ...p, subscriberCount: counts.get(p.id) ?? 0 };
}

const brief = (p: Package) => ({ id: p.id, code: p.code, name: p.name, edition: p.edition, currency: p.currency });

export async function loadSubscriptionOut(ctx: Parameters<FastifyPluginAsyncZod>[0]['ctx'], where: SQL) {
  const pending = schema.packages;
  const rows = await ctx.db
    .select({ sub: schema.subscriptions, pkg: schema.packages, tenant: schema.tenants })
    .from(schema.subscriptions)
    .innerJoin(schema.packages, eq(schema.packages.id, schema.subscriptions.packageId))
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.subscriptions.tenantId))
    .where(where)
    .orderBy(asc(schema.tenants.name));
  const pendingIds = [...new Set(rows.map((r) => r.sub.pendingPackageId).filter((v): v is string => !!v))];
  const pendings = pendingIds.length ? await ctx.db.select().from(pending).where(sql`${pending.id} in ${pendingIds}`) : [];
  return rows.map(({ sub, pkg, tenant }) => {
    const pp = pendings.find((p) => p.id === sub.pendingPackageId);
    const price = basePrice(sub, pkg, sub.interval);
    return {
      ...sub,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      package: brief(pkg),
      pendingPackage: pp ? brief(pp) : null,
      billing: { ...emptyContact(), ...sub.billing },
      priceCents: Math.round(price * (1 - sub.discountPercent / 100)),
      monthlyCents: monthlyValue(sub, pkg),
    };
  });
}

export async function toInvoiceOut(ctx: Parameters<FastifyPluginAsyncZod>[0]['ctx'], inv: Invoice, mollie?: boolean) {
  const on = mollie ?? (await getSetting(ctx, 'billing').then((s) => s.mollie.enabled && !!s.mollie.apiKey));
  return {
    ...inv,
    overdue: inv.status === 'open' && inv.dueAt < new Date(),
    payable: !!on && inv.status === 'open' && inv.totalCents > 0,
    publicUrl: invoicePageUrl(ctx, inv.id),
  };
}

export const billingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  await app.register(fastifyFormbody);

  // Settings

  app.get(
    '/settings',
    { schema: { tags: ['Billing'], summary: 'Invoice details, VAT, payment terms, dunning and online payment (secrets masked)', response: { 200: billingSettingsSchema } } },
    async (req) => {
      requireSuperadmin(req);
      return getMaskedSetting(ctx, 'billing');
    },
  );

  app.put(
    '/settings',
    {
      config: { audit: 'settings.billing' },
      schema: { tags: ['Billing'], summary: `Save the billing settings. Send "${SECRET_MASK}" to keep the Mollie key.`, body: billingSettingsSchema, response: { 200: billingSettingsSchema } },
    },
    async (req) => {
      requireSuperadmin(req);
      if (req.body.enabled && !req.body.company.company) throw badRequest('Fill in the company name that appears on invoices');
      await putSetting(ctx, 'billing', req.body);
      return getMaskedSetting(ctx, 'billing');
    },
  );

  app.post(
    '/settings/mollie-test',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Billing'],
        summary: 'Check a Mollie API key and list the payment methods it offers',
        body: z.object({ apiKey: z.string().trim().min(1) }),
        response: { 200: z.object({ ok: z.literal(true), testMode: z.boolean(), methods: z.array(z.string()) }) },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const key = req.body.apiKey === SECRET_MASK ? (await getSetting(ctx, 'billing')).mollie.apiKey : req.body.apiKey;
      if (!/^(live|test)_\w+$/.test(key)) throw badRequest('A Mollie API key starts with live_ or test_');
      return { ok: true as const, testMode: key.startsWith('test_'), methods: await verifyKey(key) };
    },
  );

  app.get(
    '/overview',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Recurring revenue, subscriptions per status and open invoices',
        response: {
          200: z.object({
            enabled: z.boolean(),
            mrrCents: z.number().int(),
            arrCents: z.number().int(),
            subscriptions: z.record(statusSchema, z.number().int()),
            openInvoices: z.number().int(),
            openCents: z.number().int(),
            overdueCents: z.number().int(),
            paidLast30Cents: z.number().int(),
          }),
        },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const s = await getSetting(ctx, 'billing');
      return { enabled: s.enabled, ...(await billingOverview(ctx)) };
    },
  );

  app.post(
    '/run',
    {
      config: { audit: 'billing.run' },
      schema: { tags: ['Billing'], summary: 'Run the billing round now (renewals, reminders, suspensions) instead of waiting for the timer', response: { 200: z.object({ renewed: z.number(), overdue: z.number().optional() }) } },
    },
    async (req) => {
      requireSuperadmin(req);
      return billingTick(ctx);
    },
  );

  // Packages

  app.get(
    '/packages',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Packages. Administrators see all; customers see the ones they can choose.',
        response: { 200: z.array(packageOut) },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const admin = auth.user.isSuperadmin && !auth.keyTenantId;
      const rows = await ctx.db
        .select()
        .from(schema.packages)
        .where(admin ? undefined : and(eq(schema.packages.public, true), eq(schema.packages.active, true)))
        .orderBy(asc(schema.packages.sortOrder), asc(schema.packages.priceMonthCents));
      const counts = admin ? await subscriberCounts(ctx) : new Map<string, number>();
      return rows.map((p) => toPackageOut(p, counts));
    },
  );

  app.post(
    '/packages',
    { config: { audit: 'package.create' }, schema: { tags: ['Billing'], summary: 'Create a package', body: packageIn, response: { 201: packageOut } } },
    async (req, reply) => {
      requireSuperadmin(req);
      try {
        const [p] = await ctx.db.insert(schema.packages).values(req.body).returning();
        req.auditInfo = { targetId: p!.id, details: { code: p!.code, name: p!.name } };
        reply.status(201);
        return toPackageOut(p!, new Map());
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A package with this code already exists');
        throw err;
      }
    },
  );

  app.patch(
    '/packages/:id',
    {
      config: { audit: 'package.update' },
      schema: {
        tags: ['Billing'],
        summary: 'Change a package. New limits reach existing customers when `applyToSubscribers` is true; prices apply from their next period.',
        params: idParam,
        body: packageIn.partial().extend({ applyToSubscribers: z.boolean().default(false) }),
        response: { 200: packageOut },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const { applyToSubscribers, ...body } = req.body;
      // Partial of a schema with defaults would reset fields; keep only what was sent.
      const sent = Object.fromEntries(Object.keys(req.body).filter((k) => k !== 'applyToSubscribers').map((k) => [k, body[k as keyof typeof body]]));
      try {
        const [p] = await ctx.db.update(schema.packages).set({ ...sent, updatedAt: new Date() }).where(eq(schema.packages.id, req.params.id)).returning();
        if (!p) throw notFound('Package');
        if (applyToSubscribers && (sent.limits || sent.edition)) {
          const { applyPackageToTenant } = await import('../services/billing/engine.js');
          const subs = await ctx.db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.packageId, p.id), sql`${schema.subscriptions.status} <> 'cancelled'`));
          for (const s of subs) await applyPackageToTenant(ctx, s.tenantId, p, s.customLimits);
        }
        req.auditInfo = { targetId: p.id, details: { changed: Object.keys(sent), applyToSubscribers } };
        return toPackageOut(p, await subscriberCounts(ctx));
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A package with this code already exists');
        throw err;
      }
    },
  );

  app.delete(
    '/packages/:id',
    { config: { audit: 'package.delete' }, schema: { tags: ['Billing'], summary: 'Delete a package that nobody has (retire it with active: false otherwise)', params: idParam, response: { 200: okOut } } },
    async (req) => {
      requireSuperadmin(req);
      const [used] = await ctx.db.select({ id: schema.subscriptions.id }).from(schema.subscriptions).where(eq(schema.subscriptions.packageId, req.params.id)).limit(1);
      if (used) throw conflict('Customers have this package; switch it off for new customers instead');
      const deleted = await ctx.db.delete(schema.packages).where(eq(schema.packages.id, req.params.id)).returning();
      if (!deleted.length) throw notFound('Package');
      return { ok: true as const };
    },
  );

  // Subscriptions

  app.get(
    '/subscriptions',
    {
      schema: {
        tags: ['Billing'],
        summary: 'All subscriptions with their customer and package',
        querystring: z.object({ status: statusSchema.optional(), packageId: z.uuid().optional(), q: z.string().trim().max(100).optional() }),
        response: { 200: z.array(subscriptionOut) },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const { status, packageId, q } = req.query;
      const conds: SQL[] = [sql`true`];
      if (status) conds.push(eq(schema.subscriptions.status, status));
      if (packageId) conds.push(eq(schema.subscriptions.packageId, packageId));
      if (q) conds.push(or(ilike(schema.tenants.name, `%${q}%`), ilike(schema.tenants.slug, `%${q}%`))!);
      return loadSubscriptionOut(ctx, and(...conds)!);
    },
  );

  // Invoices

  async function invoiceAccess(req: Parameters<typeof requireUser>[0], id: string, minRole: 'manager' | 'owner') {
    const [inv] = await ctx.db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    if (!inv) throw notFound('Invoice');
    const auth = requireUser(req);
    if (!(auth.user.isSuperadmin && !auth.keyTenantId)) {
      if (!inv.tenantId) throw forbidden();
      await requireTenantRole(ctx, req, inv.tenantId, minRole);
    }
    return inv;
  }

  app.get(
    '/invoices',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Invoices, newest first. Customers (owners and managers) see their own.',
        querystring: z.object({
          tenantId: z.uuid().optional(),
          status: z.enum(['open', 'paid', 'void', 'overdue']).optional(),
          q: z.string().trim().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.object({ total: z.number().int(), items: z.array(invoiceOut) }) },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { tenantId, status, q, limit, offset } = req.query;
      const admin = auth.user.isSuperadmin && !auth.keyTenantId;
      if (!admin) {
        if (!tenantId) throw badRequest('Choose a customer');
        await requireTenantRole(ctx, req, tenantId, 'manager');
      }
      const conds: SQL[] = [sql`true`];
      if (tenantId) conds.push(eq(schema.invoices.tenantId, tenantId));
      if (status === 'overdue') conds.push(and(eq(schema.invoices.status, 'open'), sql`${schema.invoices.dueAt} < now()`)!);
      else if (status) conds.push(eq(schema.invoices.status, status));
      if (q) conds.push(or(ilike(schema.invoices.number, `%${q}%`), ilike(schema.invoices.tenantName, `%${q}%`))!);
      const where = and(...conds);
      const [{ n }] = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.invoices).where(where)) as [{ n: number }];
      const rows = await ctx.db.select().from(schema.invoices).where(where).orderBy(desc(schema.invoices.issuedAt), desc(schema.invoices.number)).limit(limit).offset(offset);
      const s = await getSetting(ctx, 'billing');
      const mollie = s.mollie.enabled && !!s.mollie.apiKey;
      return { total: n, items: await Promise.all(rows.map((r) => toInvoiceOut(ctx, r, mollie))) };
    },
  );

  app.post(
    '/invoices',
    {
      config: { audit: 'invoice.create' },
      schema: {
        tags: ['Billing'],
        summary: 'Make an invoice by hand (extra work, a credit with negative amounts). Uses the billing details of the subscription when there is one.',
        body: z.object({
          tenantId: z.uuid(),
          lines: z
            .array(z.object({ description: z.string().trim().min(1).max(300), quantity: z.number().min(-10000).max(10000), unitCents: z.number().int().min(-100_000_000).max(100_000_000) }))
            .min(1)
            .max(50),
          notes: z.string().trim().max(1000).default(''),
          send: z.boolean().default(true),
        }),
        response: { 201: invoiceOut },
      },
    },
    async (req, reply) => {
      requireSuperadmin(req);
      const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, req.body.tenantId));
      if (!tenant) throw notFound('Customer');
      const [sub] = await ctx.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenant.id));
      const inv = await createInvoice(ctx, {
        tenant,
        subscriptionId: sub?.id ?? null,
        billing: sub?.billing ?? emptyContact(),
        locale: sub?.locale ?? 'en',
        lines: req.body.lines.map((l) => line(l.description, l.quantity, l.unitCents)),
        notes: req.body.notes,
        send: req.body.send,
      });
      req.auditInfo = { tenantId: tenant.id, targetId: inv.id, details: { number: inv.number, totalCents: inv.totalCents } };
      reply.status(201);
      return toInvoiceOut(ctx, inv);
    },
  );

  app.get(
    '/invoices/:id',
    { schema: { tags: ['Billing'], summary: 'One invoice', params: idParam, response: { 200: invoiceOut } } },
    async (req) => toInvoiceOut(ctx, await invoiceAccess(req, req.params.id, 'manager')),
  );

  app.get(
    '/invoices/:id/pdf',
    { schema: { tags: ['Billing'], summary: 'The invoice as a PDF', params: idParam } },
    async (req, reply) => {
      const inv = await invoiceAccess(req, req.params.id, 'manager');
      const pdf = await renderInvoicePdf(ctx, inv);
      return reply.header('content-disposition', `inline; filename="${inv.number}.pdf"`).type('application/pdf').send(pdf);
    },
  );

  app.post(
    '/invoices/:id/paid',
    {
      config: { audit: 'invoice.paid' },
      schema: {
        tags: ['Billing'],
        summary: 'Book a payment received by bank transfer (or another way)',
        params: idParam,
        body: z.object({ method: z.string().trim().min(1).max(40).default('bank_transfer'), reference: z.string().trim().max(200).nullish(), paidAt: z.coerce.date().optional() }),
        response: { 200: invoiceOut },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const inv = await invoiceAccess(req, req.params.id, 'owner');
      const paid = await markInvoicePaid(ctx, inv, req.body);
      req.auditInfo = { tenantId: inv.tenantId, targetId: inv.id, details: { number: inv.number, method: req.body.method } };
      return toInvoiceOut(ctx, paid);
    },
  );

  app.post(
    '/invoices/:id/void',
    { config: { audit: 'invoice.void' }, schema: { tags: ['Billing'], summary: 'Cancel an open invoice', params: idParam, response: { 200: invoiceOut } } },
    async (req) => {
      requireSuperadmin(req);
      const inv = await invoiceAccess(req, req.params.id, 'owner');
      req.auditInfo = { tenantId: inv.tenantId, targetId: inv.id, details: { number: inv.number } };
      return toInvoiceOut(ctx, await voidInvoice(ctx, inv));
    },
  );

  app.post(
    '/invoices/:id/send',
    {
      config: { audit: 'invoice.send', rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { tags: ['Billing'], summary: 'E-mail the invoice (again) to the billing address', params: idParam, response: { 200: okOut } },
    },
    async (req) => {
      requireSuperadmin(req);
      const inv = await invoiceAccess(req, req.params.id, 'owner');
      req.auditInfo = { tenantId: inv.tenantId, targetId: inv.id, details: { number: inv.number } };
      await sendInvoiceEmail(ctx, inv);
      return { ok: true as const };
    },
  );

  app.post(
    '/invoices/:id/pay',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { tags: ['Billing'], summary: 'Start an online payment (Mollie) and get the checkout address', params: idParam, response: { 200: z.object({ checkoutUrl: z.string() }) } },
    },
    async (req) => {
      const inv = await invoiceAccess(req, req.params.id, 'manager');
      return { checkoutUrl: await startPayment(ctx, inv) };
    },
  );

  // Mollie calls this with the payment id when a payment changes. Mollie does not sign it; the payment is fetched back.
  app.post(
    '/mollie/webhook',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, schema: { hide: true, body: z.object({ id: z.string().max(64) }) } },
    async (req, reply) => {
      await syncMolliePayment(ctx, req.body.id).catch((err) => req.log.warn({ err }, 'mollie webhook'));
      return reply.status(200).send('');
    },
  );

  // Webhooks

  async function webhookList(where?: SQL) {
    const hooks = await ctx.db.select().from(schema.webhooks).where(where).orderBy(asc(schema.webhooks.name));
    const last = hooks.length
      ? await ctx.db.execute<{ webhook_id: string; state: string; event: string; response_status: number | null; created_at: string }>(
          sql`select distinct on (webhook_id) webhook_id, state, event, response_status, created_at from webhook_deliveries order by webhook_id, created_at desc`,
        )
      : [];
    return hooks.map(({ secret: _s, ...h }) => {
      const l = [...last].find((r) => r.webhook_id === h.id);
      return { ...h, lastDelivery: l ? { state: l.state, event: l.event, responseStatus: l.response_status, at: new Date(l.created_at) } : null };
    });
  }

  const urlSchema = z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//.test(u), 'Use an http(s) address');

  app.get('/webhooks', { schema: { tags: ['Webhooks'], summary: 'Outgoing webhooks', response: { 200: z.array(webhookOut) } } }, async (req) => {
    requireSuperadmin(req);
    return webhookList();
  });

  app.post(
    '/webhooks',
    {
      config: { audit: 'webhook.create' },
      schema: {
        tags: ['Webhooks'],
        summary: 'Add a webhook. The signing secret is only returned once.',
        body: z.object({ name: z.string().trim().min(1).max(80), url: urlSchema, events: z.array(eventSchema).min(1), active: z.boolean().default(true) }),
        response: { 201: webhookOut.extend({ secret: z.string() }) },
      },
    },
    async (req, reply) => {
      requireSuperadmin(req);
      const secret = `whsec_${randomToken(24)}`;
      const [h] = await ctx.db.insert(schema.webhooks).values({ ...req.body, secret: ctx.box.encrypt(secret) }).returning();
      req.auditInfo = { targetId: h!.id, details: { name: h!.name, url: h!.url } };
      reply.status(201);
      const [out] = await webhookList(eq(schema.webhooks.id, h!.id));
      return { ...out!, secret };
    },
  );

  app.patch(
    '/webhooks/:id',
    {
      config: { audit: 'webhook.update' },
      schema: {
        tags: ['Webhooks'],
        summary: 'Change a webhook; `rotateSecret` returns a new signing secret',
        params: idParam,
        body: z.object({ name: z.string().trim().min(1).max(80).optional(), url: urlSchema.optional(), events: z.array(eventSchema).min(1).optional(), active: z.boolean().optional(), rotateSecret: z.boolean().optional() }),
        response: { 200: webhookOut.extend({ secret: z.string().optional() }) },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const { rotateSecret, ...set } = req.body;
      const secret = rotateSecret ? `whsec_${randomToken(24)}` : undefined;
      const [h] = await ctx.db
        .update(schema.webhooks)
        .set({ ...set, ...(secret ? { secret: ctx.box.encrypt(secret) } : {}) })
        .where(eq(schema.webhooks.id, req.params.id))
        .returning();
      if (!h) throw notFound('Webhook');
      const [out] = await webhookList(eq(schema.webhooks.id, h.id));
      return { ...out!, secret };
    },
  );

  app.delete(
    '/webhooks/:id',
    { config: { audit: 'webhook.delete' }, schema: { tags: ['Webhooks'], summary: 'Delete a webhook', params: idParam, response: { 200: okOut } } },
    async (req) => {
      requireSuperadmin(req);
      const deleted = await ctx.db.delete(schema.webhooks).where(eq(schema.webhooks.id, req.params.id)).returning();
      if (!deleted.length) throw notFound('Webhook');
      return { ok: true as const };
    },
  );

  app.post(
    '/webhooks/:id/test',
    { schema: { tags: ['Webhooks'], summary: 'Send a "webhook.test" event now', params: idParam, response: { 200: deliveryOut } } },
    async (req) => {
      requireSuperadmin(req);
      const rows = await emitEvent(ctx, 'webhook.test', { message: 'Test from Hosted Radio Station' }, req.params.id);
      if (!rows.length) throw badRequest('Switch the webhook on first');
      await rows.sent;
      const [d] = await ctx.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, rows[0]!.id));
      return d!;
    },
  );

  app.get(
    '/webhooks/:id/deliveries',
    { schema: { tags: ['Webhooks'], summary: 'The last 50 deliveries of a webhook', params: idParam, response: { 200: z.array(deliveryOut) } } },
    async (req) => {
      requireSuperadmin(req);
      return ctx.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, req.params.id)).orderBy(desc(schema.webhookDeliveries.createdAt)).limit(50);
    },
  );

  app.post(
    '/webhooks/deliveries/:id/retry',
    { schema: { tags: ['Webhooks'], summary: 'Try a delivery again now', params: idParam, response: { 200: deliveryOut } } },
    async (req) => {
      requireSuperadmin(req);
      const [d] = await ctx.db
        .update(schema.webhookDeliveries)
        .set({ state: 'pending', nextAttemptAt: new Date() })
        .where(eq(schema.webhookDeliveries.id, req.params.id))
        .returning();
      if (!d) throw notFound('Delivery');
      await deliverDue(ctx, [d.id]);
      const [fresh] = await ctx.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, d.id));
      return fresh!;
    },
  );
};

// The subscription of one customer: /api/tenants/:id/subscription

const subscriptionCreate = z.object({
  packageId: z.uuid().optional(),
  packageCode: z.string().trim().toLowerCase().optional(),
  interval: intervalSchema.default('month'),
  billing: contactSchema.default(contactSchema.parse({})),
  locale: z.enum(['en', 'nl']).default('en'),
  /** Overrides the trial of the package; 0 = invoice straight away. */
  trialDays: z.number().int().min(0).max(365).optional(),
  customPriceCents: cents.nullish(),
  discountPercent: z.number().int().min(0).max(100).default(0),
  notes: z.string().trim().max(2000).default(''),
});

export async function findPackage(ctx: Parameters<FastifyPluginAsyncZod>[0]['ctx'], by: { packageId?: string; packageCode?: string }) {
  if (!by.packageId && !by.packageCode) throw badRequest('Choose a package');
  const [p] = await ctx.db
    .select()
    .from(schema.packages)
    .where(by.packageId ? eq(schema.packages.id, by.packageId) : eq(schema.packages.code, by.packageCode!));
  if (!p) throw notFound('Package');
  return p;
}

export const tenantBillingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  const one = async (tenantId: string) => (await loadSubscriptionOut(ctx, eq(schema.subscriptions.tenantId, tenantId)))[0] ?? null;
  async function subOf(tenantId: string) {
    const [sub] = await ctx.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    if (!sub) throw notFound('Subscription');
    return sub;
  }

  app.get(
    '/:id/subscription',
    {
      schema: {
        tags: ['Billing'],
        summary: "The customer's subscription (null when the customer is not billed), with the next invoice",
        params: idParam,
        response: {
          200: z.object({
            subscription: subscriptionOut.nullable(),
            billingEnabled: z.boolean(),
            mollie: z.boolean(),
            next: z.object({ at: z.date(), subtotalCents: z.number().int(), vatCents: z.number().int(), totalCents: z.number().int(), vatRate: z.number() }).nullable(),
          }),
        },
      },
    },
    async (req) => {
      await requireTenantRole(ctx, req, req.params.id, 'manager');
      const sub = await one(req.params.id);
      const s = await getSetting(ctx, 'billing');
      let next = null;
      if (sub && s.enabled && sub.status !== 'cancelled' && !sub.cancelAtPeriodEnd) {
        const [pkg] = await ctx.db.select().from(schema.packages).where(eq(schema.packages.id, sub.pendingPackage?.id ?? sub.package.id));
        const interval = sub.pendingInterval ?? sub.interval;
        const price = sub.pendingPackage ? packagePrice(pkg!, interval) : basePrice(sub, pkg!, interval);
        const subtotal = Math.round(price * (1 - sub.discountPercent / 100));
        const vat = vatFor(s, sub.billing);
        const vatCents = Math.round((subtotal * vat.rate) / 100);
        next = { at: sub.currentPeriodEnd, subtotalCents: subtotal, vatCents, totalCents: subtotal + vatCents, vatRate: vat.rate };
      }
      return { subscription: sub, billingEnabled: s.enabled, mollie: s.mollie.enabled && !!s.mollie.apiKey, next };
    },
  );

  app.post(
    '/:id/subscription',
    {
      config: { audit: 'subscription.create' },
      schema: {
        tags: ['Billing'],
        summary: 'Put a customer on a package (administrators). The package sets the edition and limits; the first period is invoiced unless there is a trial.',
        params: idParam,
        body: subscriptionCreate,
        response: { 201: subscriptionOut },
      },
    },
    async (req, reply) => {
      requireSuperadmin(req);
      const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, req.params.id));
      if (!tenant) throw notFound('Customer');
      const [existing] = await ctx.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenant.id));
      if (existing) throw conflict('This customer already has a subscription; change its package instead');
      const pkg = await findPackage(ctx, req.body);
      const sub = await createSubscription(ctx, { tenant, pkg, ...req.body });
      req.auditInfo = { tenantId: tenant.id, targetId: sub.id, details: { package: pkg.code, interval: sub.interval, status: sub.status } };
      reply.status(201);
      return (await one(tenant.id))!;
    },
  );

  app.patch(
    '/:id/subscription',
    {
      config: { audit: 'subscription.update' },
      schema: {
        tags: ['Billing'],
        summary: 'Change billing details (owners), or price, discount, dates and notes (administrators)',
        params: idParam,
        body: z.object({
          billing: contactSchema.optional(),
          locale: z.enum(['en', 'nl']).optional(),
          customPriceCents: cents.nullish(),
          discountPercent: z.number().int().min(0).max(100).optional(),
          customLimits: z.boolean().optional(),
          trialEndsAt: z.coerce.date().optional(),
          currentPeriodEnd: z.coerce.date().optional(),
          notes: z.string().trim().max(2000).optional(),
        }),
        response: { 200: subscriptionOut },
      },
    },
    async (req) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'owner');
      const sub = await subOf(req.params.id);
      const { billing, locale, ...adminOnly } = req.body;
      if (Object.values(adminOnly).some((v) => v !== undefined) && access.role !== 'superadmin') throw forbidden('Only administrators can change these fields');
      const set: Partial<typeof schema.subscriptions.$inferInsert> = { updatedAt: new Date() };
      if (billing) set.billing = billing;
      if (locale) set.locale = locale;
      for (const k of ['customPriceCents', 'discountPercent', 'customLimits', 'notes', 'currentPeriodEnd'] as const) if (adminOnly[k] !== undefined) (set as Record<string, unknown>)[k] = adminOnly[k];
      if (adminOnly.trialEndsAt) {
        if (sub.status !== 'trialing') throw badRequest('Only a trial can be extended');
        set.trialEndsAt = adminOnly.trialEndsAt;
        set.currentPeriodEnd = adminOnly.trialEndsAt;
      }
      await ctx.db.update(schema.subscriptions).set(set).where(eq(schema.subscriptions.id, sub.id));
      if (adminOnly.customLimits === false && sub.customLimits) {
        const [pkg] = await ctx.db.select().from(schema.packages).where(eq(schema.packages.id, sub.packageId));
        const { applyPackageToTenant } = await import('../services/billing/engine.js');
        await applyPackageToTenant(ctx, sub.tenantId, pkg!, false);
      }
      req.auditInfo = { tenantId: sub.tenantId, targetId: sub.id, details: { changed: Object.keys(req.body) } };
      await emitEvent(ctx, 'subscription.updated', { tenantId: sub.tenantId, subscriptionId: sub.id });
      return (await one(req.params.id))!;
    },
  );

  app.post(
    '/:id/subscription/change',
    {
      config: { audit: 'subscription.change' },
      schema: {
        tags: ['Billing'],
        summary:
          'Move to another package. Upgrades take effect now with a prorated invoice; downgrades and another interval at the end of the period. Administrators can choose `when` and `prorate`.',
        params: idParam,
        body: z.object({
          packageId: z.uuid().optional(),
          packageCode: z.string().trim().toLowerCase().optional(),
          interval: intervalSchema.optional(),
          when: z.enum(['auto', 'now', 'period_end']).default('auto'),
          prorate: z.boolean().default(true),
        }),
        response: { 200: z.object({ applied: z.enum(['now', 'period_end']), subscription: subscriptionOut, invoice: invoiceOut.nullable() }) },
      },
    },
    async (req) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'owner');
      const sub = await subOf(req.params.id);
      const pkg = await findPackage(ctx, req.body);
      const admin = access.role === 'superadmin';
      if (!admin) {
        if (!pkg.public || !pkg.active) throw forbidden('This package cannot be chosen');
        if (req.body.when !== 'auto' || !req.body.prorate) throw forbidden('Only administrators can choose when a change takes effect');
        if (sub.status === 'suspended') throw badRequest('Pay the open invoice first');
      }
      if (!pkg.active && pkg.id !== sub.packageId && !admin) throw badRequest('This package is no longer sold');
      const result = await changePackage(ctx, sub.id, pkg, req.body);
      req.auditInfo = { tenantId: sub.tenantId, targetId: sub.id, details: { to: pkg.code, applied: result.applied } };
      return { applied: result.applied, subscription: (await one(req.params.id))!, invoice: result.invoice ? await toInvoiceOut(ctx, result.invoice) : null };
    },
  );

  app.post(
    '/:id/subscription/cancel',
    {
      config: { audit: 'subscription.cancel' },
      schema: {
        tags: ['Billing'],
        summary: 'Cancel at the end of the period (owners), or right away (administrators). Stations go off the air when it ends.',
        params: idParam,
        body: z.object({ immediate: z.boolean().default(false) }),
        response: { 200: subscriptionOut },
      },
    },
    async (req) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'owner');
      if (req.body.immediate && access.role !== 'superadmin') throw forbidden('Only administrators can end a subscription right away');
      const sub = await subOf(req.params.id);
      await cancelSubscription(ctx, sub.id, req.body.immediate);
      req.auditInfo = { tenantId: sub.tenantId, targetId: sub.id, details: { immediate: req.body.immediate } };
      return (await one(req.params.id))!;
    },
  );

  app.post(
    '/:id/subscription/resume',
    {
      config: { audit: 'subscription.resume' },
      schema: { tags: ['Billing'], summary: 'Undo a cancellation; an ended subscription starts again (administrators)', params: idParam, response: { 200: subscriptionOut } },
    },
    async (req) => {
      const access = await requireTenantRole(ctx, req, req.params.id, 'owner');
      const sub = await subOf(req.params.id);
      if (sub.status === 'cancelled' && access.role !== 'superadmin') throw forbidden('Ask us to start your subscription again');
      await resumeSubscription(ctx, sub.id);
      req.auditInfo = { tenantId: sub.tenantId, targetId: sub.id };
      return (await one(req.params.id))!;
    },
  );

  app.post(
    '/:id/subscription/suspend',
    { config: { audit: 'subscription.suspend' }, schema: { tags: ['Billing'], summary: 'Take the customer off the air (administrators)', params: idParam, response: { 200: subscriptionOut } } },
    async (req) => {
      requireSuperadmin(req);
      const sub = await subOf(req.params.id);
      await suspendSubscription(ctx, sub.id);
      req.auditInfo = { tenantId: sub.tenantId, targetId: sub.id };
      return (await one(req.params.id))!;
    },
  );

  app.post(
    '/:id/subscription/unsuspend',
    { config: { audit: 'subscription.unsuspend' }, schema: { tags: ['Billing'], summary: 'Put a suspended customer back on the air (administrators)', params: idParam, response: { 200: subscriptionOut } } },
    async (req) => {
      requireSuperadmin(req);
      const sub = await subOf(req.params.id);
      await unsuspendSubscription(ctx, sub.id);
      req.auditInfo = { tenantId: sub.tenantId, targetId: sub.id };
      return (await one(req.params.id))!;
    },
  );

  app.delete(
    '/:id/subscription',
    {
      config: { audit: 'subscription.delete' },
      schema: { tags: ['Billing'], summary: 'Stop billing this customer altogether (administrators). Invoices are kept; the customer stays as it is.', params: idParam, response: { 200: okOut } },
    },
    async (req) => {
      requireSuperadmin(req);
      const sub = await subOf(req.params.id);
      await ctx.db.delete(schema.subscriptions).where(eq(schema.subscriptions.id, sub.id));
      req.auditInfo = { tenantId: sub.tenantId, targetId: sub.id };
      return { ok: true as const };
    },
  );
};
