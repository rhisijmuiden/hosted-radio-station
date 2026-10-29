import { and, asc, count, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { schema } from '../../db/index.js';
import type { BillingContact, InvoiceLine, InvoiceParty } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { badRequest } from '../../lib/errors.js';
import { emailLocale, emailWords, fill, renderTemplate } from '../email-templates.js';
import { mailConfigured, sendMail } from '../mail.js';
import { getSetting, type BillingSettings } from '../settings.js';
import { applyStreams } from '../streaming/state.js';
import { createPayment, getPayment, publicWebhookUrl } from './mollie.js';
import { addDays, addInterval, basePrice, formatDate, formatMoney, monthlyValue, totals, vatFor, type Interval } from './money.js';
import { renderInvoicePdf } from './pdf.js';
import { emitEvent } from './webhooks.js';

export type Package = typeof schema.packages.$inferSelect;
export type Subscription = typeof schema.subscriptions.$inferSelect;
export type Invoice = typeof schema.invoices.$inferSelect;
type Tenant = typeof schema.tenants.$inferSelect;

export const emptyContact = (): BillingContact => ({ company: '', name: '', email: '', address: '', postcode: '', city: '', country: '', vatNumber: '', reference: '' });

const base = (ctx: AppContext) => ctx.config.PUBLIC_URL.replace(/\/$/, '');

// Links that work without signing in (from e-mails and the PDF)

export function invoiceToken(ctx: AppContext, invoiceId: string) {
  return createHmac('sha256', `hrs-invoice:${ctx.config.APP_SECRET}`).update(invoiceId).digest('base64url').slice(0, 32);
}

export function checkInvoiceToken(ctx: AppContext, invoiceId: string, token: string | undefined) {
  const expected = Buffer.from(invoiceToken(ctx, invoiceId));
  const given = Buffer.from(token ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const invoicePageUrl = (ctx: AppContext, id: string) => `${base(ctx)}/api/public/invoices/${id}?t=${invoiceToken(ctx, id)}`;
export const invoicePayUrl = (ctx: AppContext, id: string) => `${base(ctx)}/api/public/invoices/${id}/pay?t=${invoiceToken(ctx, id)}`;

const mollieOn = (s: BillingSettings) => s.mollie.enabled && !!s.mollie.apiKey;

// Events

export function tenantRef(t: Tenant) {
  return { id: t.id, name: t.name, slug: t.slug, externalRef: t.externalRef, active: t.active };
}

export function subscriptionRef(sub: Subscription, pkg?: Package | null) {
  return {
    id: sub.id,
    status: sub.status,
    package: pkg ? { id: pkg.id, code: pkg.code, name: pkg.name, edition: pkg.edition } : { id: sub.packageId },
    interval: sub.interval,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

export function invoiceRef(inv: Invoice) {
  return {
    id: inv.id,
    number: inv.number,
    status: inv.status,
    currency: inv.currency,
    subtotalCents: inv.subtotalCents,
    vatCents: inv.vatCents,
    totalCents: inv.totalCents,
    issuedAt: inv.issuedAt,
    dueAt: inv.dueAt,
    paidAt: inv.paidAt,
  };
}

async function load(ctx: AppContext, subId: string) {
  const [row] = await ctx.db
    .select({ sub: schema.subscriptions, pkg: schema.packages, tenant: schema.tenants })
    .from(schema.subscriptions)
    .innerJoin(schema.packages, eq(schema.packages.id, schema.subscriptions.packageId))
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.subscriptions.tenantId))
    .where(eq(schema.subscriptions.id, subId));
  if (!row) throw badRequest('Subscription not found');
  return row;
}

async function emitSub(ctx: AppContext, event: Parameters<typeof emitEvent>[1], subId: string, extra: Record<string, unknown> = {}) {
  const { sub, pkg, tenant } = await load(ctx, subId);
  await emitEvent(ctx, event, { tenant: tenantRef(tenant), subscription: subscriptionRef(sub, pkg), ...extra });
}

/** Who gets billing e-mails: the billing address, else the owners of the customer. */
async function billingRecipients(ctx: AppContext, tenantId: string, contact: { email: string; name: string }) {
  if (contact.email) return [{ email: contact.email, name: contact.name || contact.email }];
  const owners = await ctx.db
    .select({ email: schema.users.email, name: schema.users.name })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.role, 'owner')));
  return owners;
}

