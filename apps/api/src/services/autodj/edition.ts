import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { and, count, eq } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { mediaDir } from '../streaming/icecast.js';
import type { Station } from '../streaming/state.js';
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
    if (n === 0) {
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
    await tx.delete(schema.queueItems).where(eq(schema.queueItems.stationId, station.id));
    await tx
      .update(schema.stations)
      .set({ edition: 'distribution', autodj: { ...settings, enabled: false }, updatedAt: new Date() })
      .where(eq(schema.stations.id, station.id));
  });
}
