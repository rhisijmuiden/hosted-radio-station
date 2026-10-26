import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import { pushedRouting, stationRouting } from '../nodes/routing-rules.js';
import { cachedRelays } from '../nodes/routing.js';
import { getSetting } from '../settings.js';
import type { AppContext } from '../../lib/context.js';
import { libraryRequests } from '../autodj/requests.js';
import { publicShows, scheduleIsPublic, type PublicShow } from '../scheduler/public.js';
import { CONTENT_TYPES } from '../streaming/icecast.js';
import { connectionInfo } from '../streaming/info.js';
import { stationStats, type Mount, type Station } from '../streaming/state.js';
import { splitTitle, type ArtworkFinder } from './artwork.js';
import { publicSettings, type PublicPageSettings } from './settings.js';

export interface Song {
  /** The title as the encoder sends it, usually "Artist - Title". */
  text: string;
  artist: string | null;
  title: string;
  artworkUrl: string | null;
}

export interface NowPlaying {
  station: {
    name: string;
    slug: string;
    description: string;
    genre: string;
    website: string;
    logoUrl: string | null;
    pageUrl: string;
    accentColor: string;
    theme: PublicPageSettings['theme'];
    links: Partial<PublicPageSettings['links']>;
  };
  /** A mount is on air. */
  onAir: boolean;
  /** A DJ is connected (live broadcast). */
  live: { dj: string; since: string } | null;
  song: (Song & { startedAt: string | null }) | null;
  listeners: number | null;
  mounts: { path: string; name: string; format: string; contentType: string; bitrateKbps: number; isDefault: boolean; live: boolean; listenUrl: string | null }[];
  history: (Song & { playedAt: string })[];
  requests: { enabled: boolean; open: boolean; message: string; library: boolean };
  onDemand: { enabled: boolean };
  /** The station's schedule (phase 7): the block or show on air now, when it is public. */
  schedule: { enabled: boolean; show: PublicShow | null };
  updatedAt: string;
}

export type PublicStation = Station & { settings: PublicPageSettings };

/** Loads an enabled station of an active customer by its short name, or null. */
export async function findPublicStation(ctx: AppContext, slug: string): Promise<PublicStation | null> {
  const [row] = await ctx.db
    .select({ station: schema.stations, tenantActive: schema.tenants.active })
    .from(schema.stations)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
    .where(eq(schema.stations.slug, slug.toLowerCase()));
  if (!row || !row.station.enabled || !row.tenantActive) return null;
  const settings = publicSettings(row.station);
  return { ...row.station, settings };
}

/** The mount whose title is the station's now playing: the source of the default mount (converted mounts carry no title of their own). */
export function titleMount(mounts: Mount[]): Mount | null {
  const visible = mounts.filter((m) => m.isPublic);
  const def = visible.find((m) => m.isDefault) ?? visible[0] ?? mounts.find((m) => m.kind === 'source') ?? null;
  if (!def) return null;
  if (def.kind === 'transcode' && def.sourceMountId) return mounts.find((m) => m.id === def.sourceMountId) ?? def;
  return def;
}

export const publicBase = async (ctx: AppContext, station: Station) =>
  (await connectionInfo(ctx, station, [], false)).listenBase;

export async function songOf(ctx: AppContext, artwork: ArtworkFinder | null, base: string, text: string, enabled: boolean): Promise<Song> {
  const { artist, title } = splitTitle(text);
  const file = enabled && artwork ? await artwork.get(text).catch(() => null) : null;
  return { text, artist, title, artworkUrl: file ? `${base}/api/public/artwork/${file}` : null };
}

/** The mount and the mounts down its fallback chain (e.g. /live, then /autodj): what its listeners hear. */
export function heardMounts(mounts: Mount[], mount: Mount | null): string[] {
  const byId = new Map(mounts.map((m) => [m.id, m]));
  const out: string[] = [];
  for (let cur: Mount | undefined = mount ?? undefined, i = 0; cur && i < 20; i++) {
    if (!out.includes(cur.path)) out.push(cur.path);
    cur = cur.fallbackMountId ? byId.get(cur.fallbackMountId) : undefined;
  }
  return out;
}

/** Recently played titles of a station (newest first), without the one playing now, over the given mounts. */
export async function recentlyPlayed(ctx: AppContext, artwork: ArtworkFinder | null, station: PublicStation, base: string, limit: number, mountPath: string | string[] | null) {
  const paths = (Array.isArray(mountPath) ? mountPath : [mountPath]).filter((p): p is string => !!p);
  if (!paths.length) return [];
  const rows = await ctx.db
    .select({ title: schema.songPlays.title, startedAt: schema.songPlays.startedAt })
    .from(schema.songPlays)
    .where(and(eq(schema.songPlays.stationId, station.id), inArray(schema.songPlays.mountPath, paths), isNotNull(schema.songPlays.endedAt)))
    .orderBy(desc(schema.songPlays.startedAt))
    .limit(limit * 2);
  const out: (Song & { playedAt: string })[] = [];
  for (const r of rows) {
    // The same title twice in a row is one play (an encoder that resent its title).
    if (out.at(-1)?.text === r.title) continue;
    out.push({ ...(await songOf(ctx, artwork, base, r.title, station.settings.artwork)), playedAt: r.startedAt.toISOString() });
    if (out.length >= limit) break;
  }
  return out;
}

