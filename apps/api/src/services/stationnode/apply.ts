import { rm } from 'node:fs/promises';
import { and, count, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { schema, type Db } from '../../db/index.js';
import type { OutputConfig } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { STORAGE } from '../autodj/library.js';
import { sealNews } from '../autodj/news.js';
import { stationDir } from '../streaming/icecast.js';
import type { StationPackage } from './package.js';
import { fromWire, upsertRows, type NodeTable, type WireRow } from './tables.js';

/** The tables the main server owns, as far as a station node keeps a copy of them. */
const T = {
  tenants: { name: 'tenants', table: schema.tenants, pk: ['id'], station: null },
  users: { name: 'users', table: schema.users, pk: ['id'], station: null },
  memberships: { name: 'memberships', table: schema.memberships, pk: ['userId', 'tenantId'], station: null },
  apiKeys: { name: 'api_keys', table: schema.apiKeys, pk: ['id'], station: null },
  stations: { name: 'stations', table: schema.stations, pk: ['id'], station: null },
  mounts: { name: 'station_mounts', table: schema.stationMounts, pk: ['id'], station: null },
  outputs: { name: 'station_outputs', table: schema.stationOutputs, pk: ['id'], station: null },
  accounts: { name: 'station_accounts', table: schema.stationAccounts, pk: ['id'], station: null },
  liveTokens: { name: 'studio_live_tokens', table: schema.studioLiveTokens, pk: ['id'], station: null },
} as const satisfies Record<string, NodeTable>;

export interface ApplyResult {
  /** Stations of the package (active or moving). */
  stationIds: string[];
  active: string[];
  moving: string[];
  removed: string[];
}

const ids = (rows: WireRow[]) => rows.map((r) => String(r.id));

/**
 * Makes this station node's copy of the main server's data equal to its package, in one transaction: customers,
 * users, API keys, and per station its settings, mounts, outputs, DJ accounts and Studio tokens. Stations that are
 * no longer in the package are removed here, with their files. A station that is still moving stays switched off.
 */
export async function applyPackage(ctx: AppContext, pkg: StationPackage, ready: (stationId: string) => boolean = () => true): Promise<ApplyResult> {
  const { box } = ctx;
  // The same secret keeps its sealed form: a new one each time would look like a change (and restart the outputs).
  const reseal = (v: unknown, prev: string | undefined | null) => {
    if (typeof v !== 'string' || !v) return undefined;
    if (prev) {
      try {
        if (box.decrypt(prev) === v) return prev;
      } catch {
        /* sealed with another key */
      }
    }
    return box.encrypt(v);
  };
  const wanted = pkg.stations.map((p) => String(p.station.id));
  const result: ApplyResult = {
    stationIds: wanted,
    active: pkg.stations.filter((p) => p.state === 'active').map((p) => String(p.station.id)),
    moving: pkg.stations.filter((p) => p.state === 'moving').map((p) => String(p.station.id)),
    removed: [],
  };

  await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const before = await tx
      .select({ id: schema.stations.id, edition: schema.stations.edition, admin: schema.stations.icecastAdminPassword, source: schema.stations.icecastSourcePassword, news: schema.stations.news })
      .from(schema.stations);
    const prevStation = new Map(before.map((s) => [s.id, s]));
    const prevOutputs = new Map((await tx.select({ id: schema.stationOutputs.id, config: schema.stationOutputs.config }).from(schema.stationOutputs)).map((o) => [o.id, o.config]));
    const prevEdition = new Map(before.map((s) => [s.id, s.edition]));

    // First what is gone, so a new row with the same slug or e-mail address fits.
    result.removed = before.filter((s) => !wanted.includes(s.id)).map((s) => s.id);
    if (result.removed.length) await tx.delete(schema.stations).where(inArray(schema.stations.id, result.removed));
    const tenantIds = ids(pkg.tenants);
    const userIds = ids(pkg.users);
    await tx.delete(schema.tenants).where(tenantIds.length ? notInArray(schema.tenants.id, tenantIds) : sql`true`);
    await tx.delete(schema.users).where(userIds.length ? notInArray(schema.users.id, userIds) : sql`true`);

    await upsertRows(db, T.tenants, pkg.tenants.map((r) => fromWire(T.tenants, r, box)));
    await upsertRows(db, T.users, pkg.users.map((r) => fromWire(T.users, r, box)));
    await tx.delete(schema.memberships);
    await upsertRows(db, T.memberships, pkg.memberships.map((r) => fromWire(T.memberships, r, box)));
    const keys = pkg.apiKeys.filter((k) => !k.tenantId || tenantIds.includes(String(k.tenantId)));
    await tx.delete(schema.apiKeys).where(keys.length ? notInArray(schema.apiKeys.id, ids(keys)) : sql`true`);
    await upsertRows(db, T.apiKeys, keys.map((r) => fromWire(T.apiKeys, r, box)), undefined, ['lastUsedAt']);

    for (const p of pkg.stations) {
      const id = String(p.station.id);
      const station = fromWire(T.stations, p.station, box);
      const prev = prevStation.get(id);
      station.icecastAdminPassword = reseal(p.station.icecastAdminPassword, prev?.admin) ?? prev?.admin ?? box.encrypt(crypto.randomUUID());
      station.icecastSourcePassword = reseal(p.station.icecastSourcePassword, prev?.source) ?? prev?.source ?? box.encrypt(crypto.randomUUID());
      station.news = sealNews(box, (p.station.news as Record<string, unknown> | undefined) ?? {}, prev?.news);
      // A station that is moving here runs only once its library and tables are here (it then warms up while the main
      // server still has it on air), and a station that switched over only once this node took its latest tables.
      const moving = p.state === 'moving';
      if (!ready(id)) station.enabled = false;
      const legacyMountId = station.legacyMountId ?? null;
      station.legacyMountId = null;
      await upsertRows(db, T.stations, [station], undefined, ['storageBytes', 'storageScannedAt']);

      const outputIds = ids(p.outputs);
      await tx.delete(schema.stationOutputs).where(and(eq(schema.stationOutputs.stationId, id), outputIds.length ? notInArray(schema.stationOutputs.id, outputIds) : sql`true`));
      const mountIds = ids(p.mounts);
      await tx.delete(schema.stationMounts).where(and(eq(schema.stationMounts.stationId, id), mountIds.length ? notInArray(schema.stationMounts.id, mountIds) : sql`true`));
      await upsertRows(db, T.mounts, p.mounts.map((r) => fromWire(T.mounts, r, box)));
      await upsertRows(
        db,
        T.outputs,
        p.outputs.map((r) => {
          const o = fromWire(T.outputs, r, box);
          const c = o.config as OutputConfig;
          const was = prevOutputs.get(String(o.id));
          o.config = { ...c, password: reseal(c.password, was?.password), adminPassword: reseal(c.adminPassword, was?.adminPassword) };
          // While the main server still has the station on air, nothing goes out from here.
          if (moving) o.enabled = false;
          return o;
        }),
        undefined,
        ['status'],
      );
      if (legacyMountId) await tx.update(schema.stations).set({ legacyMountId: String(legacyMountId) }).where(eq(schema.stations.id, id));

      const accountIds = ids(p.accounts);
      await tx.delete(schema.stationAccounts).where(and(eq(schema.stationAccounts.stationId, id), accountIds.length ? notInArray(schema.stationAccounts.id, accountIds) : sql`true`));
      await upsertRows(db, T.accounts, p.accounts.map((r) => fromWire(T.accounts, r, box)), undefined, ['lastUsedAt']);
      const tokenIds = ids(p.liveTokens);
      if (accountIds.length) {
        await tx
          .delete(schema.studioLiveTokens)
          .where(and(inArray(schema.studioLiveTokens.accountId, accountIds), tokenIds.length ? notInArray(schema.studioLiveTokens.id, tokenIds) : sql`true`));
      }
      await upsertRows(db, T.liveTokens, p.liveTokens.map((r) => fromWire(T.liveTokens, r, box)));

      // Playlists and the queue belong to the node: it follows an upgrade or downgrade of a running station here.
      const was = prevEdition.get(id);
      const now = p.station.edition;
      if (p.state === 'active' && was && was !== now) {
        if (now === 'station') {
          const [{ n }] = (await tx.select({ n: count() }).from(schema.playlists).where(eq(schema.playlists.stationId, id))) as [{ n: number }];
          if (n === 0) await tx.insert(schema.playlists).values({ stationId: id, name: 'All music', queue: 'q1', weight: 5, order: 'shuffle', folders: [{ location: STORAGE, path: '' }] });
        } else {
          await tx.delete(schema.queueItems).where(eq(schema.queueItems.stationId, id));
        }
      }
    }
  });

  for (const id of result.removed) await rm(stationDir(ctx, id), { recursive: true, force: true }).catch(() => undefined);
  return result;
}
