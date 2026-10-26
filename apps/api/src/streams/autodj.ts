import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import net from 'node:net';
import type pino from 'pino';
import type { AppContext } from '../lib/context.js';
import { autodjSocketPath, autodjToken } from '../services/autodj/liquidsoap.js';
import { nextTrack, playerStarted, trackStarted } from '../services/autodj/planner.js';
import { autodjSettings } from '../services/autodj/settings.js';
import type { LiveBroadcast } from './recorder.js';
import type { Snapshot, StationView } from './snapshot.js';

/** Channel the API notifies with AutoDJ commands ({ stationId, command: 'skip' }). */
export const AUTODJ_CHANNEL = 'hrs_autodj';

export interface AutodjStatus {
  /** Last time the player asked for a track or reported one. */
  seenAt: string | null;
  /** Held because a DJ is live on a mount that falls back to the AutoDJ. */
  paused: boolean;
  /** The control socket answered at the last check. */
  reachable: boolean;
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
          ? nextTrack(this.ctx, stationId).then((next) => {
              seen();
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
    for (const view of snap.stations.values()) {
      const mount = view.autodjMount;
      if (!view.active || !mount) {
        this.status.delete(view.station.id);
        continue;
      }
      const settings = autodjSettings(view.station);
      const covering = new Set(AutodjController.fallsBackTo(view, mount.id).map((m) => m.path));
      const paused = settings.pauseWhenLive && live.some((b) => b.stationId === view.station.id && covering.has(b.mountPath));
      const prev = this.status.get(view.station.id);
      const due = Date.now() - (this.sentAt.get(view.station.id) ?? 0) > 30_000;
      if (prev?.paused === paused && !due) continue;
      try {
        await playerCommand(autodjSocketPath(this.ctx, view.station.id), `live ${paused}`);
        this.sentAt.set(view.station.id, Date.now());
        this.touch(view.station.id, { paused, reachable: true });
        if (prev && prev.paused !== paused) this.log.info({ station: view.station.slug, paused }, paused ? 'AutoDJ held for a live broadcast' : 'AutoDJ continues');
      } catch {
        this.touch(view.station.id, { paused, reachable: false });
      }
    }
  }

  /** A command from the panel. */
  async command(raw: string) {
    try {
      const { stationId, command } = JSON.parse(raw) as { stationId?: string; command?: string };
      if (!stationId || !/^[0-9a-f-]{36}$/.test(stationId) || command !== 'skip') return;
      await playerCommand(autodjSocketPath(this.ctx, stationId), 'skip');
    } catch (err) {
      this.log.warn({ err }, 'AutoDJ command failed');
    }
  }

  snapshot(): Record<string, AutodjStatus> {
    return Object.fromEntries(this.status);
  }
}
