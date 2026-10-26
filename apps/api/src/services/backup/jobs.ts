import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { emailWords, renderTemplate } from '../email-templates.js';
import { sendMail } from '../mail.js';
import { getSetting } from '../settings.js';
import { applyRetention, CommandError, createFolder, ensureRepository, formatBytes, restoreSnapshot, run, runBackup, withRemote, type Target } from './engine.js';
import { freshToken } from './onedrive.js';
import { decryptConfig, encryptConfig, type AnyTargetConfig } from './targets.js';

type Run = typeof schema.backupRuns.$inferSelect;
type TargetRow = typeof schema.backupTargets.$inferSelect;

/** Fixed host name in every snapshot, so a server that is rebuilt keeps the same retention group. */
export const SNAPSHOT_HOST = 'hosted-radio';

export interface RestoreParts {
  database: boolean;
  files: boolean;
  config: boolean;
}

export function configPaths(ctx: AppContext) {
  return ctx.config.BACKUP_CONFIG_PATHS.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

const stagingDir = (ctx: AppContext) => join(ctx.config.DATA_DIR, 'backup-staging');
const restoreDir = (ctx: AppContext) => join(ctx.config.DATA_DIR, 'restore-staging');

/** What goes into every snapshot: the data folder (with a fresh database dump) and the configuration files. */
export function backupPaths(ctx: AppContext) {
  const d = ctx.config.DATA_DIR;
  return {
    paths: [d, ...configPaths(ctx).filter((p) => existsSync(p))],
    excludes: [
      join(d, 'run'),
      join(d, 'restore-staging'),
      join(d, '.cache'),
      join(d, 'cache'),
      // Icecast logs and process ids of the stations; the configuration is rewritten from the database anyway.
      join(d, 'stations', '*', 'logs'),
      join(d, 'stations', '*', 'icecast.pid'),
      // Mounted music shares belong to their file server, and the AutoDJ's control socket is not a file.
      join(d, 'stations', '*', 'sources'),
      join(d, 'stations', '*', 'autodj.sock'),
      // GeoIP databases are downloaded again after a restore.
      join(d, 'geoip'),
    ],
  };
}

export async function loadTarget(ctx: AppContext, row: TargetRow): Promise<Target> {
  return { type: row.type, config: decryptConfig(ctx, row), repoPassword: ctx.box.decrypt(row.repoPassword) };
}

// Queue

/** Wakes the worker: the root helper unit in production, or this process during development. */
export async function kickWorker(ctx: AppContext) {
  if (ctx.config.SYSTEM_HELPERS === '1') {
    const dir = join(ctx.config.DATA_DIR, 'run');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'backup-request'), new Date().toISOString());
  } else if (ctx.config.NODE_ENV !== 'test') {
    void processQueue(ctx).catch((err) => console.error('backup worker failed', err));
  }
}

export async function queueRun(
  ctx: AppContext,
  target: Pick<TargetRow, 'id' | 'name'>,
  kind: Run['kind'],
  trigger: 'manual' | 'schedule' | 'shell',
  requestedBy: string | null,
  params: Record<string, unknown> | null = null,
  kick = true,
) {
  const [row] = await ctx.db
    .insert(schema.backupRuns)
    .values({ targetId: target.id, targetName: target.name, kind, trigger, requestedBy, params, message: 'Waiting' })
    .returning();
  if (kick) await kickWorker(ctx);
  return row!;
}

let working: Promise<void> | null = null;

/** Runs queued jobs one by one until the queue is empty. Safe to call while it is already running. */
export function processQueue(ctx: AppContext): Promise<void> {
  working ??= (async () => {
    try {
      // A run still marked "running" belongs to a worker that died (crash, reboot).
      await ctx.db
        .update(schema.backupRuns)
        .set({ state: 'failed', message: 'Interrupted (the server or the backup process stopped)', finishedAt: new Date() })
        .where(eq(schema.backupRuns.state, 'running'));
      for (;;) {
        const [next] = await ctx.db.select().from(schema.backupRuns).where(eq(schema.backupRuns.state, 'queued')).orderBy(asc(schema.backupRuns.queuedAt)).limit(1);
        if (!next) break;
        await execute(ctx, next);
      }
    } finally {
      working = null;
    }
  })();
  return working;
}