// Packages on customers

/**
 * The limits of a package become the customer's (unless set by hand). The edition belongs to each station: a package
 * never turns a station back into Distribution by itself (that needs the owner's confirmation); a package with fewer
 * Radio stations than the customer runs is refused up front (usageProblems).
 */
export async function applyPackageToTenant(ctx: AppContext, tenantId: string, pkg: Package, customLimits: boolean) {
  await ctx.db
    .update(schema.tenants)
    .set({ plan: pkg.limits.maxRadioStations > 0 ? 'station' : 'distribution', ...(customLimits ? {} : { limits: pkg.limits }) })
    .where(eq(schema.tenants.id, tenantId));
  if (!customLimits) await applyStreams(ctx, { by: 'billing' }).catch(() => undefined);
}

/** Does the customer's current use fit in the package? Returns the reasons it does not. */
export async function usageProblems(ctx: AppContext, tenantId: string, pkg: Package) {
  const stations = await ctx.db.select().from(schema.stations).where(eq(schema.stations.tenantId, tenantId));
  const problems: string[] = [];
  if (stations.length > pkg.limits.maxStations) problems.push(`The customer has ${stations.length} stations; ${pkg.name} allows ${pkg.limits.maxStations}`);
  const radio = stations.filter((s) => s.edition === 'station').length;
  if (radio > pkg.limits.maxRadioStations) problems.push(`The customer has ${radio} Radio station(s); ${pkg.name} allows ${pkg.limits.maxRadioStations}. Switch stations back to Distribution first`);
  const storage = stations.reduce((n, s) => n + s.storageBytes, 0);
  if (storage > pkg.limits.storageQuotaMb * 1024 * 1024) problems.push(`The customer uses more storage than the ${pkg.limits.storageQuotaMb} MB of ${pkg.name}`);
  const [{ n }] = (await ctx.db.select({ n: count() }).from(schema.nodes).where(eq(schema.nodes.tenantId, tenantId))) as [{ n: number }];
  if (n > pkg.limits.maxNodes) problems.push(`The customer has ${n} own nodes; ${pkg.name} allows ${pkg.limits.maxNodes}`);
  return problems;
}

// Invoices

const lineWords = {
  en: { pkg: (name: string) => `${name} package`, setup: 'One-time setup fee', discount: (p: number) => `Discount ${p}%`, month: 'per month', year: 'per year' },
  nl: { pkg: (name: string) => `Pakket ${name}`, setup: 'Eenmalige opstartkosten', discount: (p: number) => `Korting ${p}%`, month: 'per maand', year: 'per jaar' },
};

export function line(description: string, quantity: number, unitCents: number): InvoiceLine {
  return { description, quantity, unitCents, amountCents: Math.round(quantity * unitCents) };
}

function sellerParty(s: BillingSettings): InvoiceParty {
  const c = s.company;
  return { ...c, footer: s.footer };
}

/** Numbers run per year: <prefix><year>-0001. The advisory lock keeps two invoices from getting the same number. */
async function nextNumber(tx: Parameters<Parameters<AppContext['db']['transaction']>[0]>[0], prefix: string, at: Date) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hrs_invoice_number'))`);
  const stem = `${prefix}${at.getUTCFullYear()}-`;
  const [last] = await tx
    .select({ number: schema.invoices.number })
    .from(schema.invoices)
    .where(sql`${schema.invoices.number} like ${`${stem}%`}`)
    .orderBy(desc(sql`length(${schema.invoices.number})`), desc(schema.invoices.number))
    .limit(1);
  const n = last ? Number(last.number.slice(stem.length)) || 0 : 0;
  return `${stem}${String(n + 1).padStart(4, '0')}`;
}

