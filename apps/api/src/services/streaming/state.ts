import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { NodeStatus } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { conflict } from '../../lib/errors.js';
import { autodjScriptPath, renderScript, scriptHash } from '../autodj/liquidsoap.js';
import { autodjActive, autodjSettings } from '../autodj/settings.js';
import { relaysByStation } from '../nodes/plan.js';
import { ingestNodes, ingestsOf, stationRouting } from '../nodes/routing-rules.js';
import { getSetting, type StreamingSettings } from '../settings.js';
import { fetchStats, icecastConfigPath, icecastPidPath, mediaDir, renderIcecastConfig, stationDir, type MountStats } from './icecast.js';
import { renderSftpgoEnv } from './sftpgo.js';
import { workerStatusPath, workerStatusSchema, type WorkerStatus } from './status.js';

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
let internalCache: { at: number; value: WorkerStatus['internal'] } | null = null;

/** Readers per station and mount that belong to the streams service, from its status file (cached briefly). */
async function internalReaderCounts(ctx: AppContext): Promise<WorkerStatus['internal']> {
  if (internalCache && Date.now() - internalCache.at < 2000) return internalCache.value;
  let value: WorkerStatus['internal'] = {};
  try {
    const w = workerStatusSchema.parse(JSON.parse(await readFile(workerStatusPath(ctx), 'utf8')));
    if (Date.now() - new Date(w.updatedAt).getTime() < 30_000) value = w.internal;
  } catch {
    /* the streams service is not running */
  }
  internalCache = { at: Date.now(), value };
  return value;
}

/** Live mounts of a station with their listeners, not counting the transcoders and relays reading them. */
export async function stationStats(ctx: AppContext, station: Station): Promise<MountStats[] | null> {
  if (station.nodeId) return nodeStationStats(station);
  const routing = stationRouting(station);
  const nodes = ingestNodes(routing);
  if (nodes.length) {
    // Ingest nodes (phase 13): the mounts of the best ingest that is on air, this server's own one included.
    const rows = await ctx.db.select({ id: schema.nodes.id, status: schema.nodes.status }).from(schema.nodes).where(inArray(schema.nodes.id, nodes.map((n) => n.ref)));
    const fresh = (st: NodeStatus | undefined) => !!st?.online && (!st.updatedAt || Date.now() - new Date(st.updatedAt).getTime() < 30_000);
    for (const i of ingestsOf(routing)) {
      if (i.ref === 'local') {
        const own = await localStats(ctx, station);
        if (own?.length) return own;
        continue;
      }
      const st = rows.find((r) => r.id === i.ref)?.status;
      const list = fresh(st) ? (st!.ingest ?? []).filter((m) => m.stationId === station.id) : [];
      if (list.length) return list.map((m) => ({ mount: m.mount, listeners: 0, listenerPeak: 0, title: m.title, bitrateKbps: m.bitrateKbps, contentType: m.contentType, sourceIp: null, userAgent: null, streamStart: null, bytesRead: 0, bytesSent: 0 }));
    }
    return [];
  }
  return localStats(ctx, station);
}

async function localStats(ctx: AppContext, station: Station): Promise<MountStats[] | null> {
  try {
    const [stats, internal] = await Promise.all([
      fetchStats({ port: station.icecastPort, adminPassword: ctx.box.decrypt(station.icecastAdminPassword) }),
      internalReaderCounts(ctx),
    ]);
    const mine = internal[station.id] ?? {};
    return stats.map((s) => ({ ...s, listeners: Math.max(0, s.listeners - (mine[s.mount] ?? 0)) }));
  } catch {
    return null;
  }
}

/** Live mounts of a station on a station node, as the node last reported them (null when it has been quiet for a minute). */
export function nodeStationStats(station: Station): MountStats[] | null {
  const r = station.nodeRuntime;
  if (!r || Date.now() - new Date(r.updatedAt).getTime() > 60_000) return null;
  return r.mounts.map((m) => ({
    mount: m.mount,
    listeners: m.listeners,
    listenerPeak: m.listenerPeak ?? m.listeners,
    title: m.title,
    bitrateKbps: m.bitrateKbps,
    contentType: m.contentType,
    sourceIp: null,
    userAgent: null,
    streamStart: m.streamStart ?? null,
    bytesRead: 0,
    bytesSent: 0,
  }));
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
    listenerHook: (await listenerHooksEnabled(ctx)) ? ctx.config.LISTENER_HOOK_URL.replace(/\/$/, '') : null,
  });
  await writeAutodjScript(ctx, station, mounts);
  const path = icecastConfigPath(ctx, station.id);
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current === body) return;
  await writeAtomic(path, body);
  await signalIcecast(ctx, station.id, 'SIGHUP');
}

