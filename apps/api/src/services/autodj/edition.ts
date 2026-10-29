import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { and, count, eq, ne } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { mayPlace } from '../nodes/dedication.js';
import { getSetting } from '../settings.js';
import { mediaDir } from '../streaming/icecast.js';
import type { Station } from '../streaming/state.js';

type Tenant = typeof schema.tenants.$inferSelect;
type Node = typeof schema.nodes.$inferSelect;
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
