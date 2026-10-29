import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, count, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { mayPlace, serves } from '../nodes/dedication.js';
import { stationRouting } from '../nodes/routing-rules.js';
import { getSetting } from '../settings.js';
import { mediaDir } from '../streaming/icecast.js';
import { applyStreams, type Station } from '../streaming/state.js';

type Tenant = typeof schema.tenants.$inferSelect;
type Node = typeof schema.nodes.$inferSelect;
import { ONDEMAND_FOLDER, RECORDINGS_FOLDER } from '../public/ondemand.js';
import { MUSIC_FOLDER, STORAGE } from './library.js';
import { autodjSettings } from './settings.js';

/**
 * Turns a Distribution station into a Radio station in one go: a private /autodj mount in the format of the default
 * mount, the default mount falls back to it (listeners hear the AutoDJ whenever no DJ is live and move back when one
 * starts), a first playlist with all music, and the AutoDJ switched on. Running it again only repairs what is missing.
 */
export async function upgradeStation(ctx: AppContext, station: Station) {
  await mkdir(join(mediaDir(ctx, station.id), MUSIC_FOLDER), { recursive: true, mode: 0o775 }).catch(() => undefined);
  return ctx.db.transaction(async (tx) => {
    const mounts = await tx.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, station.id));
    const settings = autodjSettings(station);
    let mount = mounts.find((m) => m.id === settings.mountId && m.kind === 'source');
    const visible = mounts.filter((m) => m.isPublic);
    const def = visible.find((m) => m.isDefault) ?? visible[0];
    const listenMount = def?.kind === 'transcode' ? mounts.find((m) => m.id === def.sourceMountId) : def;
    if (!mount) {
      const taken = new Set(mounts.map((m) => m.path));
      let path = '/autodj';
      for (let i = 2; taken.has(path); i++) path = `/autodj${i}`;
      [mount] = await tx
        .insert(schema.stationMounts)
        .values({
          stationId: station.id,
          path,
          name: 'AutoDJ',
          kind: 'source',
          format: listenMount?.format ?? 'mp3',
          bitrateKbps: listenMount?.bitrateKbps ?? 128,
          isPublic: false,
          isDefault: false,
          sortOrder: 900,
        })
        .returning();
    }
    if (listenMount && listenMount.id !== mount!.id && !listenMount.fallbackMountId) {
      await tx.update(schema.stationMounts).set({ fallbackMountId: mount!.id }).where(eq(schema.stationMounts.id, listenMount.id));
    }
    const [{ n }] = (await tx.select({ n: count() }).from(schema.playlists).where(eq(schema.playlists.stationId, station.id))) as [{ n: number }];
    // A station node makes the first playlist itself: playlists belong to the node (phase 12).
    if (n === 0 && !station.nodeId) {
      await tx.insert(schema.playlists).values({ stationId: station.id, name: 'All music', queue: 'q1', weight: 5, order: 'shuffle', folders: [{ location: STORAGE, path: '' }] });
    }
    const [updated] = await tx
      .update(schema.stations)
      .set({ edition: 'station', autodj: { ...settings, enabled: true, mountId: mount!.id }, updatedAt: new Date() })
      .where(eq(schema.stations.id, station.id))
      .returning();
    return { station: updated!, mount: mount! };
  });
}

/** Back to Distribution: the AutoDJ stops; library, playlists and the AutoDJ mount stay for a later upgrade. */
export async function downgradeStation(ctx: AppContext, station: Station) {
  const settings = autodjSettings(station);
  await ctx.db.transaction(async (tx) => {
    if (settings.mountId) {
      // Listeners no longer fall back to a mount that has no source.
      await tx
        .update(schema.stationMounts)
        .set({ fallbackMountId: null })
        .where(and(eq(schema.stationMounts.stationId, station.id), eq(schema.stationMounts.fallbackMountId, settings.mountId)));
    }
    if (!station.nodeId) await tx.delete(schema.queueItems).where(eq(schema.queueItems.stationId, station.id));
    await tx
      .update(schema.stations)
      .set({ edition: 'distribution', autodj: { ...settings, enabled: false }, updatedAt: new Date() })
      .where(eq(schema.stations.id, station.id));
  });
}

/**
 * The edition belongs to each station; a customer has a limit on how many of its stations may be a Radio station.
 * `exceptId`: the station that is being upgraded does not count yet.
 */