export async function createInvoice(
  ctx: AppContext,
  input: {
    tenant: Tenant;
    subscriptionId?: string | null;
    billing: BillingContact;
    locale: string;
    lines: InvoiceLine[];
    periodStart?: Date | null;
    periodEnd?: Date | null;
    notes?: string;
    currency?: string;
    send?: boolean;
    /** Invoice date; the billing round passes its own clock. */
    issuedAt?: Date;
  },
) {
  const settings = await getSetting(ctx, 'billing');
  const vat = vatFor(settings, input.billing);
  const sum = totals(input.lines, vat.rate);
  const now = input.issuedAt ?? new Date();
  const inv = await ctx.db.transaction(async (tx) => {
    const number = await nextNumber(tx, settings.invoicePrefix, now);
    const [row] = await tx
      .insert(schema.invoices)
      .values({
        number,
        tenantId: input.tenant.id,
        subscriptionId: input.subscriptionId ?? null,
        tenantName: input.tenant.name,
        issuedAt: now,
        dueAt: addDays(now, settings.paymentTermDays),
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        currency: input.currency ?? 'EUR',
        lines: input.lines,
        ...sum,
        vatRate: vat.rate,
        vatScheme: vat.scheme,
        seller: sellerParty(settings),
        buyer: { ...input.billing, company: input.billing.company || input.tenant.name, country: input.billing.country || settings.company.country },
        locale: emailLocale(input.locale),
        notes: input.notes ?? '',
        // Nothing to pay: settled right away.
        ...(sum.totalCents <= 0 ? { status: 'paid' as const, paidAt: now, paymentMethod: 'none' } : {}),
      })
      .returning();
    return row!;
  });
  let result = inv;
  if (inv.status === 'open' && mollieOn(settings)) {
    [result] = (await ctx.db.update(schema.invoices).set({ paymentUrl: invoicePayUrl(ctx, inv.id) }).where(eq(schema.invoices.id, inv.id)).returning()) as [Invoice];
  }
  await emitEvent(ctx, 'invoice.created', { tenant: tenantRef(input.tenant), invoice: invoiceRef(result) });
  if ((input.send ?? settings.emailInvoices) && result.totalCents > 0) await sendInvoiceEmail(ctx, result).catch(() => undefined);
  return result;
}

export async function sendInvoiceEmail(ctx: AppContext, inv: Invoice) {
  if (!(await mailConfigured(ctx))) throw badRequest('Set up the mail server first to send invoices');
  const settings = await getSetting(ctx, 'billing');
  const to = inv.tenantId ? await billingRecipients(ctx, inv.tenantId, inv.buyer) : inv.buyer.email ? [{ email: inv.buyer.email, name: inv.buyer.name }] : [];
  if (!to.length) throw badRequest('This customer has no billing e-mail address and no owner');
  const pdf = await renderInvoicePdf(ctx, inv);
  const words = emailWords[emailLocale(inv.locale)]!;
  const vars = {
    number: inv.number,
    seller: inv.seller.company || 'Hosted Radio Station',
    customer: inv.tenantName,
    amount: formatMoney(inv.totalCents, inv.currency, inv.locale),
    due: formatDate(inv.dueAt, inv.locale),
    iban: inv.seller.iban || '',
  };
  const payment = inv.status !== 'open' ? '' : fill(inv.paymentUrl ? words.payOnline! : inv.seller.iban ? words.payTransfer! : '', vars);
  for (const r of to) {
    const msg = renderTemplate('invoice', inv.locale, { ...vars, name: r.name, payment }, invoicePageUrl(ctx, inv.id));
    await sendMail(ctx, {
      to: r.email,
      bcc: settings.bccEmail,
      ...msg,
      attachments: [{ filename: `${inv.number}.pdf`, content: pdf, contentType: 'application/pdf' }],
    });
  }
  await ctx.db.update(schema.invoices).set({ sentAt: new Date() }).where(eq(schema.invoices.id, inv.id));
}

async function mailAbout(ctx: AppContext, template: 'invoiceReminder' | 'suspended' | 'paymentReceived', inv: Invoice, extra: Record<string, string> = {}) {
  if (!inv.tenantId || !(await mailConfigured(ctx))) return;
  const to = await billingRecipients(ctx, inv.tenantId, inv.buyer);
  const vars = { number: inv.number, amount: formatMoney(inv.totalCents, inv.currency, inv.locale), due: formatDate(inv.dueAt, inv.locale), customer: inv.tenantName, ...extra };
  const url = template === 'paymentReceived' ? base(ctx) : inv.paymentUrl ?? invoicePageUrl(ctx, inv.id);
  for (const r of to) await sendMail(ctx, { to: r.email, ...renderTemplate(template, inv.locale, { ...vars, name: r.name }, url) }).catch(() => undefined);
}