class RunLog {
  private lines: string[] = [];
  private message = '';
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private ctx: AppContext,
    private runId: string,
  ) {}
  add = (line: string) => {
    const stamp = new Date().toTimeString().slice(0, 8);
    this.lines.push(`[${stamp}] ${line}`);
    if (this.lines.length > 2000) this.lines.splice(0, this.lines.length - 2000);
    this.schedule();
  };
  progress = (message: string) => {
    this.message = message;
    this.schedule();
  };
  text = () => this.lines.join('\n');
  private schedule() {
    this.timer ??= setTimeout(() => void this.flush(), 2000);
  }
  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.ctx.db
      .update(schema.backupRuns)
      .set({ log: this.text(), ...(this.message ? { message: this.message } : {}) })
      .where(and(eq(schema.backupRuns.id, this.runId), eq(schema.backupRuns.state, 'running')))
      .catch(() => undefined);
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

async function execute(ctx: AppContext, queued: Run) {
  const log = new RunLog(ctx, queued.id);
  const startedAt = new Date();
  await ctx.db.update(schema.backupRuns).set({ state: 'running', startedAt, message: 'Starting' }).where(eq(schema.backupRuns.id, queued.id));
  let result: Partial<Run> = {};
  let ok = false;
  try {
    const [row] = queued.targetId ? await ctx.db.select().from(schema.backupTargets).where(eq(schema.backupTargets.id, queued.targetId)) : [];
    if (!row) throw new Error('The backup location no longer exists');
    const target = await prepareTarget(ctx, row, log.add);
    result = queued.kind === 'restore' ? await doRestore(ctx, row, target, queued, log) : await doBackup(ctx, row, target, queued.kind, log);
    ok = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.add(`Failed: ${message}`);
    if (err instanceof CommandError && err.result.stderr) log.add(err.result.stderr.trim().split('\n').slice(-15).join('\n'));
    result = { message };
  } finally {
    log.stop();
  }
  const finished: Run = {
    ...queued,
    ...result,
    state: ok ? 'succeeded' : 'failed',
    startedAt,
    finishedAt: new Date(),
    log: log.text(),
  };
  // A database restore replaced this table; write the run back as a whole.
  const { id, ...rest } = finished;
  if (rest.targetId) {
    const [exists] = await ctx.db.select({ id: schema.backupTargets.id }).from(schema.backupTargets).where(eq(schema.backupTargets.id, rest.targetId));
    if (!exists) rest.targetId = null;
  }
  await ctx.db.insert(schema.backupRuns).values(finished).onConflictDoUpdate({ target: schema.backupRuns.id, set: rest });
  await notify(ctx, finished).catch((err) => console.error('backup notification failed', err));
  await writeAuditEntry(ctx, finished);
}

async function writeAuditEntry(ctx: AppContext, r: Run) {
  await ctx.db
    .insert(schema.auditLog)
    .values({
      action: r.kind === 'restore' ? 'backup.restore_finished' : 'backup.finished',
      via: 'system',
      actorEmail: r.requestedBy,
      targetType: 'backup_target',
      targetId: r.targetId,
      success: r.state === 'succeeded',
      details: { run: r.id, kind: r.kind, trigger: r.trigger, target: r.targetName, snapshot: r.snapshotId, message: r.message },
    })
    .catch(() => undefined);
}

/**
 * The worker runs as root, so a local repository ends up root-only. The panel lists snapshots itself (read-only, without
 * locks), so give the service account's group read access to it.
 */
async function shareLocalRepository(ctx: AppContext, path: string, log: (l: string) => void) {
  if (process.getuid?.() !== 0) return;
  try {
    const { gid } = statSync(ctx.config.DATA_DIR);
    for (const [cmd, args] of [['chgrp', ['-R', String(gid), path]], ['chmod', ['-R', 'g+rX', path]]] as const) {
      const res = await run(cmd, [...args]);
      if (res.code !== 0) throw new Error(res.stderr.trim() || `${cmd} exited with ${res.code}`);
    }
  } catch (err) {
    log(`Warning: could not give the panel read access to ${path}: ${(err as Error).message}`);
  }
}

/** Decrypts the target and renews a OneDrive token signed in through the panel. */
async function prepareTarget(ctx: AppContext, row: TargetRow, log: (l: string) => void) {
  const target = await loadTarget(ctx, row);
  if (row.type === 'onedrive') {
    const cfg = target.config as AnyTargetConfig & { token: string; tokenSource: string; clientId: string };
    if (cfg.tokenSource === 'device' && cfg.clientId) {
      const renewed = await freshToken(cfg.clientId, cfg.token);
      if (renewed) {
        cfg.token = JSON.stringify(renewed);
        await saveConfig(ctx, row, cfg);
        log('OneDrive sign-in renewed.');
      }
    }
  }
  return target;
}