/**
 * Whether this server runs the station's Icecast and AutoDJ: it is not on a station node, or it is moving back and this
 * server warms up before it takes over (so the streams are on air at the switch).
 */
export function runsHere(station: Station) {
  return !station.nodeId || (station.nodeMove?.direction === 'to_main' && station.nodeMove.warm === true);
}

/** The AutoDJ mount of a station whose AutoDJ plays, or null. */
export function autodjMount(station: Station, mounts: Mount[]) {
  if (!autodjActive(station)) return null;
  const id = autodjSettings(station).mountId;
  return mounts.find((m) => m.id === id && m.kind === 'source') ?? null;
}

/** Writes (or removes) the Liquidsoap script of the station's AutoDJ; the system helper (re)starts the player. */
async function writeAutodjScript(ctx: AppContext, station: Station, mounts: Mount[]) {
  const path = autodjScriptPath(ctx, station.id);
  const mount = runsHere(station) ? autodjMount(station, mounts) : null;
  if (!mount) {
    await rm(path, { force: true });
    return;
  }
  const body = renderScript(ctx, { station, mount, settings: autodjSettings(station), sourcePassword: ctx.box.decrypt(station.icecastSourcePassword) });
  if ((await readFile(path, 'utf8').catch(() => null)) !== body) await writeAtomic(path, body);
}

/** The hooks are only switched on once the web server forwards them (marker written by hrs-proxy-apply). */
export async function listenerHooksEnabled(ctx: AppContext) {
  if (ctx.config.LISTENER_HOOKS !== 'auto') return ctx.config.LISTENER_HOOKS === 'on';
  return (await readFile(ctx.config.CADDYFILE, 'utf8').catch(() => '')).includes('hosted-radio-hooks');
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
  /** Stations whose AutoDJ plays, with a hash of its script (a new hash restarts the player). */
  autodj: { id: string; hash: string }[];
  /** SMB and NFS shares to mount read-only under stations/<station>/sources/<source>. */
  mediaMounts: MediaMountState[];
}

export interface MediaMountState {
  id: string;
  stationId: string;
  type: 'smb' | 'nfs';
  host: string;
  /** smb: share[/folder]; nfs: exported path. */
  path: string;
  version: string;
  /** smb: the credentials file the API wrote (run/media-credentials/<id>). */
  credentials: boolean;
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
  // Relay nodes pull their streams from the listen routes too.
  const listening = new Set([...localOutputs.map((o) => o.stationId), ...(await relaysByStation(ctx)).keys()]);
  const domains = await ctx.db
    .select({ ingestHost: schema.tenantDomains.ingestHost, panelHost: schema.tenantDomains.panelHost, ingestNodeId: schema.tenantDomains.ingestNodeId })
    .from(schema.tenantDomains)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantDomains.tenantId))
    .where(and(eq(schema.tenantDomains.status, 'verified'), eq(schema.tenants.active, true)));

  // A station on a station node runs there; its server here stays off.
  const enabled = (r: (typeof stations)[number]) => r.s.enabled && r.tenantActive && runsHere(r.s);
  const sftpgoEnv = await renderSftpgoEnv(ctx, streaming);
  const autodj: StreamsState['autodj'] = [];
  for (const r of stations) {
    if (!enabled(r) || !autodjMount(r.s, mounts.filter((m) => m.stationId === r.s.id))) continue;
    const body = await readFile(autodjScriptPath(ctx, r.s.id), 'utf8').catch(() => null);
    if (body) autodj.push({ id: r.s.id, hash: scriptHash(body) });
  }
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
    // Encoder names routed to a source node get their certificate on that node.
    certHosts: proxy.mode === 'builtin' ? [...new Set([proxy.domain, ...domains.filter((d) => !d.ingestNodeId).map((d) => d.ingestHost)].filter(Boolean))].sort() : [],
    defaultCertHost: proxy.mode === 'builtin' && proxy.domain ? proxy.domain : null,
    sftpgo: { enabled: streaming.sftp.enabled || streaming.ftp.enabled, hash: createHash('sha256').update(sftpgoEnv).digest('hex').slice(0, 16) },
    autodj,
    mediaMounts: await writeMediaMounts(ctx, stations.filter(enabled).map((r) => r.s)),
  };
}

