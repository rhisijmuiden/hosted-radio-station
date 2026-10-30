import type { NodeSettings } from '../nodes/plan.js';
import type { RecorderPlan, RecorderShow } from '../nodes/protocol.js';
import { stationRecording } from './settings.js';

type Station = { id: string; slug: string; name: string; recording?: Record<string, unknown> | null };
type Mount = { stationId: string; path: string; isDefault: boolean; isPublic: boolean; format: string; bitrateKbps: number };
/** A live broadcast on air now (live_sessions without an end). */
export type OpenSession = { id: string; stationId: string; mountPath: string; accountName: string; startedAt: Date; record?: boolean | null };

/** Whether a broadcast is recorded: as the DJ chose in RHIS Studio, else as the station's setting says. */
export const recordsShow = (session: Pick<OpenSession, 'record'>, stationShows: boolean) => session.record ?? stationShows;

/** The stations a recorder node records: the ones it serves that are chosen in its settings. */
export const recordedStations = <S extends { id: string }>(c: Pick<NodeSettings, 'recordStations'>, served: S[]) =>
  served.filter((s) => c.recordStations === 'all' || c.recordStations.includes(s.id));

/** A broadcast older than this without an end is taken as left over (an encoder that never said goodbye). */
const STALE_SHOW_MS = 24 * 3600_000;

/**
 * What a recorder node does (phase 21). It listens through the listen route of this server, which sends it to the
 * nearest relay that carries the stream right now (or to this server), so it follows the station when relays come
 * and go: the default public stream for logging, and for a live show the mount the DJ sends to (or the default one
 * when that mount is not public), recorded as it is sent.
 */
export function recorderPlan(c: Pick<NodeSettings, 'recordStations'>, served: Station[], mounts: Mount[], base: string, sessions: OpenSession[] = [], now = Date.now()): RecorderPlan {
  return {
    stations: recordedStations(c, served).map((s) => {
      const rec = stationRecording(s);
      const own = mounts.filter((m) => m.stationId === s.id && m.isPublic);
      const def = own.find((m) => m.isDefault) ?? own[0];
      const listen = (m: Mount) => `${base}/api/public/stations/${s.slug}/listen${m.path}`;
      const live: RecorderShow[] = [];
      const paused: string[] = [];
      for (const x of sessions) {
        if (x.stationId !== s.id || now - x.startedAt.getTime() > STALE_SHOW_MS) continue;
        if (!recordsShow(x, rec.shows)) {
          if (x.record === false) paused.push(x.id);
          continue;
        }
        const m = own.find((o) => o.path === x.mountPath) ?? def;
        if (!m) continue;
        live.push({ sessionId: x.id, dj: x.accountName, startedAt: x.startedAt.toISOString(), url: listen(m), format: m.format as RecorderShow['format'], kbps: m.bitrateKbps });
      }
      return {
        stationId: s.id,
        slug: s.slug,
        name: s.name,
        logging: rec.logging && def ? { url: listen(def), kbps: rec.loggingKbps, days: rec.loggingDays } : null,
        // A DJ can record a show when the station does not record them by itself.
        shows: rec.shows || live.length || paused.length ? { days: rec.showsDays, minMinutes: rec.showsMinMinutes, live, ...(paused.length ? { paused } : {}) } : null,
      };
    }),
  };
}