async function saveConfig(ctx: AppContext, row: TargetRow, cfg: AnyTargetConfig) {
  await ctx.db
    .update(schema.backupTargets)
    .set({ config: encryptConfig(ctx, row.type, cfg, null) })
    .where(eq(schema.backupTargets.id, row.id));
}

/** Keeps a token that rclone refreshed during the run (OneDrive), so the next run can still sign in. */
async function keepRefreshedToken(ctx: AppContext, row: TargetRow, target: Target, token: string | null) {
  if (row.type !== 'onedrive' || !token) return;
  const cfg = target.config as AnyTargetConfig & { token: string };
  if (token === cfg.token) return;
  cfg.token = token;
  await saveConfig(ctx, row, cfg);
}

function pgEnv(url: string) {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { url: u.toString(), env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '15' } };
}

async function dumpDatabase(ctx: AppContext, file: string, log: (l: string) => void) {
  const { url, env } = pgEnv(ctx.config.DATABASE_URL);
  const res = await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', file, '--dbname', url], { env, onLine: log });
  if (res.code !== 0) throw new Error(`Database dump failed: ${res.stderr.trim().split('\n').at(-1)}`);
}

async function doBackup(ctx: AppContext, row: TargetRow, target: Target, kind: 'full' | 'incremental', log: RunLog): Promise<Partial<Run>> {
  log.add(`${kind === 'full' ? 'Full' : 'Incremental'} backup to "${row.name}".`);
  const staging = stagingDir(ctx);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    log.progress('Saving the database');
    await dumpDatabase(ctx, join(staging, 'database.dump'), log.add);
    log.add('Database saved.');
    return await withRemote(target, async (remote) => {
      log.progress('Connecting');
      await createFolder(remote);
      const state = await ensureRepository(remote);
      if (state === 'empty') log.add('Created a new backup repository at this location.');
      const { paths, excludes } = backupPaths(ctx);
      log.add(`Backing up ${paths.join(', ')}`);
      const summary = await runBackup(remote, { kind, paths, excludes, host: SNAPSHOT_HOST }, log.add, log.progress);
      let message = `${formatBytes(summary.bytesAdded)} uploaded, ${formatBytes(summary.bytesTotal)} backed up`;
      if (summary.warnings) message += '. Some files could not be read, see the log';
      try {
        log.progress('Removing old backups');
        await applyRetention(remote, row.retention, SNAPSHOT_HOST, log.add);
      } catch (err) {
        log.add(`Warning: ${(err as Error).message}`);
        message += '. Removing old backups failed, see the log';
      }
      await keepRefreshedToken(ctx, row, target, await remote.readToken());
      if (row.type === 'local') await shareLocalRepository(ctx, (row.config as { path: string }).path, log.add);
      return {
        snapshotId: summary.snapshotId,
        filesNew: summary.filesNew,
        filesChanged: summary.filesChanged,
        bytesAdded: summary.bytesAdded,
        bytesTotal: summary.bytesTotal,
        message,
      };
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function systemctl(ctx: AppContext, log: (l: string) => void, ...args: string[]) {
  if (ctx.config.SYSTEM_HELPERS !== '1') return;
  const res = await run('systemctl', args);
  if (res.code !== 0) log(`systemctl ${args.join(' ')} failed: ${res.stderr.trim()}`);
}

async function copyInto(from: string, to: string, skip: string[] = []) {
  if (!existsSync(from)) return false;
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    if (skip.includes(name)) continue;
    await cp(join(from, name), join(to, name), { recursive: true, force: true, preserveTimestamps: true });
  }
  return true;
}

async function doRestore(ctx: AppContext, row: TargetRow, target: Target, queued: Run, log: RunLog): Promise<Partial<Run>> {
  const params = (queued.params ?? {}) as { snapshotId?: string; parts?: RestoreParts };
  const snapshotId = params.snapshotId;
  const parts = params.parts ?? { database: true, files: true, config: true };
  if (!snapshotId || !/^[0-9a-f]{8,64}$/.test(snapshotId)) throw new Error('No snapshot chosen');
  const staging = restoreDir(ctx);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const done: string[] = [];
  let apiStopped = false;
  try {
    log.add(`Restoring snapshot ${snapshotId.slice(0, 8)} from "${row.name}" (${Object.entries(parts).filter(([, v]) => v).map(([k]) => k).join(', ')}).`);
    log.progress('Downloading the snapshot');
    await withRemote(target, async (remote) => {
      await restoreSnapshot(remote, snapshotId, staging, log.add);
      await keepRefreshedToken(ctx, row, target, await remote.readToken());
    });
    const restored = (p: string) => join(staging, p);
    const dump = restored(join(stagingDir(ctx), 'database.dump'));
    if (parts.database && !existsSync(dump)) throw new Error('This snapshot contains no database');

    log.progress('Stopping the panel');
    await systemctl(ctx, log.add, 'stop', 'hosted-radio-api');
    apiStopped = ctx.config.SYSTEM_HELPERS === '1';

    if (parts.config) {
      log.progress('Restoring configuration');
      for (const p of configPaths(ctx)) {
        const src = restored(p);
        if (!existsSync(src)) continue;
        await cp(src, p, { recursive: true, force: true, preserveTimestamps: true });
        log.add(`Restored ${p}`);
      }
      await alignDatabasePassword(ctx, log.add);
      done.push('configuration');
    }
    if (parts.database) {
      log.progress('Restoring the database');
      await ctx.db.execute(sql`drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;`);
      const { url, env } = pgEnv(ctx.config.DATABASE_URL);
      const res = await run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', url, dump], { env, onLine: log.add });
      if (res.code !== 0) throw new Error(`Restoring the database failed: ${res.stderr.trim().split('\n').at(-1)}`);
      // Runs that were busy when this snapshot was made never finished.
      await ctx.db
        .update(schema.backupRuns)
        .set({ state: 'failed', message: 'Interrupted (restored from a backup)', finishedAt: new Date() })
        .where(and(inArray(schema.backupRuns.state, ['queued', 'running']), ne(schema.backupRuns.id, queued.id)));
      log.add('Database restored.');
      done.push('database');
    }
    if (parts.files) {
      log.progress('Restoring files');
      await copyInto(restored(ctx.config.DATA_DIR), ctx.config.DATA_DIR, ['run', 'restore-staging', 'backup-staging', '.cache', 'cache']);
      log.add(`Restored ${ctx.config.DATA_DIR}`);
      done.push('files');
    }
    if (parts.config) await systemctl(ctx, log.add, 'reload-or-restart', 'caddy');
    return { snapshotId, message: `Restored ${done.join(', ')} from snapshot ${snapshotId.slice(0, 8)}` };
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (apiStopped) await systemctl(ctx, log.add, 'start', 'hosted-radio-api');
  }
}

/**
 * The restored env file holds the database password of the old server. On a rebuilt server the database role has
 * another password, so make the role match the restored file.
 */
async function alignDatabasePassword(ctx: AppContext, log: (l: string) => void) {
  if (ctx.config.SYSTEM_HELPERS !== '1') return;
  const envFile = process.env.HRS_ENV_FILE ?? '/etc/hosted-radio/hosted-radio.env';
  const text = await readFile(envFile, 'utf8').catch(() => '');
  const m = text.match(/^DATABASE_URL=postgres(?:ql)?:\/\/([^:]+):([^@]+)@/m);
  if (!m) return;
  const [, user, password] = m;
  if (!/^[A-Za-z0-9_]+$/.test(user!) || !/^[A-Za-z0-9._~-]+$/.test(password!)) {
    log('Warning: the restored database password has an unexpected format; leaving the database role unchanged.');
    return;
  }
  const res = await run('runuser', ['-u', 'postgres', '--', 'psql', '-q', '-c', `ALTER ROLE ${user} PASSWORD '${password}'`]);
  if (res.code === 0) log('Database password matched to the restored configuration.');
  else log(`Warning: could not update the database password: ${res.stderr.trim()}`);
}

// Notifications

async function notify(ctx: AppContext, r: Run) {
  const settings = await getSetting(ctx, 'backup');
  if (!settings.notifyEmails.length) return;
  const failed = r.state === 'failed';
  if (r.kind !== 'restore' && (settings.notifyOn === 'never' || (settings.notifyOn === 'failure' && !failed))) return;
  const lang = settings.notifyLanguage;
  const words = emailWords[lang];
  const time = (r.finishedAt ?? new Date()).toLocaleString(lang === 'nl' ? 'nl-NL' : 'en-GB');
  const url = `${ctx.config.PUBLIC_URL.replace(/\/$/, '')}/settings/backups`;
  const msg =
    r.kind === 'restore'
      ? renderTemplate('restoreFinished', lang, { state: words[r.state]!, target: r.targetName, snapshot: r.snapshotId?.slice(0, 8) ?? '', time, message: r.message ?? '' }, url)
      : renderTemplate(failed ? 'backupFailed' : 'backupSucceeded', lang, { kind: words[r.kind]!, target: r.targetName, time, message: r.message ?? '', stats: r.message ?? '' }, url);
  for (const to of settings.notifyEmails) await sendMail(ctx, { to, ...msg });
}

// Scheduler

const at = (base: Date, hhmm: string, addDays = 0, addHours = 0) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(base);
  d.setDate(d.getDate() + addDays);
  d.setHours(h! + addHours, m!, 0, 0);
  return d;
};

/** Most recent scheduled moment at or before `now` (server time zone), or null when that kind is switched off. */
export function lastSlot(schedule: TargetRow['schedule'], kind: 'full' | 'incremental', now: Date): Date | null {
  let best: Date | null = null;
  const consider = (d: Date) => {
    if (d <= now && (!best || d > best)) best = d;
  };
  if (kind === 'full') {
    if (!schedule.full.enabled) return null;
    for (let day = -7; day <= 0; day++) {
      const d = at(now, schedule.full.at, day);
      if (schedule.full.weekday === -1 || d.getDay() === schedule.full.weekday) consider(d);
    }
  } else {
    if (!schedule.incremental.enabled) return null;
    const every = schedule.incremental.everyHours;
    for (let day = -2; day <= 0; day++) for (let k = 0; k * every < 24; k++) consider(at(now, schedule.incremental.at, day, k * every));
  }
  return best;
}

export function nextSlot(schedule: TargetRow['schedule'], kind: 'full' | 'incremental', now: Date): Date | null {
  // The next slot is the last slot of a moment a bit later; search ahead hour by hour for at most 8 days.
  const current = lastSlot(schedule, kind, now);
  for (let h = 1; h <= 8 * 24 + 1; h++) {
    const s = lastSlot(schedule, kind, new Date(now.getTime() + h * 3600_000));
    if (s && (!current || s > current) && s > now) return s;
  }
  return null;
}

/** Queues the backups whose time has come. Runs every minute in the API. */
export async function tickScheduler(ctx: AppContext, now = new Date()) {
  const targets = await ctx.db.select().from(schema.backupTargets).where(eq(schema.backupTargets.enabled, true));
  let queued = 0;
  for (const t of targets) {
    const since = t.updatedAt;
    const full = lastSlot(t.schedule, 'full', now);
    const incr = lastSlot(t.schedule, 'incremental', now);
    const fullDue = full && full > since && (!t.lastFullSlotAt || full > t.lastFullSlotAt);
    const incrDue = incr && incr > since && (!t.lastIncrementalSlotAt || incr > t.lastIncrementalSlotAt);
    if (!fullDue && !incrDue) continue;
    const kind = fullDue ? 'full' : 'incremental';
    // Claim the slot first, so two processes never queue the same run.
    const claim = fullDue
      ? or(isNull(schema.backupTargets.lastFullSlotAt), lt(schema.backupTargets.lastFullSlotAt, full!))
      : or(isNull(schema.backupTargets.lastIncrementalSlotAt), lt(schema.backupTargets.lastIncrementalSlotAt, incr!));
    const set = fullDue ? { lastFullSlotAt: full!, ...(incrDue ? { lastIncrementalSlotAt: incr! } : {}) } : { lastIncrementalSlotAt: incr! };
    const claimed = await ctx.db.update(schema.backupTargets).set(set).where(and(eq(schema.backupTargets.id, t.id), claim)).returning({ id: schema.backupTargets.id });
    if (!claimed.length) continue;
    const [busy] = await ctx.db
      .select({ id: schema.backupRuns.id })
      .from(schema.backupRuns)
      .where(and(eq(schema.backupRuns.targetId, t.id), eq(schema.backupRuns.state, 'queued')));
    if (busy) continue; // the previous run has not even started; do not pile up
    await queueRun(ctx, t, kind, 'schedule', null, null, false);
    queued++;
  }
  if (queued) await kickWorker(ctx);
  return queued;
}