export async function assertRadioStationAllowed(ctx: AppContext, tenant: Tenant, exceptId?: string) {
  const max = tenant.limits.maxRadioStations ?? tenant.limits.maxStations;
  const where = and(eq(schema.stations.tenantId, tenant.id), eq(schema.stations.edition, 'station'), exceptId ? ne(schema.stations.id, exceptId) : undefined);
  const [{ n }] = (await ctx.db.select({ n: count() }).from(schema.stations).where(where)) as [{ n: number }];
  if (n >= max) throw badRequest(max === 0 ? 'This customer may only have Distribution stations' : `This customer may have ${max} Radio station(s); this would be one more`);
}

/**
 * Where a Radio station runs: the station node that was chosen, else the customer's station node, else this server
 * (unless it is set to orchestrator only: then a station node must be chosen). Distribution stations never run on a
 * station node. Customers place stations on their own nodes; administrators also on shared ones.
 */
export async function radioStationNode(ctx: AppContext, opts: { tenant: Tenant; stationId: string; nodeId?: string | null; admin: boolean }): Promise<Node | null> {
  const { tenant } = opts;
  const chosen = opts.nodeId ?? tenant.stationNodeId;
  if (chosen) {
    const [node] = await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, chosen));
    const usable = !!node && node.roles.includes('station') && !!node.pairedAt;
    if (usable && (!node.tenantId || node.tenantId === tenant.id)) {
      const all = await ctx.db.select({ id: schema.stations.id, tenantId: schema.stations.tenantId, nodeId: schema.stations.nodeId }).from(schema.stations);
      const allowed = mayPlace(node, { id: opts.stationId, tenantId: tenant.id, nodeId: null }, all);
      if (opts.nodeId) {
        if (!allowed) throw badRequest('This node is dedicated to another customer or station');
        if (!opts.admin && node.tenantId !== tenant.id) throw forbidden('Only administrators can place a station on a shared node');
      }
      if (allowed) return node;
    } else if (opts.nodeId) {
      throw badRequest(node?.tenantId && node.tenantId !== tenant.id ? 'This node belongs to another customer' : 'Choose a paired node with the station node role');
    }
  }
  if ((await getSetting(ctx, 'orchestrator')).only) throw conflict('This server is orchestrator only: a Radio station runs on a station node. Choose the station node it runs on.');
  return null;
}

/**
 * Makes a Distribution station a Radio station, where it should run: on a station node it starts there at once (there
 * is no AutoDJ to hand over; the node takes the tables and files from here), else on this server.
 */
export async function makeRadioStation(ctx: AppContext, station: Station, node: Node | null) {
  // The first playlist is made here (before the station is on its node), so the node takes it with the tables.
  const { station: upgraded } = await upgradeStation(ctx, station);
  if (!node || station.nodeId) return upgraded;
  const [placed] = await ctx.db
    .update(schema.stations)
    .set({ nodeId: node.id, nodeMove: null, nodeRuntime: { updatedAt: new Date().toISOString(), mounts: [], autodj: null, encoders: 0, relays: {}, revision: null, syncedAt: null } })
    .where(eq(schema.stations.id, station.id))
    .returning();
  return placed!;
}

/** How long the content of a Radio station is kept after it went back to Distribution only. */
export const DOWNGRADE_KEEP_MS = 24 * 3600_000;

/**
 * Radio station → Distribution only, the safe way: from now on the station only receives a stream from the customer's
 * own software (AutoDJ, hour clocks, library and DJ logins stop). Its content is kept for 24 hours so the owner can
 * switch back without loss; then purgeDowngrades deletes it. A station on a station node leaves the node (Distribution
 * only never runs on one), which keeps the files and tables, switched off, for those 24 hours. Under "Orchestrator
 * only" its encoders go to an ingest node.
 */
