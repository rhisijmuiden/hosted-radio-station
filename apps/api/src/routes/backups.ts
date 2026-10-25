import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { requireSuperadmin } from '../lib/auth.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { idParam, okOut } from '../lib/schemas.js';
import { checkLocation, CommandError, listSnapshots, repositoryState, withRemote } from '../services/backup/engine.js';
import { loadTarget, nextSlot, queueRun } from '../services/backup/jobs.js';
import { driveInfo, parseToken, pollDeviceCode, startDeviceCode } from '../services/backup/onedrive.js';
import {
  decryptConfig,
  describeTarget,
  encryptConfig,
  generateRepoPassword,
  maskConfig,
  retentionSchema,
  scheduleSchema,
  TARGET_TYPES,
  unmask,
  validateConfig,
  type AnyTargetConfig,
  type TargetType,
} from '../services/backup/targets.js';
import { getSetting, SECRET_MASK } from '../services/settings.js';

type TargetRow = typeof schema.backupTargets.$inferSelect;

const runOut = z.object({
  id: z.uuid(),
  targetId: z.uuid().nullable(),
  targetName: z.string(),
  kind: z.enum(['full', 'incremental', 'restore']),
  state: z.enum(['queued', 'running', 'succeeded', 'failed']),
  trigger: z.string(),
  requestedBy: z.string().nullable(),
  snapshotId: z.string().nullable(),
  filesNew: z.number().nullable(),
  filesChanged: z.number().nullable(),
  bytesAdded: z.number().nullable(),
  bytesTotal: z.number().nullable(),
  message: z.string().nullable(),
  queuedAt: z.date(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
});
const runDetailOut = runOut.extend({ log: z.string(), params: z.record(z.string(), z.unknown()).nullable() });

const targetOut = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(TARGET_TYPES),
  description: z.string(),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  schedule: scheduleSchema,
  retention: retentionSchema,
  createdAt: z.date(),
  lastRun: runOut.nullable(),
  lastSuccess: runOut.nullable(),
  nextFull: z.date().nullable(),
  nextIncremental: z.date().nullable(),
});

const targetInput = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(TARGET_TYPES),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()),
  schedule: scheduleSchema.default(scheduleSchema.parse({})),
  retention: retentionSchema.default(retentionSchema.parse({})),
  /** Recovery key of an existing repository at this location (to restore on a new server). Empty = generate one. */
  repoPassword: z.string().max(500).optional(),
});

const runSummary = (r: typeof schema.backupRuns.$inferSelect) => {
  const { log: _log, params: _params, ...rest } = r;
  return rest;
};

