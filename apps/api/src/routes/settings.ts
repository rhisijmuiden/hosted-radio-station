import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireSuperadmin } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { emailSchema } from '../lib/schemas.js';
import { createTransport, sendMail } from '../services/mail.js';
import {
  auditSettingsSchema,
  backupSettingsSchema,
  getMaskedSetting,
  getSetting,
  proxySchema,
  putSetting,
  SECRET_MASK,
  smtpSchema,
  streamingSchema,
  type StreamingSettings,
} from '../services/settings.js';
import { applyAllStreams } from '../services/streaming/state.js';
import { readStreamsStatus, streamsStatusOut } from '../services/streaming/status.js';
import { getProxyStatus, requestProxyApply } from '../services/system.js';
import { jobOut } from './system.js';

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  // Outgoing mail

  app.get(
    '/smtp',
    { schema: { tags: ['Settings'], summary: 'Outgoing mail server (secrets masked)', response: { 200: smtpSchema } } },
    async (req) => {
      requireSuperadmin(req);
      return getMaskedSetting(ctx, 'smtp');
    },
  );

  app.put(
    '/smtp',
    {
      config: { audit: 'settings.smtp' },
      schema: {
        tags: ['Settings'],
        summary: `Save the outgoing mail server. Send "${SECRET_MASK}" to keep a stored secret.`,
        body: smtpSchema,
        response: { 200: smtpSchema },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      await putSetting(ctx, 'smtp', req.body);
      return getMaskedSetting(ctx, 'smtp');
    },
  );

  app.post(
    '/smtp/test',
    {
      config: { audit: 'settings.smtp_test', rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Settings'],
        summary: 'Verify the connection and send a test e-mail. Pass `smtp` to test unsaved settings.',
        body: z.object({ to: emailSchema, smtp: smtpSchema.optional() }),
        response: { 200: z.object({ ok: z.literal(true), messageId: z.string(), response: z.string() }) },
      },
    },
    async (req) => {
      const auth = requireSuperadmin(req);
      let smtp = await getSetting(ctx, 'smtp');
      if (req.body.smtp) {
        const draft = req.body.smtp;
        smtp = {
          ...draft,
          password: draft.password === SECRET_MASK ? smtp.password : draft.password,
          dkim: { ...draft.dkim, privateKey: draft.dkim.privateKey === SECRET_MASK ? smtp.dkim.privateKey : draft.dkim.privateKey },
        };
      }
      try {
        await createTransport(smtp).verify();
        const result = await sendMail(
          ctx,
          {
            to: req.body.to,
            subject: 'Test e-mail from Hosted Radio Station',
            title: 'Your mail server works',
            paragraphs: [
              `This test e-mail was sent by ${auth.user.name} from the Hosted Radio Station admin panel.`,
              `Server: ${smtp.host}:${smtp.port} (${smtp.security.toUpperCase()}${smtp.dkim.enabled ? ', DKIM signed' : ''}).`,
            ],
            action: { label: 'Open the admin panel', url: ctx.config.PUBLIC_URL },
          },
          smtp,
        );
        return { ok: true as const, ...result };
      } catch (err) {
        throw badRequest(`Sending failed: ${(err as Error).message}`);
      }
    },
  );

  // Web server / reverse proxy

  app.get(
    '/proxy',
    { schema: { tags: ['Settings'], summary: 'Web server mode: built-in HTTPS or behind an external reverse proxy', response: { 200: proxySchema } } },
    async (req) => {
      requireSuperadmin(req);
      return getSetting(ctx, 'proxy');
    },
  );

  app.put(
    '/proxy',
    {
      config: { audit: 'settings.proxy' },
      schema: {
        tags: ['Settings'],
        summary: 'Save the web server mode. Use POST /settings/proxy/apply to activate it.',
        body: proxySchema,
        response: { 200: proxySchema },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      if (req.body.mode === 'builtin' && req.body.domain && !req.body.acmeEmail) {
        throw badRequest('An e-mail address for Let\'s Encrypt is required with a domain');
      }
      if (req.body.mode === 'external' && req.body.trustedProxies.length === 0) {
        throw badRequest('Add the IP address of your reverse proxy');
      }
      await putSetting(ctx, 'proxy', req.body);
      return getSetting(ctx, 'proxy');
    },
  );

  app.post(
    '/proxy/apply',
    {
      config: { audit: 'settings.proxy_apply' },
      schema: {
        tags: ['Settings'],
        summary: 'Rewrite the Caddy configuration from the saved settings and reload it',
        response: { 202: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const auth = requireSuperadmin(req);
      const id = await requestProxyApply(ctx, await getSetting(ctx, 'proxy'), auth.user.email);
      reply.status(202);
      return { id };
    },
  );

  app.get(
    '/proxy/status',
    { schema: { tags: ['Settings'], summary: 'Status of the last web server change', response: { 200: jobOut } } },
    async (req) => {
      requireSuperadmin(req);
      return getProxyStatus(ctx);
    },
  );

  // Backups and audit log

  app.get(
    '/backup',
    { schema: { tags: ['Settings'], summary: 'Backup notifications and the Microsoft app for OneDrive', response: { 200: backupSettingsSchema } } },
    async (req) => {
      requireSuperadmin(req);
      return getSetting(ctx, 'backup');
    },
  );

  app.put(
    '/backup',
    {
      config: { audit: 'settings.backup' },
      schema: { tags: ['Settings'], summary: 'Save backup notifications and the Microsoft app for OneDrive', body: backupSettingsSchema, response: { 200: backupSettingsSchema } },
    },
    async (req) => {
      requireSuperadmin(req);
      await putSetting(ctx, 'backup', req.body);
      return getSetting(ctx, 'backup');
    },
  );

  app.get(
    '/audit',
    { schema: { tags: ['Settings'], summary: 'How long the audit log is kept', response: { 200: auditSettingsSchema } } },
    async (req) => {
      requireSuperadmin(req);
      return getSetting(ctx, 'audit');
    },
  );

  app.put(
    '/audit',
    {
      config: { audit: 'settings.audit' },
      schema: { tags: ['Settings'], summary: 'Change how long the audit log is kept', body: auditSettingsSchema, response: { 200: auditSettingsSchema } },
    },
    async (req) => {
      requireSuperadmin(req);
      await putSetting(ctx, 'audit', req.body);
      req.auditInfo.details = { retentionDays: req.body.retentionDays };
      return getSetting(ctx, 'audit');
    },
  );

  // Streaming: encoder ingest, port ranges, file upload

  app.get(
    '/streaming',
    { schema: { tags: ['Settings'], summary: 'Encoder ports, port ranges, DNS target for customer domains and SFTP/FTP upload', response: { 200: streamingSchema } } },
    async (req) => {
      requireSuperadmin(req);
      return getSetting(ctx, 'streaming');
    },
  );

  app.put(
    '/streaming',
    {
      config: { audit: 'settings.streaming' },
      schema: { tags: ['Settings'], summary: 'Save the streaming settings and apply them', body: streamingSchema, response: { 200: streamingSchema } },
    },
    async (req) => {
      const auth = requireSuperadmin(req);
      checkPorts(req.body, ctx.config.PORT);
      await putSetting(ctx, 'streaming', req.body);
      await applyAllStreams(ctx, auth.user.email);
      return getSetting(ctx, 'streaming');
    },
  );

  app.get(
    '/streaming/status',
    { schema: { tags: ['Settings'], summary: 'State of the streams service (ingest gateway, relays) and the last system change', response: { 200: streamsStatusOut } } },
    async (req) => {
      requireSuperadmin(req);
      return readStreamsStatus(ctx);
    },
  );
};

/** Single ports must differ from each other and stay out of the port ranges; ranges must not overlap. */
function checkPorts(s: StreamingSettings, apiPort: number) {
  const singles: [string, number][] = [
    ['TLS ingest', s.ingestTlsPort],
    ...(s.ingestPlainPort ? ([['Plain ingest', s.ingestPlainPort]] as [string, number][]) : []),
    ...(s.sftp.enabled ? ([['SFTP', s.sftp.port]] as [string, number][]) : []),
    ...(s.ftp.enabled ? ([['FTP', s.ftp.port]] as [string, number][]) : []),
  ];
  const reserved: [string, number][] = [['the web server', 80], ['the web server', 443], ['the API', apiPort]];
  const ranges: [string, number, number][] = [
    ['Icecast', s.icecastPortFrom, s.icecastPortTo],
    ['Legacy Shoutcast', s.legacyPortFrom, s.legacyPortTo],
    ...(s.ftp.enabled ? ([['FTP passive', s.ftp.passivePortFrom, s.ftp.passivePortTo]] as [string, number, number][]) : []),
  ];
  for (const [i, [a, p]] of singles.entries()) {
    for (const [b, q] of [...singles.slice(i + 1), ...reserved]) if (p === q) throw badRequest(`${a} and ${b} cannot share port ${p}`);
    for (const [b, from, to] of ranges) if (p >= from && p <= to) throw badRequest(`${a} port ${p} lies inside the ${b} range`);
  }
  for (const [i, [a, f1, t1]] of ranges.entries()) {
    for (const [b, f2, t2] of ranges.slice(i + 1)) if (f1 <= t2 && f2 <= t1) throw badRequest(`The ${a} and ${b} ranges overlap`);
    for (const [b, q] of reserved) if (q >= f1 && q <= t1) throw badRequest(`The ${a} range contains the port of ${b}`);
  }
}
