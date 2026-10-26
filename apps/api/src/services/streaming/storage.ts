import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, isNull, sum } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { mediaDir } from './icecast.js';

/** Total size of the regular files under a folder. Symbolic links are not followed. */
export async function folderSize(path: string): Promise<number> {
  let total = 0;
  let dir;
  try {
    dir = await opendir(path);
  } catch {
    return 0;
  }
  for await (const entry of dir) {
    const p = join(path, entry.name);
    if (entry.isDirectory()) total += await folderSize(p);
    else if (entry.isFile()) total += (await lstat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Measures a station's media folder and stores the result. */
export async function scanStationStorage(ctx: AppContext, stationId: string) {
  const bytes = await folderSize(mediaDir(ctx, stationId));
  await ctx.db.update(schema.stations).set({ storageBytes: bytes, storageScannedAt: new Date() }).where(eq(schema.stations.id, stationId));
  return bytes;
}

export async function scanAllStorage(ctx: AppContext) {
  // A station node reports the size of its stations itself.
  for (const { id } of await ctx.db.select({ id: schema.stations.id }).from(schema.stations).where(isNull(schema.stations.nodeId))) await scanStationStorage(ctx, id);
}

/** Bytes used by all stations of a customer, as last measured. */
export async function tenantStorageUsage(ctx: AppContext, tenantId: string) {
  const [row] = await ctx.db.select({ n: sum(schema.stations.storageBytes) }).from(schema.stations).where(eq(schema.stations.tenantId, tenantId));
  return Number(row?.n ?? 0);
}
