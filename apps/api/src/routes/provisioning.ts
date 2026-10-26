import { and, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { hashPassword, INTERNAL_CALL_TOKEN, requireSuperadmin } from '../lib/auth.js';
import { badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors.js';
import { emailSchema, idParam, passwordSchema, slugSchema, tenantOut } from '../lib/schemas.js';
import { createPasswordToken } from '../services/accounts.js';
import {
  cancelSubscription,
  changePackage,
  createSubscription,
  resumeSubscription,
  subscriptionRef,
  tenantRef,
} from '../services/billing/engine.js';
import { formatDate } from '../services/billing/money.js';
import { emitEvent } from '../services/billing/webhooks.js';
import { emailWords, fill, renderTemplate } from '../services/email-templates.js';
import { mailConfigured, sendMail } from '../services/mail.js';
import { contactSchema, findPackage, invoiceOut, loadSubscriptionOut, packageOut, subscriberCounts, subscriptionOut, toInvoiceOut, toPackageOut } from './billing.js';

const slugify = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'customer';

const signupBody = z.object({
  /** Package code, as in GET /api/public/packages. */
  package: z.string().trim().toLowerCase().min(1),
  interval: z.enum(['month', 'year']).default('month'),
  customer: z.object({
    name: z.string().trim().min(1).max(120),
    /** Short name used in addresses; made from the name when left out. */
    slug: slugSchema.optional(),
    /** Your own id for the customer, e.g. the order or account number on the website. Must be unique. */
    externalRef: z.string().trim().min(1).max(200).optional(),
  }),
  owner: z.object({
    email: emailSchema,
    name: z.string().trim().min(1).max(120),
    locale: z.enum(['en', 'nl']).default('en'),
    /** Optional: set the password right away instead of e-mailing an activation link. */
    password: passwordSchema.optional(),
  }),
  billing: contactSchema.default(contactSchema.parse({})),
  /** Overrides the trial of the package. */
  trialDays: z.number().int().min(0).max(365).optional(),
  /** Optional first station, created with the package's edition. */
  station: z.object({ name: z.string().trim().min(1).max(120), slug: slugSchema.optional() }).optional(),
  /** E-mail the owner a welcome with the activation link. */
  sendWelcome: z.boolean().default(true),
});

const signupOut = z.object({
  tenant: tenantOut,
  subscription: subscriptionOut,
  owner: z.object({ id: z.uuid(), email: z.string(), name: z.string(), created: z.boolean() }),
  station: z.object({ id: z.uuid(), name: z.string(), slug: z.string(), publicUrl: z.string() }).nullable(),
  /** Why the first station could not be made; the customer exists anyway. */
  stationError: z.string().nullable(),
  panelUrl: z.string(),
  /** Link to choose a password, when no welcome e-mail was sent (redirect the new customer there). */
  activationUrl: z.string().nullable(),
  welcomeSent: z.boolean(),
});

/**
 * The API for the website that sells the service: public packages, sign-ups that create the customer, owner, subscription
 * and first station in one call, and looking customers up by your own reference. Use an API key with the "provisioning"
 * scope; send an Idempotency-Key header so a retry never creates a customer twice.
 */
export const provisioningRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const base = ctx.config.PUBLIC_URL.replace(/\/$/, '');

  app.get(
    '/packages',
    { schema: { tags: ['Provisioning'], summary: 'Packages that can be sold, also the ones not shown publicly', response: { 200: z.array(packageOut) } } },
    async (req) => {
      requireSuperadmin(req);
      const rows = await ctx.db.select().from(schema.packages).where(eq(schema.packages.active, true)).orderBy(schema.packages.sortOrder);
      const counts = await subscriberCounts(ctx);
      return rows.map((p) => toPackageOut(p, counts));
    },
  );

  app.post(
    '/signup',
    {
      config: { audit: 'provisioning.signup', rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['Provisioning'],
        summary: 'Sign a new customer up: customer, owner account, subscription and optionally the first station. Send an Idempotency-Key header.',
        headers: z.object({ 'idempotency-key': z.string().trim().min(1).max(200).optional() }).passthrough(),
        body: signupBody,
        response: { 201: signupOut, 200: signupOut },
      },
    },
    async (req, reply) => {
      const auth = requireSuperadmin(req);
      const idemKey = req.headers['idempotency-key'] as string | undefined;
      const requestHash = createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
      if (idemKey) {
        const [seen] = await ctx.db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, `signup:${idemKey}`));
        if (seen) {
          if (seen.requestHash !== requestHash) throw conflict('This Idempotency-Key was used for another request');
          req.auditInfo.skip = true;
          // The stored answer is already JSON (dates as strings): send it as it is.
          return reply
            .status(200)
            .header('idempotent-replayed', 'true')
            .type('application/json; charset=utf-8')
            .serializer((p: unknown) => JSON.stringify(p))
            .send(seen.response as z.infer<typeof signupOut>);
        }
      }
      const body = req.body;
      const pkg = await findPackage(ctx, { packageCode: body.package });
      if (!pkg.active) throw badRequest('This package is not sold any more');
      if (body.interval === 'year' && pkg.priceYearCents === null) throw badRequest('This package is only sold per month');
      if (body.customer.externalRef) {
        const [dup] = await ctx.db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.externalRef, body.customer.externalRef));
        if (dup) throw conflict(`A customer with this external reference already exists (${dup.id})`);
      }

      // A free short name: the one asked for, or the name with -2, -3, ...
      let slug = body.customer.slug ?? slugify(body.customer.name);
      if (!body.customer.slug) {
        const taken = new Set(
          (await ctx.db.select({ slug: schema.tenants.slug }).from(schema.tenants).where(ilike(schema.tenants.slug, `${slug}%`))).map((r) => r.slug),
        );
        for (let i = 2; taken.has(slug); i++) slug = `${slugify(body.customer.name).slice(0, 36)}-${i}`;
      }

      let created = false;
      let tenant: typeof schema.tenants.$inferSelect;
      let user: typeof schema.users.$inferSelect;
      try {
        ({ tenant, user } = await ctx.db.transaction(async (tx) => {
          const [t] = await tx
            .insert(schema.tenants)
            .values({ name: body.customer.name, slug, plan: pkg.edition, limits: pkg.limits, externalRef: body.customer.externalRef ?? null })
            .returning();
          let [u] = await tx.select().from(schema.users).where(eq(schema.users.email, body.owner.email));
          if (!u) {
            created = true;
            [u] = await tx
              .insert(schema.users)
              .values({
                email: body.owner.email,
                name: body.owner.name,
                locale: body.owner.locale,
                passwordHash: body.owner.password ? await hashPassword(body.owner.password) : null,
              })
              .returning();
          }
          await tx.insert(schema.memberships).values({ userId: u!.id, tenantId: t!.id, role: 'owner' });
          return { tenant: t!, user: u! };
        }));
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A customer with this short name already exists');
        throw err;
      }
      const billing = { ...body.billing, company: body.billing.company || body.customer.name, name: body.billing.name || body.owner.name, email: body.billing.email || body.owner.email };
      const sub = await createSubscription(ctx, { tenant, pkg, interval: body.interval, billing, locale: body.owner.locale, trialDays: body.trialDays });
      await emitEvent(ctx, 'customer.created', { tenant: tenantRef(tenant), owner: { id: user.id, email: user.email, name: user.name }, subscription: subscriptionRef(sub, pkg) });

      // First station, through the normal station API so every check and default applies.
      let station: z.infer<typeof signupOut>['station'] = null;
      let stationError: string | null = null;
      if (body.station) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/stations',
          headers: { authorization: req.headers.authorization ?? '', cookie: req.headers.cookie ?? '', 'x-hrs-internal': INTERNAL_CALL_TOKEN },
          payload: { tenantId: tenant.id, name: body.station.name, slug: body.station.slug ?? slugify(body.station.name), edition: pkg.edition },
        });
        const data = res.json() as { id?: string; name?: string; slug?: string; error?: { message: string } };
        if (res.statusCode === 201 && data.id) station = { id: data.id, name: data.name!, slug: data.slug!, publicUrl: `${base}/public/${data.slug}` };
        else stationError = data.error?.message ?? `HTTP ${res.statusCode}`;
      }

      // Welcome: an activation link for a new account without a password, otherwise the sign-in page.
      let activationUrl: string | null = null;
      if (!user.passwordHash) activationUrl = `${base}/reset-password?token=${encodeURIComponent(await createPasswordToken(ctx, user.id, 'invite'))}`;
      let welcomeSent = false;
      if (body.sendWelcome && (await mailConfigured(ctx))) {
        const words = emailWords[body.owner.locale]!;
        const trial = sub.trialEndsAt ? fill(words.trial!, { date: formatDate(sub.trialEndsAt, body.owner.locale) }) : '';
        const msg = renderTemplate(
          'welcome',
          body.owner.locale,
          { product: 'Hosted Radio Station', name: user.name, customer: tenant.name, package: pkg.name, trial, email: user.email },
          activationUrl ?? `${base}/login`,
        );
        try {
          await sendMail(ctx, { to: user.email, ...msg });
          welcomeSent = true;
        } catch (err) {
          req.log.warn({ err }, 'welcome e-mail failed');
        }
      }

      const [fresh] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenant.id));
      const out = {
        tenant: fresh!,
        subscription: (await loadSubscriptionOut(ctx, eq(schema.subscriptions.id, sub.id)))[0]!,
        owner: { id: user.id, email: user.email, name: user.name, created },
        station,
        stationError,
        panelUrl: `${base}/`,
        activationUrl: welcomeSent ? null : activationUrl,
        welcomeSent,
      };
      if (idemKey) {
        await ctx.db
          .insert(schema.idempotencyKeys)
          .values({ key: `signup:${idemKey}`, requestHash, statusCode: 201, response: JSON.parse(JSON.stringify(out)) })
          .onConflictDoNothing();
      }
      req.auditInfo = { tenantId: tenant.id, targetType: 'tenant', targetId: tenant.id, details: { package: pkg.code, owner: user.email, via: auth.scope } };
      reply.status(201);
      return out;
    },
  );

  const customerOut = z.object({
    tenant: tenantOut,
    subscription: subscriptionOut.nullable(),
    owners: z.array(z.object({ id: z.uuid(), email: z.string(), name: z.string() })),
  });

  async function customers(where: ReturnType<typeof eq>) {
    const tenants = await ctx.db.select().from(schema.tenants).where(where).limit(50);
    if (!tenants.length) return [];
    const ids = tenants.map((t) => t.id);
    const subs = await loadSubscriptionOut(ctx, inArray(schema.subscriptions.tenantId, ids));
    const owners = await ctx.db
      .select({ tenantId: schema.memberships.tenantId, id: schema.users.id, email: schema.users.email, name: schema.users.name })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(and(inArray(schema.memberships.tenantId, ids), eq(schema.memberships.role, 'owner')));
    return tenants.map((t) => ({
      tenant: t,
      subscription: subs.find((s) => s.tenantId === t.id) ?? null,
      owners: owners.filter((o) => o.tenantId === t.id).map(({ tenantId: _t, ...o }) => o),
    }));
  }

  app.get(
    '/customers',
    {
      schema: {
        tags: ['Provisioning'],
        summary: 'Find customers by your external reference or by the e-mail address of an owner',
        querystring: z.object({ externalRef: z.string().trim().min(1).optional(), email: emailSchema.optional() }),
        response: { 200: z.array(customerOut) },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const { externalRef, email } = req.query;
      if (!externalRef && !email) throw badRequest('Give externalRef or email');
      if (externalRef) return customers(eq(schema.tenants.externalRef, externalRef));
      const ids = await ctx.db
        .select({ id: schema.memberships.tenantId })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(and(eq(schema.users.email, email!), eq(schema.memberships.role, 'owner')));
      if (!ids.length) return [];
      return customers(inArray(schema.tenants.id, ids.map((i) => i.id)) as ReturnType<typeof eq>);
    },
  );

  app.get(
    '/customers/:id',
    { schema: { tags: ['Provisioning'], summary: 'One customer with its subscription', params: idParam, response: { 200: customerOut } } },
    async (req) => {
      requireSuperadmin(req);
      const [c] = await customers(eq(schema.tenants.id, req.params.id));
      if (!c) throw notFound('Customer');
      return c;
    },
  );

  app.get(
    '/customers/:id/invoices',
    { schema: { tags: ['Provisioning'], summary: "A customer's invoices, newest first", params: idParam, response: { 200: z.array(invoiceOut) } } },
    async (req) => {
      requireSuperadmin(req);
      const rows = await ctx.db.select().from(schema.invoices).where(eq(schema.invoices.tenantId, req.params.id)).orderBy(sql`${schema.invoices.issuedAt} desc`).limit(100);
      return Promise.all(rows.map((r) => toInvoiceOut(ctx, r)));
    },
  );

  async function subOf(tenantId: string) {
    const [sub] = await ctx.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    if (!sub) throw notFound('Subscription');
    return sub;
  }

  app.post(
    '/customers/:id/change',
    {
      config: { audit: 'provisioning.change' },
      schema: {
        tags: ['Provisioning'],
        summary: 'Up- or downgrade a customer (upgrades now with a prorated invoice, downgrades at the end of the period)',
        params: idParam,
        body: z.object({ package: z.string().trim().toLowerCase(), interval: z.enum(['month', 'year']).optional() }),
        response: { 200: z.object({ applied: z.enum(['now', 'period_end']), subscription: subscriptionOut }) },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const sub = await subOf(req.params.id);
      const pkg = await findPackage(ctx, { packageCode: req.body.package });
      const result = await changePackage(ctx, sub.id, pkg, { interval: req.body.interval });
      req.auditInfo = { tenantId: sub.tenantId, targetId: sub.id, details: { to: pkg.code, applied: result.applied } };
      return { applied: result.applied, subscription: (await loadSubscriptionOut(ctx, eq(schema.subscriptions.id, sub.id)))[0]! };
    },
  );

  app.post(
    '/customers/:id/cancel',
    {
      config: { audit: 'provisioning.cancel' },
      schema: { tags: ['Provisioning'], summary: 'Cancel at the end of the period, or right away', params: idParam, body: z.object({ immediate: z.boolean().default(false) }), response: { 200: subscriptionOut } },
    },
    async (req) => {
      requireSuperadmin(req);
      const sub = await subOf(req.params.id);
      await cancelSubscription(ctx, sub.id, req.body.immediate);
      req.auditInfo = { tenantId: sub.tenantId, targetId: sub.id, details: { immediate: req.body.immediate } };
      return (await loadSubscriptionOut(ctx, eq(schema.subscriptions.id, sub.id)))[0]!;
    },
  );

  app.post(
    '/customers/:id/resume',
    { config: { audit: 'provisioning.resume' }, schema: { tags: ['Provisioning'], summary: 'Undo a cancellation, or restart an ended subscription', params: idParam, response: { 200: subscriptionOut } } },
    async (req) => {
      requireSuperadmin(req);
      const sub = await subOf(req.params.id);
      await resumeSubscription(ctx, sub.id);
      req.auditInfo = { tenantId: sub.tenantId, targetId: sub.id };
      return (await loadSubscriptionOut(ctx, eq(schema.subscriptions.id, sub.id)))[0]!;
    },
  );
};

