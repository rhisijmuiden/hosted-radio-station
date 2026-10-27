import { and, desc, eq, isNotNull, lt, or } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { generateApiKey, requireUser } from '../lib/auth.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { idParam, okOut } from '../lib/schemas.js';
import { LIVE_TOKEN_PREFIX } from '../services/streaming/sources.js';
import { studioReleases } from '../services/studio.js';
import { runningVersion } from '../services/system.js';
import { stationAccess } from './stations.js';

const LINK_MINUTES = 10;
const LIVE_TOKEN_HOURS = 12;
/**
 * What this server offers RHIS Studio beyond version 0.9 of the client. The client switches a feature off, and says the
 * server needs an update, when its name is missing here.
 */
export const STUDIO_FEATURES = ['playout', 'rundown', 'queue-rule', 'play-now', 'jingles'] as const;
/** No 0/O, 1/I/L: the code is read from one screen and typed or compared on another. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const newUserCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const showCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
const codeParam = z.object({ code: z.string().trim().toUpperCase().transform((c) => c.replace(/[^A-Z0-9]/g, '')).pipe(z.string().length(8)) });

const linkOut = z.object({
  code: z.string(),
  deviceName: z.string(),
  clientVersion: z.string().nullable(),
  ip: z.string().nullable(),
  state: z.enum(['pending', 'approved', 'denied', 'used', 'expired']),
  createdAt: z.date(),
  expiresAt: z.date(),
});
const releaseOut = z
  .object({ version: z.string(), tag: z.string(), publishedAt: z.string(), notes: z.string(), url: z.string(), installerUrl: z.string().nullable(), sha256: z.string().nullable(), size: z.number().nullable() })
  .nullable();
const deviceOut = z.object({
  id: z.uuid(),
  deviceName: z.string(),
  clientVersion: z.string().nullable(),
  apiKeyId: z.uuid(),
  lastUsedAt: z.date().nullable(),
  createdAt: z.date(),
});

type Link = typeof schema.studioLinks.$inferSelect;
const stateOf = (l: Link) => (l.state === 'pending' && l.expiresAt < new Date() ? 'expired' : (l.state as z.infer<typeof linkOut>['state']));
const toLinkOut = (l: Link) => ({ code: showCode(l.userCode), deviceName: l.deviceName, clientVersion: l.clientVersion, ip: l.ip, state: stateOf(l), createdAt: l.createdAt, expiresAt: l.expiresAt });

/**
 * The Windows studio client (phase 9): linking a PC to an account, encoder passwords for live broadcasts, the client
 * releases for download and update checks, and the linked PCs of the signed-in user.
 */
