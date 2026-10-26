import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../../lib/context.js';
import { ArtworkFinder } from './artwork.js';
import { buildNowPlaying, findPublicStation, type NowPlaying } from './nowplaying.js';

/** Channel the streams service notifies (with the station id) when a title, a mount or a live DJ changes. */
export const NOWPLAYING_CHANNEL = 'hrs_nowplaying';

type Listener = (np: NowPlaying | null) => void;

interface Channel {
  stationId: string | null;
  subs: Set<Listener>;
  last: NowPlaying | null;
  lastKey: string;
  at: number;
  building: Promise<NowPlaying | null> | null;
}

const CACHE_MS = 3000;
const REFRESH_MS = 10_000;

/**
 * Now playing for the public pages, widgets and API. Builds it once per station for everybody (cached for a few
 * seconds) and pushes changes to the live feeds (Server-Sent Events and WebSocket) as soon as the streams service
 * reports a new title, and every ten seconds for the listener count.
 */
export class NowPlayingHub {
  readonly artwork: ArtworkFinder;
  private channels = new Map<string, Channel>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.artwork = new ArtworkFinder(ctx);
    // New album art: rebuild the stations that are being watched.
    this.artwork.onFound = () => {
      for (const slug of this.channels.keys()) void this.refresh(slug, true);
    };
  }

  start() {
    this.timer ??= setInterval(() => {
      for (const [slug, ch] of this.channels) {
        if (ch.subs.size) void this.refresh(slug, true);
        else if (Date.now() - ch.at > 60_000) this.channels.delete(slug);
      }
    }, REFRESH_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ch of this.channels.values()) ch.subs.clear();
  }

  private channel(slug: string) {
    let ch = this.channels.get(slug);
    if (!ch) this.channels.set(slug, (ch = { stationId: null, subs: new Set(), last: null, lastKey: '', at: 0, building: null }));
    return ch;
  }

  /** Now playing of a station, or null when it has no public page. */
  async current(slug: string): Promise<NowPlaying | null> {
    const ch = this.channel(slug);
    if (ch.at && Date.now() - ch.at < CACHE_MS) return ch.last;
    return this.refresh(slug, false);
  }

  /** Rebuilds a station's now playing and tells its subscribers when anything changed. */
  refresh(slug: string, push: boolean): Promise<NowPlaying | null> {
    const ch = this.channel(slug);
    ch.building ??= (async () => {
      try {
        const station = await findPublicStation(this.ctx, slug);
        const np = station && station.settings.enabled ? await buildNowPlaying(this.ctx, station, this.artwork) : null;
        ch.stationId = station?.id ?? null;
        const key = np ? JSON.stringify({ ...np, updatedAt: '' }) : 'null';
        const changed = key !== ch.lastKey;
        ch.last = np;
        ch.lastKey = key;
        ch.at = Date.now();
        if (changed && push) for (const fn of ch.subs) fn(np);
        return np;
      } catch (err) {
        this.log.warn({ err, slug }, 'building now playing failed');
        return ch.last;
      } finally {
        ch.building = null;
      }
    })();
    return ch.building;
  }

  /** Called on a notification from the streams service, or after a change in the panel. */
  notify(stationId: string) {
    for (const [slug, ch] of this.channels) if (ch.stationId === stationId) void this.refresh(slug, true);
  }

  /** Follows a station; the callback gets the current state first and then every change. */
  async subscribe(slug: string, fn: Listener) {
    const ch = this.channel(slug);
    ch.subs.add(fn);
    fn(await this.current(slug));
    return () => ch.subs.delete(fn);
  }

  get subscriberCount() {
    let n = 0;
    for (const ch of this.channels.values()) n += ch.subs.size;
    return n;
  }
}
