import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { requireSuperadmin } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { idParam } from '../lib/schemas.js';
import { deliver, telegramChats } from '../services/alerts/notify.js';
import { inMaintenance } from '../services/alerts/rules.js';
import { mailConfigured } from '../services/mail.js';
import { ALERT_KINDS, alertSettingsSchema, getMaskedSetting, getSetting, maintenanceSchema, putSetting, SECRET_MASK } from '../services/settings.js';

const alertOut = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.enum(ALERT_KINDS),
  severity: z.enum(['critical', 'warning']),
  nodeId: z.string().nullable(),
  stationId: z.string().nullable(),
  params: z.record(z.string(), z.string()),
  message: z.string().nullable(),
  openedAt: z.date(),
  lastSeenAt: z.date(),
  resolvedAt: z.date().nullable(),
  notified: z.boolean(),
  acknowledgedAt: z.date().nullable(),
  acknowledgedBy: z.string().nullable(),
});

const deliveryOut = z.object({ channel: z.enum(['email', 'telegram']), ok: z.boolean(), error: z.string().nullable(), at: z.string().optional() });

const settingsOut = alertSettingsSchema.extend({
  /** Outgoing mail is set up, so e-mail alerts can go out. */
  mailReady: z.boolean(),
  lastDelivery: z.array(deliveryOut),
});

/**
 * Monitoring (phase 20): the open alerts and their history, acknowledging them, maintenance, and where alerts go
 * (e-mail, Telegram; webhooks get alert.opened and alert.resolved through Settings → Webhooks). Administrators only.
 */