export const studioRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  // Linking: the client asks, the user approves in the panel, the client polls and gets an API key once.

  app.post(
    '/link',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Studio client'],
        summary: 'Start linking a studio PC. Show `code` to the user and open `verifyUrl`; then poll with `deviceSecret`.',
        security: [],
        body: z.object({ deviceName: z.string().trim().min(1).max(80), clientVersion: z.string().trim().max(40).optional() }),
        response: { 201: z.object({ code: z.string(), deviceSecret: z.string(), verifyUrl: z.string(), expiresAt: z.date(), interval: z.number().int() }) },
      },
    },
    async (req, reply) => {
      // Old requests are not worth keeping.
      await ctx.db.delete(schema.studioLinks).where(or(lt(schema.studioLinks.expiresAt, new Date(Date.now() - 86400_000)), eq(schema.studioLinks.state, 'denied')));
      const deviceSecret = randomToken();
      const expiresAt = new Date(Date.now() + LINK_MINUTES * 60_000);
      for (let attempt = 0; ; attempt++) {
        const userCode = newUserCode();
        const inserted = await ctx.db
          .insert(schema.studioLinks)
          .values({ userCode, deviceSecretHash: sha256(deviceSecret), deviceName: req.body.deviceName, clientVersion: req.body.clientVersion ?? null, ip: req.ip, expiresAt })
          .onConflictDoNothing()
          .returning();
        if (inserted.length) {
          reply.status(201);
          const base = ctx.config.PUBLIC_URL.replace(/\/$/, '');
          return { code: showCode(userCode), deviceSecret, verifyUrl: `${base}/link?code=${showCode(userCode)}`, expiresAt, interval: 3 };
        }
        if (attempt > 5) throw new Error('Could not pick a free link code');
      }
    },
  );

  app.post(
    '/link/poll',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['Studio client'],
        summary: 'Ask whether the user approved the link. The API key is returned once, then the request is closed.',
        security: [],
        body: z.object({ deviceSecret: z.string().min(16).max(200) }),
        response: {
          200: z.object({
            state: z.enum(['pending', 'approved', 'denied', 'expired']),
            apiKey: z.string().optional(),
            user: z.object({ name: z.string(), email: z.string() }).optional(),
          }),
        },
      },
    },
    async (req) => {
      const [link] = await ctx.db.select().from(schema.studioLinks).where(eq(schema.studioLinks.deviceSecretHash, sha256(req.body.deviceSecret)));
      if (!link || link.state === 'used') throw notFound('Link request');
      const state = stateOf(link);
      if (state === 'pending' || state === 'denied' || state === 'expired') return { state };
      const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, link.userId!));
      if (!user?.active) return { state: 'denied' as const };
      const { secret, prefix, hash } = generateApiKey();
      const apiKey = await ctx.db.transaction(async (tx) => {
        // Only one poll may turn the approval into a key.
        const claimed = await tx
          .update(schema.studioLinks)
          .set({ state: 'used' })
          .where(and(eq(schema.studioLinks.id, link.id), eq(schema.studioLinks.state, 'approved')))
          .returning();
        if (!claimed.length) return null;
        const [key] = await tx
          .insert(schema.apiKeys)
          .values({ userId: user.id, name: `Studio: ${link.deviceName}`.slice(0, 80), prefix, hash })
          .returning({ id: schema.apiKeys.id });
        await tx.update(schema.studioLinks).set({ apiKeyId: key!.id }).where(eq(schema.studioLinks.id, link.id));
        return secret;
      });
      if (!apiKey) throw notFound('Link request');
      return { state: 'approved' as const, apiKey, user: { name: user.name, email: user.email } };
    },
  );

  async function pendingLink(code: string) {
    const [link] = await ctx.db.select().from(schema.studioLinks).where(eq(schema.studioLinks.userCode, code));
    if (!link) throw notFound('Link request');
    return link;
  }

  app.get(
    '/link/:code',
    { schema: { tags: ['Studio client'], summary: 'A link request, so the user can check the PC before approving', params: codeParam, response: { 200: linkOut } } },
    async (req) => {
      requireUser(req);
      return toLinkOut(await pendingLink(req.params.code));
    },
  );

  for (const decision of ['approve', 'deny'] as const) {
    app.post(
      `/link/:code/${decision}`,
      {
        config: { audit: `studio.link.${decision}` },
        schema: {
          tags: ['Studio client'],
          summary: decision === 'approve' ? 'Link the studio PC to your account' : 'Refuse the link request',
          params: codeParam,
          response: { 200: linkOut },
        },
      },
      async (req) => {
        const auth = requireUser(req);
        // A key must not be able to mint more keys.
        if (auth.via === 'api_key') throw forbidden('Approve studio PCs in the admin panel');
        const link = await pendingLink(req.params.code);
        if (stateOf(link) !== 'pending') throw new HttpError(409, 'not_pending', 'This link request is no longer open');
        const [row] = await ctx.db
          .update(schema.studioLinks)
          .set({ state: decision === 'approve' ? 'approved' : 'denied', userId: auth.user.id })
          .where(and(eq(schema.studioLinks.id, link.id), eq(schema.studioLinks.state, 'pending')))
          .returning();
        if (!row) throw new HttpError(409, 'not_pending', 'This link request is no longer open');
        Object.assign(req.auditInfo, { targetType: 'studio_link', targetId: row.id, details: { device: row.deviceName } });
        return toLinkOut(row);
      },
    );
  }

  // Linked PCs

  app.get(
    '/devices',
    { schema: { tags: ['Studio client'], summary: 'Your linked studio PCs', response: { 200: z.array(deviceOut) } } },
    async (req) => {
      const auth = requireUser(req);
      const rows = await ctx.db
        .select({ link: schema.studioLinks, key: schema.apiKeys })
        .from(schema.studioLinks)
        .innerJoin(schema.apiKeys, eq(schema.apiKeys.id, schema.studioLinks.apiKeyId))
        .where(and(eq(schema.studioLinks.userId, auth.user.id), isNotNull(schema.studioLinks.apiKeyId)))
        .orderBy(desc(schema.studioLinks.createdAt));
      return rows.map(({ link, key }) => ({
        id: link.id,
        deviceName: link.deviceName,
        clientVersion: link.clientVersion,
        apiKeyId: key.id,
        lastUsedAt: key.lastUsedAt,
        createdAt: link.createdAt,
      }));
    },
  );

  app.delete(
    '/devices/:id',
    { config: { audit: 'studio.device.unlink' }, schema: { tags: ['Studio client'], summary: 'Unlink a studio PC (revokes its key)', params: idParam, response: { 200: okOut } } },
    async (req) => {
      const auth = requireUser(req);
      const [link] = await ctx.db.select().from(schema.studioLinks).where(and(eq(schema.studioLinks.id, req.params.id), eq(schema.studioLinks.userId, auth.user.id)));
      if (!link?.apiKeyId) throw notFound('Studio PC');
      await ctx.db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, link.apiKeyId));
      await ctx.db.delete(schema.studioLinks).where(eq(schema.studioLinks.id, link.id));
      Object.assign(req.auditInfo, { targetType: 'studio_link', details: { device: link.deviceName } });
      return { ok: true as const };
    },
  );

  app.delete(
    '/session',
    {
      config: { audit: 'studio.device.sign_out' },
      schema: { tags: ['Studio client'], summary: 'Sign this studio PC out: revokes the API key it calls with', response: { 200: okOut } },
    },
    async (req) => {
      const auth = requireUser(req);
      if (auth.via !== 'api_key') throw badRequest('Only a studio PC can sign itself out');
      const [key] = await ctx.db.delete(schema.apiKeys).where(eq(schema.apiKeys.hash, sha256(req.headers.authorization!.slice(7).trim()))).returning();
      if (key) await ctx.db.delete(schema.studioLinks).where(eq(schema.studioLinks.apiKeyId, key.id));
      return { ok: true as const };
    },
  );

  // The client reports its version so the panel can show it, and learns what this server can do.
  app.post(
    '/hello',
    {
      schema: {
        tags: ['Studio client'],
        summary:
          'The client tells which version it runs (shown with the linked PC). The answer has the server version and the client features it supports, so an older server is reported instead of failing.',
        body: z.object({ clientVersion: z.string().trim().max(40) }),
        response: { 200: okOut.extend({ serverVersion: z.string(), features: z.array(z.string()) }) },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const hello = { ok: true as const, serverVersion: (await runningVersion(ctx)).version, features: [...STUDIO_FEATURES] };
      if (auth.via !== 'api_key') return hello;
      const key = req.headers.authorization!.slice(7).trim();
      const [k] = await ctx.db.select({ id: schema.apiKeys.id }).from(schema.apiKeys).where(eq(schema.apiKeys.hash, sha256(key)));
      if (k) await ctx.db.update(schema.studioLinks).set({ clientVersion: req.body.clientVersion }).where(eq(schema.studioLinks.apiKeyId, k.id));
      return hello;
    },
  );

  // Live broadcasts

  app.post(
    '/stations/:id/live-token',
    {
      config: { audit: 'studio.live_token' },
      schema: {
        tags: ['Studio client'],
        summary: `An encoder password for a DJ account, valid ${LIVE_TOKEN_HOURS} hours. DJs get one for their own account; managers for any account of the station.`,
        params: idParam,
        body: z.object({ accountId: z.uuid() }),
        response: { 200: z.object({ username: z.string(), password: z.string(), expiresAt: z.date() }) },
      },
    },
    async (req) => {
      const { station, access } = await stationAccess(ctx, req, req.params.id, 'dj');
      const [account] = await ctx.db
        .select()
        .from(schema.stationAccounts)
        .where(and(eq(schema.stationAccounts.id, req.body.accountId), eq(schema.stationAccounts.stationId, station.id)));
      if (!account) throw notFound('Account');
      if (access.role === 'dj' && account.userId !== access.user.id) throw forbidden('You can only broadcast with your own DJ account');
      if (!account.enabled || !account.canBroadcast) throw badRequest('This account may not broadcast');
      await ctx.db.delete(schema.studioLiveTokens).where(lt(schema.studioLiveTokens.expiresAt, new Date()));
      const password = `${LIVE_TOKEN_PREFIX}${randomToken(24)}`;
      const expiresAt = new Date(Date.now() + LIVE_TOKEN_HOURS * 3600_000);
      await ctx.db.insert(schema.studioLiveTokens).values({ accountId: account.id, userId: access.user.id, hash: sha256(password), expiresAt });
      Object.assign(req.auditInfo, { targetType: 'station_account', targetId: account.id, details: { username: account.username } });
      return { username: account.username, password, expiresAt };
    },
  );

  // Releases

  app.get(
    '/releases',
    {
      schema: {
        tags: ['Studio client'],
        summary: 'The newest studio client per channel (production = releases from main, test = pre-releases from test)',
        security: [],
        response: { 200: z.object({ repository: z.string().nullable(), production: releaseOut, test: releaseOut, checkedAt: z.string().nullable(), error: z.string().nullable() }) },
      },
    },
    async () => studioReleases(ctx),
  );
};
