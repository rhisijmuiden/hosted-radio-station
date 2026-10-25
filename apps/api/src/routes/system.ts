import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireSuperadmin, requireUser } from '../lib/auth.js';
import { getSetting, putSetting } from '../services/settings.js';
import { CHANNELS, checkForUpdates, getUpdateStatus, getVersionInfo, requestUpdate, type UpdateCheck } from '../services/system.js';

export const jobOut = z.object({
  id: z.string().nullable(),
  state: z.enum(['idle', 'queued', 'running', 'succeeded', 'failed']),
  channel: z.string().optional(),
  fromCommit: z.string().optional(),
  toCommit: z.string().optional(),
  message: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  log: z.string(),
});

const channelSchema = z.enum(CHANNELS);
const infoOut = z.object({
  name: z.string(),
  version: z.string(),
  commit: z.string().nullable(),
  commitDate: z.string().nullable(),
  branch: z.string().nullable(),
  channel: channelSchema,
  node: z.string(),
  helpers: z.boolean(),
  lastCheck: z
    .object({
      channel: channelSchema,
      currentCommit: z.string().nullable(),
      latestCommit: z.string().nullable(),
      updateAvailable: z.boolean(),
      checkedAt: z.string(),
      error: z.string().nullable(),
    })
    .nullable(),
});

export const systemRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  let lastCheck: UpdateCheck | null = null;

  app.get(
    '/info',
    { schema: { tags: ['System'], summary: 'Version, update channel and the result of the last update check', response: { 200: infoOut } } },
    async (req) => {
      requireUser(req);
      const [info, update] = await Promise.all([getVersionInfo(ctx), getSetting(ctx, 'update')]);
      return { name: 'Hosted Radio Station', ...info, channel: update.channel, lastCheck };
    },
  );

  app.post(
    '/update/check',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['System'],
        summary: 'Check the repository for a newer version on a channel (default: the configured one)',
        body: z.object({ channel: channelSchema.optional() }).default({}),
        response: { 200: infoOut.shape.lastCheck.unwrap() },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const channel = req.body.channel ?? (await getSetting(ctx, 'update')).channel;
      lastCheck = await checkForUpdates(ctx, channel);
      return lastCheck;
    },
  );

  app.post(
    '/update',
    {
      schema: {
        tags: ['System'],
        summary: 'Install the latest version of a channel. Switching channel (production ↔ test) works the same way.',
        body: z.object({ channel: channelSchema.optional() }).default({}),
        response: { 202: z.object({ id: z.string(), channel: channelSchema }) },
      },
    },
    async (req, reply) => {
      const auth = requireSuperadmin(req);
      const settings = await getSetting(ctx, 'update');
      const channel = req.body.channel ?? settings.channel;
      const id = await requestUpdate(ctx, channel, auth.user.email);
      if (channel !== settings.channel) await putSetting(ctx, 'update', { ...settings, channel });
      reply.status(202);
      return { id, channel };
    },
  );

  app.get(
    '/update/status',
    { schema: { tags: ['System'], summary: 'Progress and log of the running or last update', response: { 200: jobOut } } },
    async (req) => {
      requireSuperadmin(req);
      return getUpdateStatus(ctx);
    },
  );
};