/** Marks an invoice paid; a customer that was behind on payments is back in good standing (and on the air). */
export async function markInvoicePaid(ctx: AppContext, inv: Invoice, p: { method: string; reference?: string | null; paidAt?: Date }) {
  if (inv.status === 'paid') return inv;
  if (inv.status === 'void') throw badRequest('This invoice has been cancelled');
  const [paid] = (await ctx.db
    .update(schema.invoices)
    .set({ status: 'paid', paidAt: p.paidAt ?? new Date(), paymentMethod: p.method, paymentRef: p.reference ?? null })
    .where(and(eq(schema.invoices.id, inv.id), eq(schema.invoices.status, 'open')))
    .returning()) as [Invoice | undefined];
  if (!paid) return inv;
  let resumed = false;
  if (paid.subscriptionId) resumed = await settleSubscription(ctx, paid.subscriptionId);
  if (paid.tenantId) {
    const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, paid.tenantId));
    if (tenant) await emitEvent(ctx, 'invoice.paid', { tenant: tenantRef(tenant), invoice: invoiceRef(paid) });
  }
  await mailAbout(ctx, 'paymentReceived', paid, { resumed: resumed ? emailWords[emailLocale(paid.locale)]!.resumed! : '' });
  return paid;
}

export async function voidInvoice(ctx: AppContext, inv: Invoice) {
  if (inv.status === 'paid') throw badRequest('A paid invoice cannot be cancelled; make a credit invoice instead');
  const [row] = (await ctx.db.update(schema.invoices).set({ status: 'void', paymentUrl: null }).where(eq(schema.invoices.id, inv.id)).returning()) as [Invoice];
  if (row.subscriptionId) await settleSubscription(ctx, row.subscriptionId);
  return row;
}

/** Open invoices of the subscription that are past their due date. */
async function overdueInvoices(ctx: AppContext, subId: string, now = new Date()) {
  return ctx.db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.subscriptionId, subId), eq(schema.invoices.status, 'open'), lte(schema.invoices.dueAt, now)))
    .orderBy(asc(schema.invoices.dueAt));
}

/** After a payment: no overdue invoices left = active again, and a suspended customer back on the air. */
async function settleSubscription(ctx: AppContext, subId: string) {
  const [sub] = await ctx.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, subId));
  if (!sub || (sub.status !== 'past_due' && sub.status !== 'suspended')) return false;
  if ((await overdueInvoices(ctx, subId)).length) return false;
  const wasSuspended = sub.status === 'suspended';
  await ctx.db.update(schema.subscriptions).set({ status: 'active', suspendedAt: null, updatedAt: new Date() }).where(eq(schema.subscriptions.id, subId));
  if (wasSuspended) {
    await ctx.db.update(schema.tenants).set({ active: true }).where(eq(schema.tenants.id, sub.tenantId));
    await applyStreams(ctx, { by: 'billing' }).catch(() => undefined);
    // A period that ended while suspended starts again now.
    const [fresh] = await ctx.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, subId));
    if (fresh && fresh.currentPeriodEnd <= new Date()) await renew(ctx, fresh.id, new Date(), true);
    await emitSub(ctx, 'subscription.resumed', subId);
  } else await emitSub(ctx, 'subscription.updated', subId);
  return wasSuspended;
}

// Online payment

/** Starts a Mollie payment for an open invoice and returns the checkout address. */
export async function startPayment(ctx: AppContext, inv: Invoice) {
  if (inv.status !== 'open') throw badRequest('This invoice does not need to be paid');
  const settings = await getSetting(ctx, 'billing');
  if (!mollieOn(settings)) throw badRequest('Online payment is not switched on');
  const payment = await createPayment(settings.mollie.apiKey, {
    amountCents: inv.totalCents,
    currency: inv.currency,
    description: `${inv.locale === 'nl' ? 'Factuur' : 'Invoice'} ${inv.number}`,
    redirectUrl: `${base(ctx)}/api/public/invoices/${inv.id}/return?t=${invoiceToken(ctx, inv.id)}`,
    webhookUrl: publicWebhookUrl(base(ctx)),
    invoiceId: inv.id,
    locale: inv.locale,
  });
  await ctx.db.update(schema.invoices).set({ molliePaymentId: payment.id }).where(eq(schema.invoices.id, inv.id));
  if (!payment.checkoutUrl) throw badRequest('Mollie did not return a checkout page');
  return payment.checkoutUrl;
}

