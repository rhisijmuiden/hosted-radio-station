import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { conflict } from '../../lib/errors.js';
import { getSetting, type StreamingSettings } from '../settings.js';
import { fetchStats, icecastConfigPath, icecastPidPath, mediaDir, renderIcecastConfig, stationDir, type MountStats } from './icecast.js';
import { renderSftpgoEnv } from './sftpgo.js';

export type Station = typeof schema.stations.$inferSelect;
export type Mount = typeof schema.stationMounts.$inferSelect;
export type Output = typeof schema.stationOutputs.$inferSelect;

/** Channel the API notifies when stations change; the streams service reloads its state on it. */
export const STREAMS_CHANNEL = 'hrs_streams';

export const newInternalPassword = () => randomBytes(18).toString('base64url');

/** Host name of the platform itself: the web server domain, else the CNAME target, else the address in PUBLIC_URL. */
export async function platformHost(ctx: AppContext, streaming?: StreamingSettings) {
  const [proxy, s] = await Promise.all([getSetting(ctx, 'proxy'), streaming ?? getSetting(ctx, 'streaming')]);
  return proxy.domain || s.cnameTarget || new URL(ctx.config.PUBLIC_URL).hostname;
}

/** Lowest free port in a range, in steps (legacy Shoutcast ports come in pairs). */
export async function allocatePort(ctx: AppContext, column: 'icecastPort' | 'legacyPort', from: number, to: number, step = 1) {
  const rows = await ctx.db.select({ p: schema.stations[column] }).from(schema.stations);
  const used = new Set<number>();
  for (const r of rows) if (r.p) for (let i = 0; i < step; i++) used.add(r.p + i);
  for (let p = from; p + step - 1 <= to; p += step) {
    let free = true;
    for (let i = 0; i < step; i++) if (used.has(p + i)) free = false;
    if (free) return p;
  }
  throw conflict('No free port left in the configured range; widen it under Settings → Streaming');
}

/** Live mounts of a station, or null when its Icecast server does not answer. */
export async function stationStats(ctx: AppContext, station: Station): Promise<MountStats[] | null> {
  try {
    return await fetchStats({ port: station.icecastPort, adminPassword: ctx.box.decrypt(station.icecastAdminPassword) });
  } catch {
    return null;
  }
}

export async function loadStation(ctx: AppContext, stationId: string) {
  const [station] = await ctx.db.select().from(schema.stations).where(eq(schema.stations.id, stationId));
  if (!station) return null;
  const [mounts, outputs] = await Promise.all([
    ctx.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, stationId)).orderBy(asc(schema.stationMounts.sortOrder), asc(schema.stationMounts.createdAt)),
    ctx.db.select().from(schema.stationOutputs).where(eq(schema.stationOutputs.stationId, stationId)).orderBy(asc(schema.stationOutputs.createdAt)),
  ]);
  return { station, mounts, outputs };
}

async function writeAtomic(path: string, data: string, mode = 0o600) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

/** Writes icecast.xml and asks a running server to reload it (SIGHUP keeps listeners connected). */
export async function writeStationConfig(ctx: AppContext, stationId: string) {
  const loaded = await loadStation(ctx, stationId);
  if (!loaded) return;
  const { station, mounts, outputs } = loaded;
  const dir = stationDir(ctx, station.id);
  await mkdir(join(dir, 'logs'), { recursive: true });
  await mkdir(mediaDir(ctx, station.id), { recursive: true, mode: 0o775 });
  const internalClients = mounts.filter((m) => m.kind === 'transcode').length + outputs.filter((o) => o.type !== 'local').length + 2;
  const body = renderIcecastConfig(ctx, {
    station,
    mounts,
    hostname: await platformHost(ctx),
    adminPassword: ctx.box.decrypt(station.icecastAdminPassword),
    sourcePassword: ctx.box.decrypt(station.icecastSourcePassword),
    internalClients,
  });
  const path = icecastConfigPath(ctx, station.id);
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current === body) return;
  await writeAtomic(path, body);
  await signalIcecast(ctx, station.id, 'SIGHUP');
}

async function signalIcecast(ctx: AppContext, stationId: string, signal: NodeJS.Signals) {
  try {
    const pid = Number((await readFile(icecastPidPath(ctx, stationId), 'utf8')).trim());
    if (pid > 1) process.kill(pid, signal);
  } catch {
    /* not running (yet); the system helper starts it */
  }
}