/** Backup locations, runs and restores. Administrators only. */
export const backupRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  async function getRow(id: string) {
    const [row] = await ctx.db.select().from(schema.backupTargets).where(eq(schema.backupTargets.id, id));
    if (!row) throw notFound('Backup location');
    return row;
  }

  async function present(row: TargetRow) {
    const cfg = decryptConfig(ctx, row);
    const [lastRun] = await ctx.db
      .select()
      .from(schema.backupRuns)
      .where(eq(schema.backupRuns.targetId, row.id))
      .orderBy(desc(schema.backupRuns.queuedAt))
      .limit(1);
    const [lastSuccess] = await ctx.db
      .select()
      .from(schema.backupRuns)
      .where(and(eq(schema.backupRuns.targetId, row.id), eq(schema.backupRuns.state, 'succeeded'), isNotNull(schema.backupRuns.snapshotId)))
      .orderBy(desc(schema.backupRuns.finishedAt))
      .limit(1);
    const now = new Date();
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      description: describeTarget(row.type, cfg),
      enabled: row.enabled,
      config: maskConfig(row.type, cfg),
      schedule: row.schedule as z.infer<typeof scheduleSchema>,
      retention: row.retention,
      createdAt: row.createdAt,
      lastRun: lastRun ? runSummary(lastRun) : null,
      lastSuccess: lastSuccess ? runSummary(lastSuccess) : null,
      nextFull: row.enabled ? nextSlot(row.schedule, 'full', now) : null,
      nextIncremental: row.enabled ? nextSlot(row.schedule, 'incremental', now) : null,
    };
  }

  /** Validates the config and fills in OneDrive drive details from the token when they are missing. */
  async function prepareConfig(type: TargetType, raw: Record<string, unknown>, current: AnyTargetConfig | null) {
    let cfg: AnyTargetConfig;
    try {
      cfg = validateConfig(type, raw);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    cfg = unmask(type, cfg, current);
    if (type === 'onedrive') {
      const c = cfg as AnyTargetConfig & { token: string; driveId: string; driveType: string; account: string };
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
    '/targets',
    { schema: { tags: ['Backups'], summary: 'Backup locations with their last run and next scheduled runs', response: { 200: z.array(targetOut) } } },
    async (req) => {
      requireSuperadmin(req);
      const rows = await ctx.db.select().from(schema.backupTargets).orderBy(schema.backupTargets.name);
      return Promise.all(rows.map(present));
    },
  );

  app.get(
    '/targets/:id',
    { schema: { tags: ['Backups'], summary: 'One backup location', params: idParam, response: { 200: targetOut } } },
    async (req) => {
      requireSuperadmin(req);
      return present(await getRow(req.params.id));
    },
  );

  app.post(
    '/targets',
    {
      config: { audit: 'backup.target_create' },
      schema: {
        tags: ['Backups'],
        summary: 'Add a backup location. Returns the recovery key once; keep it safe, it is needed to restore on a new server.',
        body: targetInput,
        response: { 201: targetOut.extend({ recoveryKey: z.string() }) },
      },
    },
    async (req, reply) => {
      requireSuperadmin(req);
      const cfg = await prepareConfig(req.body.type, req.body.config, null);
      const recoveryKey = req.body.repoPassword?.trim() || generateRepoPassword();
      const [row] = await ctx.db
        .insert(schema.backupTargets)
        .values({
          name: req.body.name,
          type: req.body.type,
          enabled: req.body.enabled,
          config: encryptConfig(ctx, req.body.type, cfg, null),
          repoPassword: ctx.box.encrypt(recoveryKey),
          schedule: req.body.schedule,
          retention: req.body.retention,
        })
        .returning();
      req.auditInfo = { targetType: 'backup_target', targetId: row!.id, details: { name: row!.name, type: row!.type, existingKey: !!req.body.repoPassword } };
      reply.status(201);
      return { ...(await present(row!)), recoveryKey };
    },
  );

  app.put(
    '/targets/:id',
    {
      config: { audit: 'backup.target_update' },
      schema: {
        tags: ['Backups'],
        summary: `Change a backup location. Send "${SECRET_MASK}" to keep a stored password.`,
        params: idParam,
        body: targetInput.omit({ type: true, repoPassword: true }),
        response: { 200: targetOut },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const row = await getRow(req.params.id);
      const current = decryptConfig(ctx, row);
      const cfg = await prepareConfig(row.type, req.body.config, current);
      const now = new Date();
      const scheduleChanged = JSON.stringify(row.schedule) !== JSON.stringify(req.body.schedule);
      const [updated] = await ctx.db
        .update(schema.backupTargets)
        .set({
          name: req.body.name,
          enabled: req.body.enabled,
          config: encryptConfig(ctx, row.type, cfg, current),
          schedule: req.body.schedule,
          retention: req.body.retention,
          // Moments that passed before this change are not made up for.
          ...(scheduleChanged || (req.body.enabled && !row.enabled) ? { updatedAt: now } : {}),
        })
        .where(eq(schema.backupTargets.id, row.id))
        .returning();
      req.auditInfo = { targetType: 'backup_target', details: { name: updated!.name, enabled: updated!.enabled } };
      return present(updated!);
    },
  );

  app.delete(
    '/targets/:id',
    {
      config: { audit: 'backup.target_delete' },
      schema: {
        tags: ['Backups'],
        summary: 'Remove a backup location from this server. The backups at the location itself are kept.',
        params: idParam,
        response: { 200: okOut },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const row = await getRow(req.params.id);
      const [busy] = await ctx.db
        .select({ id: schema.backupRuns.id })
        .from(schema.backupRuns)
        .where(and(eq(schema.backupRuns.targetId, row.id), eq(schema.backupRuns.state, 'running')));
      if (busy) throw conflict('A backup is running for this location');
      await ctx.db.delete(schema.backupTargets).where(eq(schema.backupTargets.id, row.id));
      req.auditInfo = { targetType: 'backup_target', details: { name: row.name } };
      return { ok: true as const };
    },
  );

  app.get(
    '/targets/:id/recovery-key',
    {
      config: { audit: 'backup.recovery_key_viewed' },
      schema: {
        tags: ['Backups'],
        summary: 'Show the recovery key (repository password) of a location',
        params: idParam,
        response: { 200: z.object({ recoveryKey: z.string() }) },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const row = await getRow(req.params.id);
      req.auditInfo = { targetType: 'backup_target' };
      return { recoveryKey: ctx.box.decrypt(row.repoPassword) };
    },
  );

  app.post(
    '/test',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Backups'],
        summary: 'Test a location before or after saving: can it be reached, and is there already a backup repository?',
        body: z.object({
          id: z.uuid().optional(),
          type: z.enum(TARGET_TYPES),
          config: z.record(z.string(), z.unknown()),
          repoPassword: z.string().max(500).optional(),
        }),
        response: {
          200: z.object({ ok: z.literal(true), repository: z.enum(['ready', 'empty', 'wrong_password', 'existing']), message: z.string() }),
        },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const row = req.body.id ? await getRow(req.body.id) : null;
      if (row && row.type !== req.body.type) throw badRequest('The type of a location cannot change');
      const cfg = await prepareConfig(req.body.type, req.body.config, row ? decryptConfig(ctx, row) : null);
      const repoPassword = row ? ctx.box.decrypt(row.repoPassword) : req.body.repoPassword?.trim() || 'probe-only-no-repository-access';
      try {
        return await withRemote({ type: req.body.type, config: cfg, repoPassword }, async (remote) => {
          await checkLocation({ type: req.body.type, config: cfg, repoPassword }, remote);
          const state = await repositoryState(remote);
          // Without a key we can only tell that there are backups here already.
          const repository = state === 'wrong_password' && !row && !req.body.repoPassword ? ('existing' as const) : state;
          return { ok: true as const, repository, message: describeTarget(req.body.type, cfg) };
        });
      } catch (err) {
        throw badRequest(err instanceof CommandError || err instanceof Error ? err.message : String(err));
      }
    },
  );

  app.post(
    '/targets/:id/run',
    {
      config: { audit: 'backup.start' },
      schema: {
        tags: ['Backups'],
        summary: 'Start a backup now',
        params: idParam,
        body: z.object({ kind: z.enum(['full', 'incremental']).default('incremental') }),
        response: { 202: runOut },
      },
    },
    async (req, reply) => {
      const auth = requireSuperadmin(req);
      const row = await getRow(req.params.id);
      const run = await queueRun(ctx, row, req.body.kind, 'manual', auth.user.email);
      req.auditInfo = { targetType: 'backup_target', details: { kind: req.body.kind, run: run.id } };
      reply.status(202);
      return runSummary(run);
    },
  );

  app.get(
    '/targets/:id/snapshots',
    {
      schema: {
        tags: ['Backups'],
        summary: 'The backups (snapshots) stored at a location, newest first',
        params: idParam,
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              shortId: z.string(),
              time: z.string(),
              hostname: z.string(),
              tags: z.array(z.string()),
              paths: z.array(z.string()),
              kind: z.enum(['full', 'incremental', 'unknown']),
              sizeBytes: z.number().nullable(),
              filesNew: z.number().nullable(),
            }),
          ),
        },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const row = await getRow(req.params.id);
      try {
        return await withRemote(await loadTarget(ctx, row), async (remote) => {
          const state = await repositoryState(remote);
          if (state === 'empty') return [];
          if (state === 'wrong_password') throw new Error('The recovery key does not match the backups at this location');
          return listSnapshots(remote);
        });
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    },
  );

  app.post(
    '/targets/:id/restore',
    {
      config: { audit: 'backup.restore' },
      schema: {
        tags: ['Backups'],
        summary: 'Restore a snapshot. The panel is unavailable while the database is restored.',
        params: idParam,
        body: z.object({
          snapshotId: z.string().regex(/^[0-9a-f]{8,64}$/),
          parts: z.object({ database: z.boolean(), files: z.boolean(), config: z.boolean() }),
          /** Must be "RESTORE": a restore overwrites the current data. */
          confirm: z.literal('RESTORE'),
        }),
        response: { 202: runOut },
      },
    },
    async (req, reply) => {
      const auth = requireSuperadmin(req);
      const row = await getRow(req.params.id);
      if (!Object.values(req.body.parts).some(Boolean)) throw badRequest('Choose what to restore');
      const [busy] = await ctx.db.select({ id: schema.backupRuns.id }).from(schema.backupRuns).where(eq(schema.backupRuns.state, 'running'));
      if (busy) throw conflict('Wait until the running backup has finished');
      const run = await queueRun(ctx, row, 'restore', 'manual', auth.user.email, { snapshotId: req.body.snapshotId, parts: req.body.parts });
      req.auditInfo = { targetType: 'backup_target', details: { snapshot: req.body.snapshotId, parts: req.body.parts, run: run.id } };
      reply.status(202);
      return runSummary(run);
    },
  );

  app.get(
    '/runs',
    {
      schema: {
        tags: ['Backups'],
        summary: 'Recent backup and restore runs, newest first',
        querystring: z.object({ targetId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(30) }),
        response: { 200: z.array(runOut) },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const rows = await ctx.db
        .select()
        .from(schema.backupRuns)
        .where(req.query.targetId ? eq(schema.backupRuns.targetId, req.query.targetId) : undefined)
        .orderBy(desc(schema.backupRuns.queuedAt))
        .limit(req.query.limit);
      return rows.map(runSummary);
    },
  );

  app.get(
    '/runs/:id',
    { schema: { tags: ['Backups'], summary: 'One run with its log', params: idParam, response: { 200: runDetailOut } } },
    async (req) => {
      requireSuperadmin(req);
      const [row] = await ctx.db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, req.params.id));
      if (!row) throw notFound('Run');
      return row;
    },
  );

  app.post(
    '/runs/:id/cancel',
    {
      config: { audit: 'backup.cancel' },
      schema: { tags: ['Backups'], summary: 'Cancel a run that has not started yet', params: idParam, response: { 200: okOut } },
    },
    async (req) => {
      requireSuperadmin(req);
      const done = await ctx.db
        .update(schema.backupRuns)
        .set({ state: 'failed', message: 'Cancelled', finishedAt: new Date() })
        .where(and(eq(schema.backupRuns.id, req.params.id), eq(schema.backupRuns.state, 'queued')))
        .returning();
      if (!done.length) throw conflict('Only waiting runs can be cancelled');
      req.auditInfo = { targetType: 'backup_run' };
      return { ok: true as const };
    },
  );

  // OneDrive sign-in (device code flow with your own Microsoft app)

  app.post(
    '/onedrive/device-code',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Backups'],
        summary: 'Start signing in to OneDrive: returns a code to enter at the Microsoft address',
        response: {
          200: z.object({ deviceCode: z.string(), userCode: z.string(), verificationUri: z.string(), interval: z.number(), expiresIn: z.number() }),
        },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const { onedriveClientId } = await getSetting(ctx, 'backup');
      if (!onedriveClientId) throw badRequest('Enter the application (client) ID of your Microsoft app under backup settings first');
      try {
        return await startDeviceCode(onedriveClientId);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    },
  );

  app.post(
    '/onedrive/device-token',
    {
      schema: {
        tags: ['Backups'],
        summary: 'Finish signing in to OneDrive. Answers pending until the code has been entered.',
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
      requireSuperadmin(req);
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