/**
 * The shares of Radio stations, for the system helper. SMB passwords go into one file per share that only this user
 * can read; the helper copies it before mounting. Files of shares that are gone are removed.
 */
async function writeMediaMounts(ctx: AppContext, active: Station[]): Promise<MediaMountState[]> {
  const ids = active.filter((s) => s.edition === 'station').map((s) => s.id);
  const sources = ids.length
    ? await ctx.db
        .select()
        .from(schema.mediaSources)
        .where(and(inArray(schema.mediaSources.stationId, ids), eq(schema.mediaSources.enabled, true), inArray(schema.mediaSources.type, ['smb', 'nfs'])))
    : [];
  const dir = join(ctx.config.DATA_DIR, 'run', 'media-credentials');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const out: MediaMountState[] = [];
  for (const src of sources) {
    const c = src.config;
    if (!c.host) continue;
    const smb = src.type === 'smb';
    const credentials = smb && !!c.username;
    if (credentials) {
      const pass = c.password ? ctx.box.decrypt(c.password) : '';
      const body = [`username=${c.username}`, `password=${pass}`, c.domain ? `domain=${c.domain}` : ''].filter(Boolean).join('\n') + '\n';
      await writeAtomic(join(dir, src.id), body);
    }
    out.push({ id: src.id, stationId: src.stationId, type: src.type as 'smb' | 'nfs', host: c.host, path: (smb ? c.share : c.export) ?? '', version: c.version ?? '', credentials });
  }
  const keep = new Set(out.filter((m) => m.credentials).map((m) => m.id));
  for (const f of await readdir(dir).catch(() => [] as string[])) if (!keep.has(f)) await rm(join(dir, f), { force: true });
  return out;
}

/**
 * Brings the system in line with the database after a change: icecast.xml of the given stations, the SFTPGo settings,
 * a notification for the streams service and a request for the root helper (start/stop servers, web server routes,
 * certificates).
 */
export async function applyStreams(ctx: AppContext, opts: { stationIds?: string[]; by?: string } = {}): Promise<string | null> {
  for (const id of opts.stationIds ?? []) await writeStationConfig(ctx, id);
  const streaming = await getSetting(ctx, 'streaming');
  const run = join(ctx.config.DATA_DIR, 'run');
  await mkdir(run, { recursive: true });
  await mkdir(join(ctx.config.DATA_DIR, 'sftpgo'), { recursive: true });
  await writeAtomic(join(ctx.config.DATA_DIR, 'sftpgo', 'sftpgo.env'), await renderSftpgoEnv(ctx, streaming));
  const state = await buildStreamsState(ctx);
  await writeAtomic(join(run, 'streams-state.json'), JSON.stringify(state, null, 2), 0o640);
  await ctx.db.execute(sql`select pg_notify(${STREAMS_CHANNEL}, ${JSON.stringify({ stationIds: opts.stationIds ?? [] })})`);
  if (ctx.config.SYSTEM_HELPERS !== '1') return null;
  const id = randomBytes(8).toString('hex');
  await writeAtomic(join(run, 'streams-request.json'), JSON.stringify({ id, requestedBy: opts.by ?? 'system', at: state.generatedAt }), 0o640);
  return id;
}

/**
 * Waits until the root helper has carried out a request of applyStreams (or the time is up), e.g. so a deleted
 * station's players are stopped before its files go.
 */
export async function waitForApply(ctx: AppContext, id: string | null, timeoutMs = 30_000) {
  if (!id) return;
  const path = join(ctx.config.DATA_DIR, 'run', 'streams-apply-status.json');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const a = await readFile(path, 'utf8').then((x) => JSON.parse(x) as { id?: string; state?: string }, () => null);
    if (a?.id === id && a.state !== 'running') return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Rewrites every station's configuration, e.g. after the platform host name changed or on start of the API. */
export async function applyAllStreams(ctx: AppContext, by = 'system') {
  const ids = (await ctx.db.select({ id: schema.stations.id }).from(schema.stations)).map((r) => r.id);
  await applyStreams(ctx, { stationIds: ids, by });
}