export const alertRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const monitor = () => {
    if (!app.alerts) throw badRequest('Monitoring runs on the main server');
    return app.alerts;
  };
  const settingsView = async () => ({ ...(await getMaskedSetting(ctx, 'alerts')), mailReady: await mailConfigured(ctx), lastDelivery: monitor().lastDelivery });

  app.get(
    '/',
    {
      schema: {
        tags: ['Monitoring'],
        summary: 'Alerts, newest first: the open ones, the solved ones (kept 90 days) or both',
        querystring: z.object({ state: z.enum(['open', 'resolved', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: { 200: z.array(alertOut) },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      return (await monitor().list(req.query.state, req.query.limit)) as z.infer<typeof alertOut>[];
    },
  );

  app.get(
    '/summary',
    { schema: { tags: ['Monitoring'], summary: 'How many alerts are open, for the menu', response: { 200: z.object({ open: z.number(), critical: z.number(), unacknowledged: z.number() }) } } },
    async (req) => {
      requireSuperadmin(req);
      const open = await monitor().list('open', 500);
      return { open: open.length, critical: open.filter((a) => a.severity === 'critical').length, unacknowledged: open.filter((a) => !a.acknowledgedAt).length };
    },
  );

  app.post(
    '/:id/acknowledge',
    { config: { audit: 'alerts.acknowledge' }, schema: { tags: ['Monitoring'], summary: 'Mark an open alert as seen: someone is on it', params: idParam, response: { 200: alertOut } } },
    async (req) => {
      const auth = requireSuperadmin(req);
      const [row] = await ctx.db.update(schema.alerts).set({ acknowledgedAt: new Date(), acknowledgedBy: auth.user.email }).where(eq(schema.alerts.id, req.params.id)).returning();
      if (!row) throw notFound('Alert not found');
      req.auditInfo.details = { kind: row.kind, ...row.params };
      return row as z.infer<typeof alertOut>;
    },
  );

  app.get('/settings', { schema: { tags: ['Monitoring'], summary: 'Where alerts go and when (Telegram token masked)', response: { 200: settingsOut } } }, async (req) => {
    requireSuperadmin(req);
    return settingsView();
  });

  app.put(
    '/settings',
    {
      config: { audit: 'settings.alerts' },
      schema: { tags: ['Monitoring'], summary: `Save the monitoring settings. Send "${SECRET_MASK}" to keep the stored Telegram token.`, body: alertSettingsSchema, response: { 200: settingsOut } },
    },
    async (req) => {
      requireSuperadmin(req);
      await putSetting(ctx, 'alerts', req.body);
      req.auditInfo.details = { email: req.body.email.enabled, telegram: req.body.telegram.enabled, minSeverity: req.body.minSeverity, graceSeconds: req.body.graceSeconds, recoverSeconds: req.body.recoverSeconds };
      return settingsView();
    },
  );

  app.post(
    '/test',
    {
      config: { audit: 'alerts.test', rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['Monitoring'], summary: 'Send a test message to every channel that is on, with the saved settings', response: { 200: z.array(deliveryOut) } },
    },
    async (req) => {
      requireSuperadmin(req);
      const settings = await getSetting(ctx, 'alerts');
      const results = await deliver(ctx, settings, [], [], { test: true });
      if (!results.length) throw badRequest('Switch on e-mail or Telegram first, and save.');
      monitor().record(results);
      return results;
    },
  );

  app.post(
    '/telegram/chats',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Monitoring'],
        summary: 'The chats that wrote to the bot lately. Without a token in the body the stored one is used.',
        body: z.object({ botToken: z.string().trim().max(200).optional() }).optional(),
        response: { 200: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })) },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const given = req.body?.botToken;
      const token = given && given !== SECRET_MASK ? given : (await getSetting(ctx, 'alerts')).telegram.botToken;
      if (!token) throw badRequest('Fill in the bot token first');
      return telegramChats(token);
    },
  );

  app.post(
    '/maintenance',
    {
      config: { audit: 'alerts.maintenance' },
      schema: {
        tags: ['Monitoring'],
        summary: 'Put a node or station in maintenance: no alerts for it for a number of minutes, or until it is taken off (minutes null)',
        body: z.object({ kind: z.enum(['node', 'station']), id: z.uuid(), minutes: z.number().int().min(1).max(60 * 24 * 90).nullable(), note: z.string().trim().max(200).default('') }),
        response: { 200: z.array(maintenanceSchema) },
      },
    },
    async (req) => {
      const auth = requireSuperadmin(req);
      const { kind, id, minutes, note } = req.body;
      const table = kind === 'node' ? schema.nodes : schema.stations;
      const [found] = await ctx.db.select({ name: table.name }).from(table).where(eq(table.id, id));
      if (!found) throw notFound(kind === 'node' ? 'Node not found' : 'Station not found');
      const s = await getSetting(ctx, 'alerts');
      const now = Date.now();
      const until = minutes === null ? null : new Date(now + minutes * 60_000).toISOString();
      // Ended entries are cleaned up on the way.
      s.maintenance = [...s.maintenance.filter((m) => !(m.kind === kind && m.id === id) && (!m.until || new Date(m.until).getTime() > now)), { kind, id, until, note, by: auth.user.email }];
      await putSetting(ctx, 'alerts', { ...s, telegram: { ...s.telegram, botToken: SECRET_MASK } });
      req.auditInfo.details = { kind, name: found.name, until };
      return s.maintenance;
    },
  );

  app.delete(
    '/maintenance/:kind/:id',
    {
      config: { audit: 'alerts.maintenance' },
      schema: { tags: ['Monitoring'], summary: 'End the maintenance of a node or station', params: z.object({ kind: z.enum(['node', 'station']), id: z.uuid() }), response: { 200: z.array(maintenanceSchema) } },
    },
    async (req) => {
      requireSuperadmin(req);
      const s = await getSetting(ctx, 'alerts');
      const now = Date.now();
      const active = inMaintenance(s, now);
      s.maintenance = s.maintenance.filter((m) => !(m.kind === req.params.kind && m.id === req.params.id) && (active.nodes.has(m.id) || active.stations.has(m.id)));
      await putSetting(ctx, 'alerts', { ...s, telegram: { ...s.telegram, botToken: SECRET_MASK } });
      req.auditInfo.details = { kind: req.params.kind, ended: true };
      return s.maintenance;
    },
  );
};