/** Checks a Mollie payment (from the webhook or when the customer comes back) and books it when paid. */
export async function syncMolliePayment(ctx: AppContext, paymentId: string) {
  const settings = await getSetting(ctx, 'billing');
  if (!mollieOn(settings)) return null;
  const payment = await getPayment(settings.mollie.apiKey, paymentId);
  const invoiceId = payment.metadata?.invoiceId;
  if (!invoiceId) return null;
  const [inv] = await ctx.db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv) return null;
  if (payment.status === 'paid' && inv.status === 'open') {
    return markInvoicePaid(ctx, inv, { method: `mollie${payment.method ? `:${payment.method}` : ''}`, reference: payment.id, paidAt: payment.paidAt ? new Date(payment.paidAt) : undefined });
  }
  return inv;
}

// Subscriptions

function periodLines(sub: Subscription, pkg: Package, interval: Interval, start: Date, end: Date, withSetup: boolean) {
  const w = lineWords[emailLocale(sub.locale)];
  const range = `${formatDate(start, sub.locale)} – ${formatDate(new Date(end.getTime() - 86400_000), sub.locale)}`;
  const price = basePrice(sub, pkg, interval);
  const lines = [line(`${w.pkg(pkg.name)} (${w[interval]}), ${range}`, 1, price)];
  if (sub.discountPercent > 0) lines.push(line(w.discount(sub.discountPercent), 1, -Math.round((price * sub.discountPercent) / 100)));
  if (withSetup && pkg.setupFeeCents > 0) lines.push(line(w.setup, 1, pkg.setupFeeCents));
  return lines;
}

async function invoiceCount(ctx: AppContext, subId: string) {
  const [{ n }] = (await ctx.db.select({ n: count() }).from(schema.invoices).where(and(eq(schema.invoices.subscriptionId, subId), ne(schema.invoices.status, 'void')))) as [{ n: number }];
  return n;
}

async function invoicePeriod(ctx: AppContext, subId: string, issuedAt?: Date) {
  const settings = await getSetting(ctx, 'billing');
  if (!settings.enabled) return null;
  const { sub, pkg, tenant } = await load(ctx, subId);
  const lines = periodLines(sub, pkg, sub.interval, sub.currentPeriodStart, sub.currentPeriodEnd, (await invoiceCount(ctx, sub.id)) === 0);
  return createInvoice(ctx, { tenant, subscriptionId: sub.id, billing: sub.billing, locale: sub.locale, lines, periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd, currency: pkg.currency, issuedAt });
}

export async function createSubscription(
  ctx: AppContext,
  input: {
    tenant: Tenant;
    pkg: Package;
    interval: Interval;
    billing: BillingContact;
    locale: string;
    trialDays?: number;
    customPriceCents?: number | null;
    discountPercent?: number;
    notes?: string;
  },
) {
  const now = new Date();
  const trialDays = input.trialDays ?? input.pkg.trialDays;
  const trialEnd = trialDays > 0 ? addDays(now, trialDays) : null;
  const [sub] = (await ctx.db
    .insert(schema.subscriptions)
    .values({
      tenantId: input.tenant.id,
      packageId: input.pkg.id,
      interval: input.interval,
      status: trialEnd ? 'trialing' : 'active',
      trialEndsAt: trialEnd,
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd ?? addInterval(now, input.interval),
      customPriceCents: input.customPriceCents ?? null,
      discountPercent: input.discountPercent ?? 0,
      billing: input.billing,
      locale: emailLocale(input.locale),
      notes: input.notes ?? '',
    })
    .returning()) as [Subscription];
  await applyPackageToTenant(ctx, input.tenant.id, input.pkg, false);
  await emitSub(ctx, 'subscription.created', sub.id);
  if (!trialEnd) await invoicePeriod(ctx, sub.id);
  return sub;
}

/**
 * Starts the next period: a pending package change takes effect, a trial becomes paid, and the period is invoiced.
 * Periods follow on from the previous one; `restart` begins one now instead (after a suspension, the frozen time is not billed).
 */