export async function downgradeKeeping(ctx: AppContext, station: Station, by?: string) {
  if (station.nodeId) {
    // A node from before this version would remove the station and its files at once.
    const [node] = await ctx.db.select({ status: schema.nodes.status }).from(schema.nodes).where(eq(schema.nodes.id, station.nodeId));
    const features = node?.status.features;
    if (features && !features.includes('parked-stations')) throw conflict('Update the station node first: this version of it cannot keep the content for 24 hours');
  }
  const r = stationRouting(station);
  let routing: Record<string, unknown> | null = null;
  if (station.nodeId && (await getSetting(ctx, 'orchestrator')).only && (r.ingest === 'local' || r.ingest === station.nodeId)) {
    const ingests = (await ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt)).orderBy(asc(schema.nodes.name))).filter(
      (n) => n.roles.includes('source') && serves(n, { id: station.id, tenantId: station.tenantId }),
    );
    const pick = ingests.find((n) => n.tenantId === station.tenantId) ?? ingests.find((n) => n.status.online) ?? ingests[0];
    if (!pick) throw conflict('This server is orchestrator only and there is no ingest node for the stream; add one under Infrastructure → Nodes first.');
    routing = { ...station.routing, ingest: pick.id };
  }
  await downgradeStation(ctx, station);
  const now = Date.now();
  const downgrade = { at: new Date(now).toISOString(), until: new Date(now + DOWNGRADE_KEEP_MS).toISOString(), nodeId: station.nodeId };
  const [updated] = await ctx.db
    .update(schema.stations)
    .set({ downgrade, ...(routing ? { routing } : {}), ...(station.nodeId ? { nodeId: null, nodeMove: null, nodeRuntime: null } : {}) })
    .where(eq(schema.stations.id, station.id))
    .returning();
  await applyStreams(ctx, { stationIds: [station.id], by });
  return updated!;
}

/**
 * Switching back within the 24 hours: the Radio station returns where it ran, with all its content. On its station
 * node it takes over the tables kept here and the files the node kept.
 */
export async function undoDowngrade(ctx: AppContext, station: Station) {
  const d = station.downgrade;
  if (!d) return null;
  let node: Node | null = null;
  if (d.nodeId) {
    const [n] = await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, d.nodeId));
    if (!n?.pairedAt || !n.roles.includes('station')) throw conflict('The station node it ran on is gone; choose another station node');
    node = n;
  }
  await ctx.db.update(schema.stations).set({ downgrade: null }).where(eq(schema.stations.id, station.id));
  return makeRadioStation(ctx, { ...station, downgrade: null }, node);
}

/** The AutoDJ content of a station: what is deleted 24 hours after it went back to Distribution only. */
const AUTODJ_TABLES = [schema.queueItems, schema.autodjState, schema.scheduleEntries, schema.clocks, schema.playlists, schema.mediaFiles, schema.mediaSources] as const;

/** Deletes the kept content of stations whose 24 hours are over, here and (by dropping it from its package) on their node. */
export async function purgeDowngrades(ctx: AppContext, now = new Date()) {
  const due = await ctx.db.select().from(schema.stations).where(and(isNotNull(schema.stations.downgrade), sql`(${schema.stations.downgrade}->>'until')::timestamptz < ${now.toISOString()}::timestamptz`));
  for (const s of due) {
    // Switched back to Radio station in the meantime: nothing to delete.
    if (s.edition === 'station') {
      await ctx.db.update(schema.stations).set({ downgrade: null }).where(eq(schema.stations.id, s.id));
      continue;
    }
    const settings = autodjSettings(s);
    await ctx.db.transaction(async (tx) => {
      const playlists = await tx.select({ id: schema.playlists.id }).from(schema.playlists).where(eq(schema.playlists.stationId, s.id));
      if (playlists.length) await tx.delete(schema.playlistItems).where(inArray(schema.playlistItems.playlistId, playlists.map((p) => p.id)));
      for (const t of AUTODJ_TABLES) await tx.delete(t).where(eq(t.stationId, s.id));
      // The private AutoDJ mount; upgrading again makes a new one.
      if (settings.mountId) await tx.delete(schema.stationMounts).where(and(eq(schema.stationMounts.id, settings.mountId), eq(schema.stationMounts.stationId, s.id), eq(schema.stationMounts.isPublic, false)));
      await tx.update(schema.stations).set({ downgrade: null, autodj: { ...settings, mountId: null } }).where(eq(schema.stations.id, s.id));
    });
    // The music on this server; on-demand items and recordings stay.
    const root = mediaDir(ctx, s.id);
    const entries = await readdir(root).catch(() => [] as string[]);
    for (const e of entries) if (e !== ONDEMAND_FOLDER && e !== RECORDINGS_FOLDER) await rm(join(root, e), { recursive: true, force: true }).catch(() => undefined);
  }
  if (due.length) await applyStreams(ctx, { stationIds: due.map((s) => s.id), by: 'system' });
  return due.length;
}
