import type { NodeSettings } from '../nodes/plan.js';
import type { RecorderPlan } from '../nodes/protocol.js';
import { stationRecording } from './settings.js';

type Station = { id: string; slug: string; name: string; recording?: Record<string, unknown> | null };
type Mount = { stationId: string; path: string; isDefault: boolean; isPublic: boolean };

/** The stations a recorder node records: the ones it serves that are chosen in its settings. */
export const recordedStations = <S extends { id: string }>(c: Pick<NodeSettings, 'recordStations'>, served: S[]) =>
  served.filter((s) => c.recordStations === 'all' || c.recordStations.includes(s.id));

/**
 * What a recorder node does (phase 21). It listens to the default public stream of every station it records through
 * the listen route of this server, which sends it to the nearest relay that carries the stream right now (or to this
 * server), so it follows the station when relays come and go.
 */
export function recorderPlan(c: Pick<NodeSettings, 'recordStations'>, served: Station[], mounts: Mount[], base: string): RecorderPlan {
  return {
    stations: recordedStations(c, served).map((s) => {
      const rec = stationRecording(s);
      const own = mounts.filter((m) => m.stationId === s.id && m.isPublic);
      const def = own.find((m) => m.isDefault) ?? own[0];
      return {
        stationId: s.id,
        slug: s.slug,
        name: s.name,
        logging: rec.logging && def ? { url: `${base}/api/public/stations/${s.slug}/listen${def.path}`, kbps: rec.loggingKbps, days: rec.loggingDays } : null,
      };
    }),
  };
}