async function renew(ctx: AppContext, subId: string, now: Date, restart = false) {
  const { sub, pkg } = await load(ctx, subId);
  let nextPkg = pkg;
  const set: Partial<typeof schema.subscriptions.$inferInsert> = { pendingPackageId: null, pendingInterval: null, updatedAt: now };
  if (sub.pendingPackageId && sub.pendingPackageId !== pkg.id) {
    const [p] = await ctx.db.select().from(schema.packages).where(eq(schema.packages.id, sub.pendingPackageId));
    if (p) {
      nextPkg = p;
      set.packageId = p.id;
      set.customPriceCents = null;
    }
  }
  const interval = sub.pendingInterval ?? sub.interval;
  const start = restart ? now : sub.currentPeriodEnd;
  Object.assign(set, {
    interval,
    currentPeriodStart: start,
    currentPeriodEnd: addInterval(start, interval),
    status: sub.status === 'trialing' ? 'active' : sub.status,
  });
  await ctx.db.update(schema.subscriptions).set(set).where(eq(schema.subscriptions.id, sub.id));
  if (nextPkg.id !== pkg.id) await applyPackageToTenant(ctx, sub.tenantId, nextPkg, sub.customLimits);
  await invoicePeriod(ctx, sub.id, now);
  await emitSub(ctx, 'subscription.updated', sub.id);
}

/**
 * Moves a subscription to another package. Upgrades (a higher monthly price) take effect now, with an invoice for the
 * difference over the rest of the period; downgrades and another interval wait for the end of the period, so nobody pays
 * twice. Administrators can force `when: 'now'` with or without the prorated invoice.
 */
export async function changePackage(
  ctx: AppContext,
  subId: string,
  target: Package,
  opts: { interval?: Interval; when?: 'auto' | 'now' | 'period_end'; prorate?: boolean } = {},
) {
  const { sub, pkg, tenant } = await load(ctx, subId);
  if (sub.status === 'cancelled') throw badRequest('This subscription has ended; start a new one');
  const interval = opts.interval ?? sub.interval;
  const problems = await usageProblems(ctx, tenant.id, target);
  if (problems.length) throw badRequest(problems.join('. '));
  const oldMonthly = monthlyValue(sub, pkg);
  const newMonthly = monthlyValue({ ...sub, customPriceCents: null, interval }, target);
  const upgrade = newMonthly > oldMonthly || sub.status === 'trialing';
  const when = opts.when && opts.when !== 'auto' ? opts.when : upgrade ? 'now' : 'period_end';
  const now = new Date();

  if (when === 'period_end') {
    await ctx.db
      .update(schema.subscriptions)
      .set({ pendingPackageId: target.id === pkg.id ? null : target.id, pendingInterval: interval === sub.interval ? null : interval, updatedAt: now })
      .where(eq(schema.subscriptions.id, sub.id));
    await emitSub(ctx, 'subscription.updated', sub.id);
    return { applied: 'period_end' as const, invoice: null };
  }

  await ctx.db
    .update(schema.subscriptions)
    .set({
      packageId: target.id,
      customPriceCents: null,
      pendingPackageId: null,
      // An interval change on an upgrade still waits for the next period.
      pendingInterval: interval === sub.interval ? null : interval,
      updatedAt: now,
    })
    .where(eq(schema.subscriptions.id, sub.id));
  await applyPackageToTenant(ctx, tenant.id, target, sub.customLimits);

  let invoice: Invoice | null = null;
  const settings = await getSetting(ctx, 'billing');
  if (settings.enabled && sub.status !== 'trialing' && (opts.prorate ?? true)) {
    const total = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
    const left = Math.max(0, sub.currentPeriodEnd.getTime() - Math.max(now.getTime(), sub.currentPeriodStart.getTime()));
    const fraction = total > 0 ? Math.min(1, left / total) : 0;
    const discount = 1 - sub.discountPercent / 100;
    const diff = Math.round((basePrice({ customPriceCents: null }, target, sub.interval) - basePrice(sub, pkg, sub.interval)) * discount * fraction);
    if (diff > 0) {
      const l = emailLocale(sub.locale);
      const range = `${formatDate(now, l)} – ${formatDate(new Date(sub.currentPeriodEnd.getTime() - 86400_000), l)}`;
      const text = l === 'nl' ? `Upgrade van ${pkg.name} naar ${target.name}, resterende periode ${range}` : `Upgrade from ${pkg.name} to ${target.name}, remaining period ${range}`;
      invoice = await createInvoice(ctx, {
        tenant,
        subscriptionId: sub.id,
        billing: sub.billing,
        locale: sub.locale,
        lines: [line(text, 1, diff)],
        periodStart: now,
        periodEnd: sub.currentPeriodEnd,
        currency: target.currency,
      });
    }
  }
  await emitSub(ctx, 'subscription.updated', sub.id);
  return { applied: 'now' as const, invoice };
}

