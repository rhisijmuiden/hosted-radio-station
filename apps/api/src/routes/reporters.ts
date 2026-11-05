import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { HttpError, notFound } from '../lib/errors.js';
import { idParam, okOut } from '../lib/schemas.js';
import { activeInvite, cleanCode, livekitToken, newInvite, nodeReporterSecret, reporterNode, roomOf, STUDIO_IDENTITY } from '../services/reporters.js';
import { stationAccess } from './stations.js';

const inviteOut = z.object({ code: z.string(), expiresAt: z.date(), joinUrl: z.string(), uses: z.number().int() }).nullable();
const joinUrl = (base: string, code: string) => `${base.replace(/\/$/, '')}/reporter?code=${code}`;

/**
 * Reporter mode for RHIS Studio (step 1): the reporter server of a station, the studio's own access to its room, and
 * the invitation code reporters join with. Registered under /api/studio.
 */
export const reporterStudioRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const toInvite = (i: Awaited<ReturnType<typeof activeInvite>>) => (i ? { code: i.code, expiresAt: i.expiresAt, joinUrl: joinUrl(ctx.config.PUBLIC_URL, i.code), uses: i.uses } : null);

  app.get(
    '/stations/:id/reporters',
    {
      schema: {
        tags: ['Studio client'],
        summary:
          "Reporter mode: where the station's reporters join (a LiveKit server on an ingest node), a token for RHIS Studio to join the same room as \"studio\", and the invitation code while it is valid. DJs and managers of the station.",
        params: idParam,
        response: {
          200: z.object({
            available: z.boolean(),
            /** none = no ingest node with reporter mode for this station; offline / starting = its server is not up. */
            reason: z.enum(['none', 'offline', 'starting']).nullable(),
            server: z.object({ url: z.string(), node: z.string() }).nullable(),
            room: z.string(),
            identity: z.string(),
            token: z.string().nullable(),
            invite: inviteOut,
          }),
        },
      },
    },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      const [where, invite] = await Promise.all([reporterNode(ctx, station), activeInvite(ctx, station.id)]);
      const room = roomOf(station.id);
      if (!where.node) return { available: false, reason: where.reason, server: null, room, identity: STUDIO_IDENTITY, token: null, invite: toInvite(invite) };
      const token = livekitToken(nodeReporterSecret(ctx, where.node), {
        identity: STUDIO_IDENTITY,
        name: station.name,
        grant: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, roomAdmin: true },
        metadata: JSON.stringify({ role: 'studio', user: access.user.name }),
      });
      return { available: true, reason: null, server: { url: where.url, node: where.node.name }, room, identity: STUDIO_IDENTITY, token, invite: toInvite(invite) };
    },
  );

  app.post(
    '/stations/:id/reporters/invite',
    {
      config: { audit: 'reporters.invite', rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Studio client'],
        summary: 'A new invitation code for reporters (six digits, valid 30 minutes, for any number of phones). The previous code stops working.',
        params: idParam,
        response: { 200: inviteOut.unwrap() },
      },
    },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      const invite = await newInvite(ctx, station.id, access.user.id);
      Object.assign(req.auditInfo, { targetType: 'station', targetId: station.id });
      return toInvite(invite)!;
    },
  );

  app.delete(
    '/stations/:id/reporters/invite',
    {
      config: { audit: 'reporters.invite_end' },
      schema: { tags: ['Studio client'], summary: 'End the invitation code: no new phones can join (phones already in stay).', params: idParam, response: { 200: okOut } },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'dj');
      await ctx.db.delete(schema.reporterInvites).where(eq(schema.reporterInvites.stationId, station.id));
      Object.assign(req.auditInfo, { targetType: 'station', targetId: station.id });
      return { ok: true as const };
    },
  );
};

/** The phone side of reporter mode: join a station's room with the code. Registered under /api/public. */
export const reporterPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  app.post(
    '/reporters/join',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public'],
        summary: 'A reporter on location joins a broadcast with the code the DJ gave: the reporter server to connect to and an access token for the phone.',
        security: [],
        body: z.object({ code: z.string().trim().max(20), name: z.string().trim().min(1).max(60), place: z.string().trim().max(60).default('') }),
        response: {
          200: z.object({ url: z.string(), token: z.string(), identity: z.string(), station: z.object({ name: z.string() }), expiresAt: z.date() }),
        },
      },
    },
    async (req) => {
      const code = cleanCode(req.body.code);
      const [invite] = code.length === 6 ? await ctx.db.select().from(schema.reporterInvites).where(eq(schema.reporterInvites.code, code)) : [];
      if (!invite || invite.expiresAt < new Date()) throw new HttpError(404, 'invalid_code', 'This code is not valid (any more). Ask the DJ for a new one.');
      const [station] = await ctx.db.select().from(schema.stations).where(eq(schema.stations.id, invite.stationId));
      if (!station) throw notFound('Station');
      const where = await reporterNode(ctx, station);
      if (!where.node) throw new HttpError(503, 'no_server', 'The station cannot take reporters right now. Try again in a moment.');
      await ctx.db.update(schema.reporterInvites).set({ uses: sql`${schema.reporterInvites.uses} + 1` }).where(eq(schema.reporterInvites.id, invite.id));
      const identity = `rep-${randomBytes(6).toString('hex')}`;
      const ttlSeconds = 6 * 3600;
      const token = livekitToken(nodeReporterSecret(ctx, where.node), {
        identity,
        name: req.body.name,
        grant: { room: roomOf(station.id), roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: ['microphone'] },
        metadata: JSON.stringify({ role: 'reporter', place: req.body.place }),
        ttlSeconds,
      });
      return { url: where.url, token, identity, station: { name: station.name }, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
    },
  );
};
