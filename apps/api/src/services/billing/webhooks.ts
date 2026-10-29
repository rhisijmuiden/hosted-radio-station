import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';

export const WEBHOOK_EVENTS = [
  'customer.created',
  'subscription.created',
  'subscription.updated',
  'subscription.cancelled',
  'subscription.suspended',
  'subscription.resumed',
  'invoice.created',
  'invoice.paid',
  'invoice.overdue',
  'alert.opened',
  'alert.resolved',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | 'webhook.test';

/** Waits before attempt 2, 3, ...; after the last one the delivery is given up. */
const RETRY_MINUTES = [1, 5, 30, 120, 360, 1440];

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, like Stripe, so receivers can reject old or forged calls. */
export function signPayload(secret: string, body: string, at = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return `t=${at},v1=${v1}`;
}

/** Queues an event for every active webhook that listens to it, and tries to deliver it right away. */
export async function emitEvent(ctx: AppContext, event: WebhookEvent, data: Record<string, unknown>, onlyWebhookId?: string) {
  const hooks = await ctx.db.select().from(schema.webhooks).where(eq(schema.webhooks.active, true));
  const targets = hooks.filter((h) => (onlyWebhookId ? h.id === onlyWebhookId : h.events.includes('*') || h.events.includes(event)));
  if (!targets.length) return Object.assign([] as (typeof schema.webhookDeliveries.$inferSelect)[], { sent: Promise.resolve(undefined) });
  const createdAt = new Date().toISOString();
  const rows = await ctx.db
    .insert(schema.webhookDeliveries)
    .values(targets.map((h) => ({ webhookId: h.id, event, payload: { id: randomUUID(), event, createdAt, data } })))
    .returning();
  const sent = deliverDue(ctx, rows.map((r) => r.id)).catch(() => undefined);
  return Object.assign(rows, { sent });
}

async function deliverOne(ctx: AppContext, delivery: typeof schema.webhookDeliveries.$inferSelect, hook: typeof schema.webhooks.$inferSelect) {
  const body = JSON.stringify(delivery.payload);
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'HostedRadioStation-Webhooks/1',
        'x-hrs-event': delivery.event,
        'x-hrs-delivery': delivery.id,
        'x-hrs-signature': signPayload(ctx.box.decrypt(hook.secret), body),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message.slice(0, 300);
  }
  const attempts = delivery.attempts + 1;
  if (!error) {
    await ctx.db
      .update(schema.webhookDeliveries)
      .set({ state: 'delivered', attempts, responseStatus: status, error: null, deliveredAt: new Date() })
      .where(eq(schema.webhookDeliveries.id, delivery.id));
    return true;
  }
  const wait = RETRY_MINUTES[attempts - 1];
  await ctx.db
    .update(schema.webhookDeliveries)
    .set({
      state: wait === undefined ? 'failed' : 'pending',
      attempts,
      responseStatus: status,
      error,
      nextAttemptAt: new Date(Date.now() + (wait ?? 0) * 60_000),
    })
    .where(eq(schema.webhookDeliveries.id, delivery.id));
  return false;
}

/** Delivers the given deliveries, or every pending one that is due. Each row is claimed first, so it goes out once. */
export async function deliverDue(ctx: AppContext, ids?: string[]) {
  const due = ids
    ? and(eq(schema.webhookDeliveries.state, 'pending'), inArray(schema.webhookDeliveries.id, ids))
    : and(eq(schema.webhookDeliveries.state, 'pending'), lte(schema.webhookDeliveries.nextAttemptAt, new Date()));
  const pick = ctx.db.select({ id: schema.webhookDeliveries.id }).from(schema.webhookDeliveries).where(due).limit(100);
  const claimed = await ctx.db
    .update(schema.webhookDeliveries)
    .set({ state: 'sending', nextAttemptAt: new Date() })
    .where(and(eq(schema.webhookDeliveries.state, 'pending'), inArray(schema.webhookDeliveries.id, pick)))
    .returning();
  if (!claimed.length) return { attempted: 0, delivered: 0 };
  const hooks = await ctx.db
    .select()
    .from(schema.webhooks)
    .where(inArray(schema.webhooks.id, [...new Set(claimed.map((d) => d.webhookId))]));
  const byId = new Map(hooks.map((h) => [h.id, h]));
  let ok = 0;
  for (const d of claimed) {
    const hook = byId.get(d.webhookId);
    if (!hook) continue;
    if (await deliverOne(ctx, d, hook)) ok++;
  }
  return { attempted: claimed.length, delivered: ok };
}

/** Puts deliveries that were being sent when the server stopped back in the queue. */
export async function requeueStuck(ctx: AppContext) {
  await ctx.db
    .update(schema.webhookDeliveries)
    .set({ state: 'pending' })
    .where(and(eq(schema.webhookDeliveries.state, 'sending'), lte(schema.webhookDeliveries.nextAttemptAt, new Date(Date.now() - 10 * 60_000))));
}

/** Removes delivered and failed deliveries older than 30 days. */
export async function pruneDeliveries(ctx: AppContext) {
  await ctx.db.delete(schema.webhookDeliveries).where(
    and(sql`${schema.webhookDeliveries.state} <> 'pending'`, lte(schema.webhookDeliveries.createdAt, new Date(Date.now() - 30 * 86400_000))),
  );
}
