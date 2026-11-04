import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import net from 'node:net';
import type pino from 'pino';
import { and, eq, gt } from 'drizzle-orm';
import { schema } from '../db/index.js';
import type { AppContext } from '../lib/context.js';
import { autodjSocketPath, autodjToken } from '../services/autodj/liquidsoap.js';
import { cueNow, flushForClock, nextTrack, playerStarted, releaseLoaded, trackStarted } from '../services/autodj/planner.js';
import { autodjSettings } from '../services/autodj/settings.js';
import { stuckSince } from '../services/autodj/stuck.js';
import { studioState, studioStations } from '../services/autodj/studio.js';
import type { LiveBroadcast } from './recorder.js';
import type { Snapshot, StationView } from './snapshot.js';

/**
 * After studio mode the player first drops what it loaded ahead and asks the planner again; it stays held this long, so
 * the next track of the queue is ready when it plays again (and not a track of its emergency playlist).
 */
const RESUME_DELAY_MS = 1500;

/** Channel the API notifies with AutoDJ commands ({ stationId, command: 'skip' }). */
export const AUTODJ_CHANNEL = 'hrs_autodj';

export interface AutodjStatus {
  /** Last time the player asked for a track or reported one. */
  seenAt: string | null;
  /** Held because a DJ is live on a mount that falls back to the AutoDJ. */
  paused: boolean;
  /** The control socket answered at the last check. */
  reachable: boolean;
  /** Manual playout (RHIS Studio) is on. */
  manual?: boolean;
  /** Manual playout: the track ended and the player waits for Play. */
  holding?: boolean;
  /** A studio PC plays the queue (RHIS Studio studio mode). */
  studio?: boolean;
}

/** Sends one command to a station's Liquidsoap over its control socket and returns the answer. */
export function playerCommand(path: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    let out = '';
    const timer = setTimeout(() => socket.destroy(new Error('the player did not answer')), 3000);
    socket.on('connect', () => socket.write(`${command}\nquit\n`));
    socket.on('data', (d) => (out += d.toString()));
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(out.replace(/\r/g, '').split('\nEND')[0]!.trim());
    });
  });
}

/**
 * The streams service's side of the AutoDJ: answers the players' requests for the next track and their track reports
 * (on the hook port, with a per-station token), and holds a player while a DJ is live on a mount that falls back to it.
 */
export class AutodjController {
  private status = new Map<string, AutodjStatus>();
  private sentAt = new Map<string, number>();
  /** Manual playout as last sent to each player. */
  private manualSent = new Map<string, boolean>();
  private lastSnap: Snapshot | null = null;
  /** Hard timed clock items: the cut of the track that plays at their minute. */
  private cuts = new Map<string, NodeJS.Timeout>();
  /** Stuck playout: when each player was last checked, and the track it was skipped past. */
  private stuckCheckedAt = new Map<string, number>();
  private stuckSkipped = new Map<string, string>();
  /**
   * Studio mode (RHIS Studio plays the queue): the stations in it at the last sync, those whose studio broadcast was seen
   * live (from then on the player holds), those held for it, and when a player that hands back may play again.
   */
  private studioOn = new Set<string>();
  private studioLive = new Set<string>();
  private studioHeld = new Set<string>();
  private resumeAt = new Map<string, number>();
  private lastLive: LiveBroadcast[] = [];

  constructor(
    private readonly ctx: AppContext,
    private readonly log: pino.Logger,
  ) {}

