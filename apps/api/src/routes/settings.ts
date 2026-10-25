import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireSuperadmin } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { emailSchema } from '../lib/schemas.js';
import { createTransport, sendMail } from '../services/mail.js';
import { getMaskedSetting, getSetting, proxySchema, putSetting, SECRET_MASK, smtpSchema } from '../services/settings.js';
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
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
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
};