export interface StreamsState {
  generatedAt: string;
  stations: { id: string; slug: string; port: number; enabled: boolean }[];
  /** Web server routes /listen/<slug>/<mount> → the station's Icecast server. */
  listen: { slug: string; port: number; mounts: string[] }[];
  /** Names the system helper fetches certificates for, for TLS on the ingest gateway and FTPS. */
  certHosts: string[];
  /** Certificate used for TLS clients without a known name, and for FTPS. */
  defaultCertHost: string | null;
  sftpgo: { enabled: boolean; hash: string };
}

/** Everything the root helper needs, in one file it can validate. */
export async function buildStreamsState(ctx: AppContext): Promise<StreamsState> {
  const streaming = await getSetting(ctx, 'streaming');
  const proxy = await getSetting(ctx, 'proxy');
  const stations = await ctx.db
    .select({ s: schema.stations, tenantActive: schema.tenants.active })
    .from(schema.stations)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
    .orderBy(asc(schema.stations.slug));
  const ids = stations.map((r) => r.s.id);
  const mounts = ids.length ? await ctx.db.select().from(schema.stationMounts).where(inArray(schema.stationMounts.stationId, ids)) : [];
  const localOutputs = ids.length
    ? await ctx.db
        .select({ stationId: schema.stationOutputs.stationId })
        .from(schema.stationOutputs)
        .where(and(inArray(schema.stationOutputs.stationId, ids), eq(schema.stationOutputs.type, 'local'), eq(schema.stationOutputs.enabled, true)))
    : [];
  const listening = new Set(localOutputs.map((o) => o.stationId));
  const domains = await ctx.db
    .select({ ingestHost: schema.tenantDomains.ingestHost, panelHost: schema.tenantDomains.panelHost })
    .from(schema.tenantDomains)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantDomains.tenantId))
    .where(and(eq(schema.tenantDomains.status, 'verified'), eq(schema.tenants.active, true)));

  const enabled = (r: (typeof stations)[number]) => r.s.enabled && r.tenantActive;
  const sftpgoEnv = await renderSftpgoEnv(ctx, streaming);
  return {
    generatedAt: new Date().toISOString(),
    stations: stations.map((r) => ({ id: r.s.id, slug: r.s.slug, port: r.s.icecastPort, enabled: enabled(r) })),
    listen: stations
      .filter((r) => enabled(r) && listening.has(r.s.id))
      .map((r) => ({
        slug: r.s.slug,
        port: r.s.icecastPort,
        mounts: mounts.filter((m) => m.stationId === r.s.id && m.isPublic).map((m) => m.path).sort(),
      }))
      .filter((l) => l.mounts.length > 0),
    certHosts: proxy.mode === 'builtin' ? [...new Set([proxy.domain, ...domains.map((d) => d.ingestHost)].filter(Boolean))].sort() : [],
    defaultCertHost: proxy.mode === 'builtin' && proxy.domain ? proxy.domain : null,
    sftpgo: { enabled: streaming.sftp.enabled || streaming.ftp.enabled, hash: createHash('sha256').update(sftpgoEnv).digest('hex').slice(0, 16) },
  };
}

/**
 * Brings the system in line with the database after a change: icecast.xml of the given stations, the SFTPGo settings,
 * a notification for the streams service and a request for the root helper (start/stop servers, web server routes,
 * certificates).
 */
export async function applyStreams(ctx: AppContext, opts: { stationIds?: string[]; by?: string } = {}) {
  for (const id of opts.stationIds ?? []) await writeStationConfig(ctx, id);
  const streaming = await getSetting(ctx, 'streaming');
  const run = join(ctx.config.DATA_DIR, 'run');
  await mkdir(run, { recursive: true });
  await mkdir(join(ctx.config.DATA_DIR, 'sftpgo'), { recursive: true });
  await writeAtomic(join(ctx.config.DATA_DIR, 'sftpgo', 'sftpgo.env'), await renderSftpgoEnv(ctx, streaming));
  const state = await buildStreamsState(ctx);
  await writeAtomic(join(run, 'streams-state.json'), JSON.stringify(state, null, 2), 0o640);
  await ctx.db.execute(sql`select pg_notify(${STREAMS_CHANNEL}, ${JSON.stringify({ stationIds: opts.stationIds ?? [] })})`);
  if (ctx.config.SYSTEM_HELPERS === '1') {
    await writeAtomic(join(run, 'streams-request.json'), JSON.stringify({ id: randomBytes(8).toString('hex'), requestedBy: opts.by ?? 'system', at: state.generatedAt }), 0o640);
  }
}

/** Rewrites every station's configuration, e.g. after the platform host name changed or on start of the API. */
export async function applyAllStreams(ctx: AppContext, by = 'system') {
  const ids = (await ctx.db.select({ id: schema.stations.id }).from(schema.stations)).map((r) => r.id);
  await applyStreams(ctx, { stationIds: ids, by });
}