  /** Handles /autodj/<station>/(start|next|playing/<item>); returns false for other paths. */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const m = req.url?.match(/^\/autodj\/([0-9a-f-]{36})\/(start|next|playing\/([0-9a-f-]{36}))$/);
    if (!m) return false;
    const stationId = m[1]!;
    const token = Buffer.from(String(req.headers['x-hrs-token'] ?? ''));
    const want = Buffer.from(autodjToken(this.ctx, stationId));
    if (req.method !== 'POST' || token.length !== want.length || !timingSafeEqual(token, want)) {
      res.writeHead(403).end();
      return true;
    }
    req.resume();
    const reply = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
    };
    const seen = () => this.touch(stationId, { seenAt: new Date().toISOString() });
    const work =
      m[2] === 'start'
        ? playerStarted(this.ctx, stationId).then(() => {
            seen();
            // A fresh player does not know whether a DJ is live yet.
            this.sentAt.delete(stationId);
            reply('OK');
          })
        : m[2] === 'next'
          ? this.nextForPlayer(stationId).then((next) => {
              seen();
              if (next?.cutAt) this.scheduleCut(stationId, next.itemId, next.cutAt);
              for (const item of next?.skipped ?? []) this.log.warn({ stationId, item }, 'Clock item skipped: its playlist has no track to play');
              reply(next?.uri ?? '');
            })
          : trackStarted(this.ctx, stationId, m[3]!).then(() => {
              seen();
              reply('OK');
            });
    work.catch((err) => {
      this.log.error({ err, stationId }, 'AutoDJ request failed');
      res.writeHead(500).end();
    });
    return true;
  }

  /** The player's next track; none while a studio PC plays the queue (the player asks again every few seconds). */
  private async nextForPlayer(stationId: string) {
    if ((await studioState(this.ctx, stationId)).active) return null;
    return nextTrack(this.ctx, stationId);
  }

  /**
   * Cuts the playing track at `at`, so the clock item loaded after it (`itemId`) starts on the minute. Nothing happens
   * when that item is no longer waiting by then (skipped, or the player restarted).
   */
  private scheduleCut(stationId: string, itemId: string, at: number) {
    clearTimeout(this.cuts.get(stationId));
    const timer = setTimeout(
      () => {
        this.cuts.delete(stationId);
        void this.ctx.db
          .select({ state: schema.queueItems.state })
          .from(schema.queueItems)
          .where(and(eq(schema.queueItems.id, itemId), eq(schema.queueItems.stationId, stationId)))
          .then(async ([item]) => {
            if (item?.state !== 'cued') return;
            await playerCommand(autodjSocketPath(this.ctx, stationId), 'skip');
            this.log.info({ stationId }, 'Cut the track for a timed clock item');
          })
          .catch((err) => this.log.warn({ err, stationId }, 'Cutting the track for a timed clock item failed'));
      },
      Math.max(0, at - Date.now()),
    );
    timer.unref();
    this.cuts.set(stationId, timer);
  }

  private touch(stationId: string, patch: Partial<AutodjStatus>) {
    this.status.set(stationId, { seenAt: null, paused: false, reachable: false, ...this.status.get(stationId), ...patch });
  }

  /** Mounts whose listeners hear the AutoDJ when they have no source of their own. */
  static fallsBackTo(view: StationView, autodjMountId: string) {
    const byId = new Map(view.mounts.map((m) => [m.id, m]));
    return view.mounts.filter((m) => {
      let cur = m.fallbackMountId ? byId.get(m.fallbackMountId) : undefined;
      for (let i = 0; cur && i < 20; i++) {
        if (cur.id === autodjMountId) return true;
        cur = cur.fallbackMountId ? byId.get(cur.fallbackMountId) : undefined;
      }
      return false;
    });
  }

  /**
   * Every few seconds and on every broadcast start/stop: tells each player whether to hold. The flag is sent again every
   * 30 seconds, so a restarted player picks it up.
   */
  async sync(snap: Snapshot, broadcasts: Iterable<LiveBroadcast>) {
    const live = [...broadcasts];
    this.lastSnap = snap;
    this.lastLive = live;
    const studio = await studioStations(this.ctx).catch((err) => {
      this.log.warn({ err }, 'reading studio mode failed');
      return new Set([...this.studioOn]);
    });
    await this.syncManual(snap).catch((err) => this.log.warn({ err }, 'manual playout sync failed'));
    for (const view of snap.stations.values()) {
      const mount = view.autodjMount;
      if (!view.active || !mount) {
        this.status.delete(view.station.id);
        continue;
      }
      const settings = autodjSettings(view.station);
      const covering = new Set(AutodjController.fallsBackTo(view, mount.id).map((m) => m.path));
      const id = view.station.id;
      const path = autodjSocketPath(this.ctx, id);
      const liveHere = live.some((b) => b.stationId === id && covering.has(b.mountPath));
      const inStudio = studio.has(id);
      if (inStudio !== this.studioOn.has(id)) {
        // Starting: the player drops the track it loaded ahead (back in the queue for the studio PC). Ending: the track
        // the PC had loaded goes back too, and the player asks the planner for the next track now; held for the studio,
        // it waits until that one is ready.
        if (!inStudio) await releaseLoaded(this.ctx, id).catch((err) => this.log.warn({ err, stationId: id }, 'releasing the studio PC\'s tracks failed'));
        await playerCommand(path, 'flush').catch(() => undefined);
        if (inStudio) {
          this.studioOn.add(id);
          this.resumeAt.delete(id);
        } else {
          this.studioOn.delete(id);
          if (this.studioLive.delete(id)) {
            this.resumeAt.set(id, Date.now() + RESUME_DELAY_MS);
            setTimeout(() => void (this.lastSnap && this.sync(this.lastSnap, this.lastLive).catch(() => undefined)), RESUME_DELAY_MS + 100).unref();
          }
          this.log.info({ station: view.station.slug }, 'Studio mode ended: the AutoDJ plays the queue again');
        }
      }
      // Held for the studio once its broadcast was live: also while it reconnects, until the PC stops renewing.
      if (inStudio && liveHere) this.studioLive.add(id);
      const resuming = (this.resumeAt.get(id) ?? 0) > Date.now();
      if (!resuming) this.resumeAt.delete(id);
      const forStudio = (inStudio && this.studioLive.has(id)) || resuming;
      const paused = (settings.pauseWhenLive && liveHere) || forStudio;
      const prev = this.status.get(view.station.id);
      if (!paused) await this.watchStuck(view.station.id).catch((err) => this.log.warn({ err, stationId: view.station.id }, 'stuck playout check failed'));
      const due = Date.now() - (this.sentAt.get(view.station.id) ?? 0) > 30_000;
      if (prev?.paused === paused && !due) continue;
      try {
        // The track it held through studio mode is old: skip it when it plays again.
        if (!paused && this.studioHeld.has(id)) await playerCommand(path, 'studio_end');
        await playerCommand(path, `live ${paused}`);
        if (forStudio) this.studioHeld.add(id);
        else if (!paused) this.studioHeld.delete(id);
        this.sentAt.set(view.station.id, Date.now());
        this.touch(view.station.id, { paused, reachable: true, studio: inStudio });
        if (prev && prev.paused !== paused) this.log.info({ station: view.station.slug, paused }, paused ? 'AutoDJ held for a live broadcast' : 'AutoDJ continues');
      } catch {
        this.touch(view.station.id, { paused, reachable: false });
      }
    }
  }

  /**
   * Once a minute per player: when the track on air ran well past its end with no DJ live, the player hangs (seen once
   * after a live broadcast ended). It gets one skip for that track, which starts the next one from the queue. If that
   * does not help, the panel and RHIS Studio keep showing it as stuck.
   */
  private async watchStuck(stationId: string) {
    if (Date.now() - (this.stuckCheckedAt.get(stationId) ?? 0) < 60_000) return;
    this.stuckCheckedAt.set(stationId, Date.now());
    const [onAir] = await this.ctx.db
      .select({ id: schema.queueItems.id, startedAt: schema.queueItems.startedAt, durationSeconds: schema.mediaFiles.durationSeconds, cueIn: schema.mediaFiles.cueIn, cueOut: schema.mediaFiles.cueOut })
      .from(schema.queueItems)
      .innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.queueItems.mediaId))
      .where(and(eq(schema.queueItems.stationId, stationId), eq(schema.queueItems.state, 'playing')))
      .limit(1);
    if (!onAir || this.stuckSkipped.get(stationId) === onAir.id) return;
    const since = await stuckSince(this.ctx, stationId, { startedAt: onAir.startedAt, media: onAir }, !!this.manualSent.get(stationId));
    if (!since) return;
    this.stuckSkipped.set(stationId, onAir.id);
    this.log.warn({ stationId, item: onAir.id, since }, 'The AutoDJ hangs on a track that should have ended: skipping it');
    await playerCommand(autodjSocketPath(this.ctx, stationId), 'skip');
  }

  /**
   * Manual playout per player: on while RHIS Studio keeps renewing it (`autodj_state.manual_until`). When the client
   * drops away the time runs out and the player goes back to Auto by itself, so the station never stays silent. Sent
   * on every change and again every 30 seconds for a restarted player; while manual, the player says whether it holds.
   */
  private async syncManual(snap: Snapshot, only?: string) {
    const rows = await this.ctx.db
      .select({ stationId: schema.autodjState.stationId })
      .from(schema.autodjState)
      .where(gt(schema.autodjState.manualUntil, new Date()));
    const manual = new Set(rows.map((r) => r.stationId));
    for (const view of snap.stations.values()) {
      const id = view.station.id;
      if (only && id !== only) continue;
      if (!view.active || !view.autodjMount) continue;
      const on = manual.has(id);
      const prev = this.manualSent.get(id);
      const due = Date.now() - (this.sentAt.get(id) ?? 0) > 30_000;
      const path = autodjSocketPath(this.ctx, id);
      try {
        if (prev !== on || due || only) {
          await playerCommand(path, `manual ${on}`);
          this.manualSent.set(id, on);
          if (prev !== undefined && prev !== on) this.log.info({ station: view.station.slug, manual: on }, on ? 'Manual playout on' : 'Back to automatic playout');
        }
        const holding = on && (await playerCommand(path, 'holding')) === 'true';
        this.touch(id, { manual: on, holding });
      } catch {
        this.manualSent.delete(id);
        this.touch(id, { manual: on, holding: false });
      }
    }
  }

  /** A command from the panel. */
  async command(raw: string) {
    try {
      const { stationId, command, itemId } = JSON.parse(raw) as { stationId?: string; command?: string; itemId?: string };
      if (!stationId || !/^[0-9a-f-]{36}$/.test(stationId)) return;
      const path = autodjSocketPath(this.ctx, stationId);
      if (command === 'skip') await playerCommand(path, 'skip');
      if (command === 'play' || command === 'stop') await playerCommand(path, command);
      // Play now: the player gets this track on its own and skips to it. The track it loaded ahead stays next.
      if (command === 'playnow' && itemId) {
        const next = await cueNow(this.ctx, stationId, itemId);
        if (next) clearTimeout(this.cuts.get(stationId));
        // Loaded ahead already: skipping starts it, also in manual playout.
        if (next === 'loaded') await playerCommand(path, 'skip');
        else if (next) await playerCommand(path, `playnow ${next.uri}`);
        else this.log.warn({ stationId, itemId }, 'Play now: the track is not waiting in a queue any more');
      }
      if (command === 'mode' && this.lastSnap) await this.syncManual(this.lastSnap, stationId);
      if (command === 'studio' && this.lastSnap) await this.sync(this.lastSnap, this.lastLive);
      // The clock or schedule changed: a hard timed item may need the track that is loaded ahead out of the way.
      if (command === 'replan' && (await flushForClock(this.ctx, stationId))) {
        await playerCommand(autodjSocketPath(this.ctx, stationId), 'flush');
        this.log.info({ stationId }, 'Dropped the track loaded ahead for a timed clock item');
      }
    } catch (err) {
      this.log.warn({ err }, 'AutoDJ command failed');
    }
  }

  snapshot(): Record<string, AutodjStatus> {
    return Object.fromEntries(this.status);
  }
}