/** Everything a player or a public page shows about a station right now. */
export async function buildNowPlaying(ctx: AppContext, station: PublicStation, artwork: ArtworkFinder | null): Promise<NowPlaying> {
  const s = station.settings;
  const [mounts, outputs, stats] = await Promise.all([
    ctx.db.select().from(schema.stationMounts).where(eq(schema.stationMounts.stationId, station.id)).orderBy(asc(schema.stationMounts.sortOrder), asc(schema.stationMounts.createdAt)),
    ctx.db.select().from(schema.stationOutputs).where(eq(schema.stationOutputs.stationId, station.id)),
    stationStats(ctx, station),
  ]);
  const local = outputs.some((o) => o.type === 'local' && o.enabled);
  const conn = await connectionInfo(ctx, station, mounts, local);
  const base = conn.listenBase;
  const byPath = new Map((stats ?? []).map((x) => [x.mount, x]));
  const visible = mounts.filter((m) => m.isPublic);
  const def = visible.find((m) => m.isDefault) ?? visible[0];
  const source = titleMount(mounts);

  // The title comes from the source of the default mount; otherwise from any source mount that has one.
  const sourceStats = (source && byPath.get(source.path)) || mounts.filter((m) => m.kind === 'source').map((m) => byPath.get(m.path)).find((x) => x?.title);
  const text = sourceStats?.title?.trim() || null;
  const playMount = sourceStats?.mount ?? source?.path ?? null;

  const [play, session] = await Promise.all([
    text && playMount
      ? ctx.db
          .select({ startedAt: schema.songPlays.startedAt, title: schema.songPlays.title })
          .from(schema.songPlays)
          .where(and(eq(schema.songPlays.stationId, station.id), eq(schema.songPlays.mountPath, playMount), isNull(schema.songPlays.endedAt)))
          .orderBy(desc(schema.songPlays.startedAt))
          .limit(1)
          .then((r) => r[0])
      : undefined,
    ctx.db
      .select({ accountName: schema.liveSessions.accountName, startedAt: schema.liveSessions.startedAt, mountPath: schema.liveSessions.mountPath })
      .from(schema.liveSessions)
      .where(and(eq(schema.liveSessions.stationId, station.id), isNull(schema.liveSessions.endedAt)))
      .orderBy(desc(schema.liveSessions.startedAt))
      .then((rows) => rows.find((r) => r.mountPath === playMount) ?? rows[0]),
  ]);

  const onAir = visible.some((m) => byPath.has(m.path));
  // Relay nodes: their listeners count too, and players go through the redirect that picks the nearest relay.
  const [relays, nodeSettings] = await Promise.all([cachedRelays(ctx).then((r) => r.get(station.id) ?? []), getSetting(ctx, 'nodes')]);
  const relayListeners = relays.reduce((n, r) => n + (r.status.online ? (r.status.relays ?? []).filter((x) => x.key.startsWith(`${station.slug}/`)).reduce((a, x) => a + (x.listeners ?? 0), 0) : 0), 0);
  // A station with an ingest node has no audio on this server: its listeners always go to a relay.
  const routed = pushedRouting(stationRouting(station)) || (nodeSettings.routeListeners && relays.length > 0);
  const listeners =
    (stats ?? []).reduce((n, x) => n + x.listeners, 0) +
    outputs.reduce((n, o) => n + (o.type !== 'local' && o.enabled && o.status?.listeners ? o.status.listeners : 0), 0) +
    relayListeners;
  const links = Object.fromEntries(Object.entries(s.links).filter(([, v]) => v)) as NowPlaying['station']['links'];
  const requestsOpen = s.requests.enabled && (!s.requests.onlyWhenLive || !!session);

  return {
    station: {
      name: station.name,
      slug: station.slug,
      description: station.description,
      genre: station.genre,
      website: station.website,
      logoUrl: station.logoFile ? `${base}/api/public/stations/${station.slug}/logo?v=${encodeURIComponent(station.logoFile)}` : null,
      pageUrl: `${base}/public/${station.slug}`,
      accentColor: s.accentColor,
      theme: s.theme,
      links,
    },
    onAir,
    live: session ? { dj: session.accountName, since: session.startedAt.toISOString() } : null,
    song: text ? { ...(await songOf(ctx, artwork, base, text, s.artwork)), startedAt: play && play.title === text ? play.startedAt.toISOString() : null } : null,
    listeners: s.showListeners ? listeners : null,
    mounts: visible.map((m) => ({
      path: m.path,
      name: m.name,
      format: m.format,
      contentType: CONTENT_TYPES[m.format],
      bitrateKbps: m.bitrateKbps,
      isDefault: m === def,
      live: byPath.has(m.path),
      listenUrl: routed ? `${base}/api/public/stations/${station.slug}/listen${m.path}` : (conn.mounts.find((c) => c.id === m.id)?.listenUrl ?? null),
    })),
    history: s.showHistory ? await recentlyPlayed(ctx, artwork, station, base, Math.min(s.historyCount, 10), [...new Set([playMount, ...heardMounts(mounts, source)].filter((p): p is string => !!p))]) : [],
    requests: { enabled: s.requests.enabled, open: requestsOpen, message: s.requests.message, library: libraryRequests(station) },
    onDemand: { enabled: s.onDemand.enabled },
    schedule: scheduleIsPublic(station) ? { enabled: true, show: (await publicShows(ctx, station, 1)).onAir } : { enabled: false, show: null },
    updatedAt: new Date().toISOString(),
  };
}