export async function cancelSubscription(ctx: AppContext, subId: string, immediate: boolean) {
  const { sub } = await load(ctx, subId);
  if (sub.status === 'cancelled') return;
  const now = new Date();
  if (!immediate && sub.status !== 'suspended') {
    await ctx.db.update(schema.subscriptions).set({ cancelAtPeriodEnd: true, updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
    await emitSub(ctx, 'subscription.updated', sub.id);
    return;
  }
  await endSubscription(ctx, sub.id, now);
}

async function endSubscription(ctx: AppContext, subId: string, now: Date) {
  const [sub] = (await ctx.db
    .update(schema.subscriptions)
    .set({ status: 'cancelled', cancelledAt: now, cancelAtPeriodEnd: false, pendingPackageId: null, pendingInterval: null, updatedAt: now })
    .where(eq(schema.subscriptions.id, subId))
    .returning()) as [Subscription];
  await ctx.db.update(schema.tenants).set({ active: false }).where(eq(schema.tenants.id, sub.tenantId));
  await applyStreams(ctx, { by: 'billing' }).catch(() => undefined);
  await emitSub(ctx, 'subscription.cancelled', sub.id);
}

/** Undoes "cancel at the end of the period", or starts an ended subscription again with a new period. */
export async function resumeSubscription(ctx: AppContext, subId: string) {
  const { sub } = await load(ctx, subId);
  const now = new Date();
  if (sub.status === 'cancelled') {
    await ctx.db
      .update(schema.subscriptions)
      .set({ status: 'active', cancelledAt: null, trialEndsAt: null, currentPeriodStart: now, currentPeriodEnd: addInterval(now, sub.interval), updatedAt: now })
      .where(eq(schema.subscriptions.id, sub.id));
    await ctx.db.update(schema.tenants).set({ active: true }).where(eq(schema.tenants.id, sub.tenantId));
    await applyStreams(ctx, { by: 'billing' }).catch(() => undefined);
    await invoicePeriod(ctx, sub.id);
    await emitSub(ctx, 'subscription.resumed', sub.id);
    return;
  }
  if (sub.cancelAtPeriodEnd) {
    await ctx.db.update(schema.subscriptions).set({ cancelAtPeriodEnd: false, updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
    await emitSub(ctx, 'subscription.updated', sub.id);
  }
}

export async function suspendSubscription(ctx: AppContext, subId: string, invoice?: Invoice) {
  const { sub } = await load(ctx, subId);
  if (sub.status === 'suspended' || sub.status === 'cancelled') return;
  const now = new Date();
  await ctx.db.update(schema.subscriptions).set({ status: 'suspended', suspendedAt: now, updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
  await ctx.db.update(schema.tenants).set({ active: false }).where(eq(schema.tenants.id, sub.tenantId));
  await applyStreams(ctx, { by: 'billing' }).catch(() => undefined);
  await emitSub(ctx, 'subscription.suspended', sub.id, invoice ? { invoice: invoiceRef(invoice) } : {});
  if (invoice) await mailAbout(ctx, 'suspended', invoice);
}

/** Lifts a suspension by hand (for example after a payment arrangement), even with invoices still open. */
export async function unsuspendSubscription(ctx: AppContext, subId: string) {
  const { sub } = await load(ctx, subId);
  if (sub.status !== 'suspended') return;
  const now = new Date();
  const overdue = await overdueInvoices(ctx, sub.id, now);
  await ctx.db
    .update(schema.subscriptions)
    .set({ status: overdue.length ? 'past_due' : 'active', suspendedAt: null, updatedAt: now })
    .where(eq(schema.subscriptions.id, sub.id));
  await ctx.db.update(schema.tenants).set({ active: true }).where(eq(schema.tenants.id, sub.tenantId));
  await applyStreams(ctx, { by: 'billing' }).catch(() => undefined);
  if (sub.currentPeriodEnd <= now) await renew(ctx, sub.id, now, true);
  await emitSub(ctx, 'subscription.resumed', sub.id);
}

/**
 * Runs every few minutes: trials that end, periods that renew or end, overdue invoices (status, reminder, suspension).
 * With billing switched off, periods still roll over and cancellations still happen, but no invoices are made and nobody
 * is reminded or suspended.
 */
export async function billingTick(ctx: AppContext, now = new Date()) {
  const settings = await getSetting(ctx, 'billing');
  const due = await ctx.db
    .select()
    .from(schema.subscriptions)
    .where(and(lte(schema.subscriptions.currentPeriodEnd, now), inArray(schema.subscriptions.status, ['trialing', 'active', 'past_due'])))
    .limit(200);
  for (const sub of due) {
    if (sub.cancelAtPeriodEnd) await endSubscription(ctx, sub.id, now);
    else await renew(ctx, sub.id, now);
  }
  if (!settings.enabled) return { renewed: due.length };

  const overdue = await ctx.db
    .select({ inv: schema.invoices, sub: schema.subscriptions })
    .from(schema.invoices)
    .innerJoin(schema.subscriptions, eq(schema.subscriptions.id, schema.invoices.subscriptionId))
    .where(and(eq(schema.invoices.status, 'open'), lte(schema.invoices.dueAt, now)))
    .orderBy(asc(schema.invoices.dueAt));
  const words = (l: string) => emailWords[emailLocale(l)]!;
  for (const { inv, sub } of overdue) {
    if (sub.status === 'active' || sub.status === 'trialing') {
      await ctx.db.update(schema.subscriptions).set({ status: 'past_due', updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
      sub.status = 'past_due';
      const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, sub.tenantId));
      if (tenant) await emitEvent(ctx, 'invoice.overdue', { tenant: tenantRef(tenant), invoice: invoiceRef(inv) });
    }
    const late = (now.getTime() - inv.dueAt.getTime()) / 86400_000;
    if (!inv.remindedAt && late >= settings.reminderAfterDays) {
      await ctx.db.update(schema.invoices).set({ remindedAt: now }).where(eq(schema.invoices.id, inv.id));
      const suspend =
        settings.suspendAfterDays > 0 && settings.suspendAfterDays > late
          ? fill(words(inv.locale).suspendWarning!, { date: formatDate(addDays(inv.dueAt, settings.suspendAfterDays), inv.locale) })
          : '';
      await mailAbout(ctx, 'invoiceReminder', inv, { suspend });
    }
    if (settings.suspendAfterDays > 0 && late >= settings.suspendAfterDays && sub.status === 'past_due') {
      await suspendSubscription(ctx, sub.id, inv);
      sub.status = 'suspended';
    }
  }
  return { renewed: due.length, overdue: overdue.length };
}

/** Monthly recurring revenue and counts for the overview. */
export async function billingOverview(ctx: AppContext) {
  const rows = await ctx.db
    .select({ sub: schema.subscriptions, pkg: schema.packages })
    .from(schema.subscriptions)
    .innerJoin(schema.packages, eq(schema.packages.id, schema.subscriptions.packageId));
  const counts = { trialing: 0, active: 0, past_due: 0, suspended: 0, cancelled: 0 };
  let mrr = 0;
  for (const { sub, pkg } of rows) {
    counts[sub.status]++;
    if (sub.status === 'active' || sub.status === 'past_due') mrr += monthlyValue(sub, pkg);
  }
  const [open] = await ctx.db
    .select({ n: count(), total: sql<string>`coalesce(sum(${schema.invoices.totalCents}), 0)`, overdue: sql<string>`coalesce(sum(${schema.invoices.totalCents}) filter (where ${schema.invoices.dueAt} < now()), 0)` })
    .from(schema.invoices)
    .where(eq(schema.invoices.status, 'open'));
  const [paid30] = await ctx.db
    .select({ total: sql<string>`coalesce(sum(${schema.invoices.totalCents}), 0)` })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.status, 'paid'), sql`${schema.invoices.paidAt} > now() - interval '30 days'`));
  return {
    mrrCents: mrr,
    arrCents: mrr * 12,
    subscriptions: counts,
    openInvoices: open?.n ?? 0,
    openCents: Number(open?.total ?? 0),
    overdueCents: Number(open?.overdue ?? 0),
    paidLast30Cents: Number(paid30?.total ?? 0),
  };
}
