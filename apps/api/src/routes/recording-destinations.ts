import { and, count, eq, max, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { checkLocation, CommandError, withRemote } from '../services/backup/engine.js';
import { driveInfo, parseToken, pollDeviceCode, startDeviceCode } from '../services/backup/onedrive.js';
import { decryptConfig, describeTarget, encryptConfig, maskConfig, unmask, validateConfig, type AnyTargetConfig } from '../services/backup/targets.js';
import { getSetting } from '../services/settings.js';
import { stationAccess } from './stations.js';

/** Where recordings can go: the backup location types except a folder on this server. */
export const DESTINATION_TYPES = ['ftp', 'ftps', 'sftp', 'onedrive'] as const;
type DestinationType = (typeof DESTINATION_TYPES)[number];

const params = z.object({ id: z.uuid() });
const destParams = z.object({ id: z.uuid(), did: z.uuid() });
const kinds = z.array(z.enum(['log', 'show'])).min(1, 'Choose logging, shows or both').max(2);

const destinationOut = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(DESTINATION_TYPES),
  description: z.string(),
  config: z.record(z.string(), z.unknown()),
  kinds: z.array(z.enum(['log', 'show'])),
  enabled: z.boolean(),
  createdAt: z.date(),
  /** Uploads that worked, and the last one. */
  uploaded: z.number(),
  lastUploadAt: z.date().nullable(),
  /** Uploads that failed and are tried again, with the newest error. */
  failing: z.number(),
  lastError: z.string().nullable(),
  nextTryAt: z.date().nullable(),
});
const destinationIn = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(DESTINATION_TYPES),
  config: z.record(z.string(), z.unknown()),
  kinds,
  enabled: z.boolean().default(true),
});

/**
 * Upload destinations of a station's recordings (phase 21 step 3): FTP, FTPS, SFTP or OneDrive, set up like a backup
 * location. Station managers manage them. Mounted under /api/stations.
 */
export const recordingDestinationRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const d = schema.recordingDestinations;
  const del = schema.recordingDeliveries;

  async function getRow(stationId: string, id: string) {
    const [row] = await ctx.db.select().from(d).where(and(eq(d.id, id), eq(d.stationId, stationId)));
    if (!row) throw notFound('Destination');
    return row;
  }

  async function present(row: typeof d.$inferSelect): Promise<z.infer<typeof destinationOut>> {
    const cfg = decryptConfig(ctx, row);
    const [done] = await ctx.db.select({ n: count(), last: max(del.at) }).from(del).where(and(eq(del.destinationId, row.id), eq(del.state, 'done')));
    const [failed] = await ctx.db
      .select({ n: count(), next: sql<Date | null>`min(${del.nextAt})`.mapWith((v) => (v ? new Date(v as string) : null)) })
      .from(del)
      .where(and(eq(del.destinationId, row.id), eq(del.state, 'failed')));
    const [newest] = failed?.n
      ? await ctx.db.select({ error: del.error }).from(del).where(and(eq(del.destinationId, row.id), eq(del.state, 'failed'))).orderBy(sql`${del.at} desc`).limit(1)
      : [];
    return {
      id: row.id,
      name: row.name,
      type: row.type as DestinationType,
      description: describeTarget(row.type, cfg),
      config: maskConfig(row.type, cfg),
      kinds: row.kinds.filter((k): k is 'log' | 'show' => k === 'log' || k === 'show'),
      enabled: row.enabled,
      createdAt: row.createdAt,
      uploaded: done?.n ?? 0,
      lastUploadAt: done?.last ?? null,
      failing: failed?.n ?? 0,
      lastError: newest?.error ?? null,
      nextTryAt: failed?.next ?? null,
    };
  }

  /** Validates the config and fills in OneDrive drive details from the token when they are missing. */
  async function prepareConfig(type: DestinationType, raw: Record<string, unknown>, current: AnyTargetConfig | null) {
    let cfg: AnyTargetConfig;
    try {
      cfg = validateConfig(type, raw);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    cfg = unmask(type, cfg, current);
    if (type === 'onedrive') {
      const c = cfg as AnyTargetConfig & { token: string; driveId: string };
      if (!c.token) throw badRequest('Sign in to OneDrive first');
      let token;
      try {
        token = parseToken(c.token);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
      if (!c.driveId) {
        try {
          Object.assign(c, await driveInfo(token.access_token));
        } catch (err) {
          throw badRequest(`${(err as Error).message}. The pasted token may have expired; run rclone authorize again.`);
        }
      }
    }
    return cfg;
  }

  app.get(
    '/:id/recording/destinations',
    {
      schema: {
        tags: ['Recordings'],
        summary: 'Where the recordings of the station are uploaded to, with how the uploads go',
        params,
        response: { 200: z.object({ destinations: z.array(destinationOut), onedriveSignIn: z.boolean() }) },
      },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const rows = await ctx.db.select().from(d).where(eq(d.stationId, station.id)).orderBy(d.name);
      const { onedriveClientId } = await getSetting(ctx, 'backup');
      return { destinations: await Promise.all(rows.map(present)), onedriveSignIn: !!onedriveClientId };
    },
  );

  app.post(
    '/:id/recording/destinations',
    {
      config: { audit: 'station.recording_destination_create' },
      schema: { tags: ['Recordings'], summary: 'Add an upload destination for the recordings of the station', params, body: destinationIn, response: { 201: destinationOut } },
    },
    async (req, reply) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const cfg = await prepareConfig(req.body.type, req.body.config, null);
      const [row] = await ctx.db
        .insert(d)
        .values({ stationId: station.id, name: req.body.name, type: req.body.type, config: encryptConfig(ctx, req.body.type, cfg, null), kinds: req.body.kinds, enabled: req.body.enabled })
        .returning();
      req.auditInfo.details = { name: row!.name, type: row!.type };
      return reply.status(201).send(await present(row!));
    },
  );

  app.put(
    '/:id/recording/destinations/:did',
    {
      config: { audit: 'station.recording_destination_update' },
      schema: { tags: ['Recordings'], summary: 'Change an upload destination', params: destParams, body: destinationIn, response: { 200: destinationOut } },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const row = await getRow(station.id, req.params.did);
      if (row.type !== req.body.type) throw badRequest('The type of a destination cannot change');
      const current = decryptConfig(ctx, row);
      const cfg = await prepareConfig(req.body.type, req.body.config, current);
      const [next] = await ctx.db
        .update(d)
        .set({ name: req.body.name, config: encryptConfig(ctx, row.type, cfg, current), kinds: req.body.kinds, enabled: req.body.enabled, updatedAt: new Date() })
        .where(eq(d.id, row.id))
        .returning();
      // New settings: what failed is tried again at once.
      await ctx.db.update(del).set({ nextAt: new Date() }).where(and(eq(del.destinationId, row.id), eq(del.state, 'failed')));
      req.auditInfo.details = { name: next!.name };
      return present(next!);
    },
  );

  app.delete(
    '/:id/recording/destinations/:did',
    {
      config: { audit: 'station.recording_destination_delete' },
      schema: { tags: ['Recordings'], summary: 'Remove an upload destination (what was uploaded there stays there)', params: destParams, response: { 200: z.object({ ok: z.literal(true) }) } },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const row = await getRow(station.id, req.params.did);
      await ctx.db.delete(d).where(eq(d.id, row.id));
      req.auditInfo.details = { name: row.name };
      return { ok: true as const };
    },
  );

  app.post(
    '/:id/recording/destinations/:did/retry',
    { schema: { tags: ['Recordings'], summary: 'Try the failed uploads of a destination again now', params: destParams, response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const row = await getRow(station.id, req.params.did);
      await ctx.db.update(del).set({ nextAt: new Date() }).where(and(eq(del.destinationId, row.id), eq(del.state, 'failed')));
      void app.recordingDelivery?.tick();
      return { ok: true as const };
    },
  );

  app.post(
    '/:id/recording/destinations/test',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Recordings'],
        summary: 'Test a destination before or after saving: can it be reached with these settings, and can the folder be made?',
        params,
        body: z.object({ did: z.uuid().optional(), type: z.enum(DESTINATION_TYPES), config: z.record(z.string(), z.unknown()) }),
        response: { 200: z.object({ ok: z.literal(true), message: z.string() }) },
      },
    },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const row = req.body.did ? await getRow(station.id, req.body.did) : null;
      if (row && row.type !== req.body.type) throw badRequest('The type of a destination cannot change');
      const cfg = await prepareConfig(req.body.type, req.body.config, row ? decryptConfig(ctx, row) : null);
      const target = { type: req.body.type, config: cfg, repoPassword: '' };
      try {
        await withRemote(target, (remote) => checkLocation(target, remote));
      } catch (err) {
        throw badRequest(err instanceof CommandError || err instanceof Error ? err.message : String(err));
      }
      return { ok: true as const, message: describeTarget(req.body.type, cfg) };
    },
  );

  // OneDrive sign-in for a destination: the device code flow with the Microsoft app of the backup settings.

  app.post(
    '/:id/recording/onedrive/device-code',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Recordings'],
        summary: 'Start signing in to OneDrive for a destination: returns a code to enter at the Microsoft address',
        params,
        response: { 200: z.object({ deviceCode: z.string(), userCode: z.string(), verificationUri: z.string(), interval: z.number(), expiresIn: z.number() }) },
      },
    },
    async (req) => {
      await stationAccess(ctx, req, req.params.id, 'manager');
      const { onedriveClientId } = await getSetting(ctx, 'backup');
      if (!onedriveClientId) throw badRequest('Signing in to OneDrive from the panel is not set up on this server; paste a token from rclone authorize instead');
      try {
        return await startDeviceCode(onedriveClientId);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    },
  );

  app.post(
    '/:id/recording/onedrive/device-token',
    {
      schema: {
        tags: ['Recordings'],
        summary: 'Finish signing in to OneDrive for a destination. Answers pending until the code has been entered.',
        params,
        body: z.object({ deviceCode: z.string().min(10).max(5000) }),
        response: {
          200: z.object({
            status: z.enum(['pending', 'ok']),
            token: z.string().optional(),
            clientId: z.string().optional(),
            driveId: z.string().optional(),
            driveType: z.string().optional(),
            account: z.string().optional(),
          }),
        },
      },
    },
    async (req) => {
      await stationAccess(ctx, req, req.params.id, 'manager');
      const { onedriveClientId } = await getSetting(ctx, 'backup');
      try {
        const token = await pollDeviceCode(onedriveClientId, req.body.deviceCode);
        if (!token) return { status: 'pending' as const };
        const info = await driveInfo(token.access_token);
        return { status: 'ok' as const, token: JSON.stringify(token), clientId: onedriveClientId, ...info };
      } catch (err) {
        throw new HttpError(400, 'onedrive_failed', (err as Error).message);
      }
    },
  );
};
