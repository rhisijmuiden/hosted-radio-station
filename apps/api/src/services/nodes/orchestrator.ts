import { eq } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { conflict } from '../../lib/errors.js';
import { getSetting } from '../settings.js';
import { ingestsOf, pushedRouting, stationRouting } from './routing-rules.js';

/** Why a station still needs audio on this server. */
export type AudioUse = 'ingest' | 'backupIngest' | 'listeners' | 'autodj' | 'moving';

/**
 * The stations that still use this server for audio (phase 18): its ingest takes their encoders (main or backup), its
 * relay serves their listeners, or their AutoDJ plays here. They have to move to an ingest node or a station node
 * before the orchestrator can go "orchestrator only".
 */
export async function stationsUsingThisServer(ctx: AppContext) {
  const rows = await ctx.db
    .select({ id: schema.stations.id, name: schema.stations.name, slug: schema.stations.slug, edition: schema.stations.edition, routing: schema.stations.routing, nodeId: schema.stations.nodeId, nodeMove: schema.stations.nodeMove, tenantId: schema.stations.tenantId, tenantName: schema.tenants.name })
    .from(schema.stations)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.stations.tenantId))
    .orderBy(schema.stations.name);
  const out: { id: string; name: string; slug: string; tenantId: string; tenantName: string; uses: AudioUse[] }[] = [];
  for (const s of rows) {
    const uses: AudioUse[] = [];
    if (s.nodeMove) uses.push('moving');
    if (!s.nodeId) {
      const r = stationRouting(s);
      for (const i of ingestsOf(r)) if (i.ref === 'local') uses.push(i.priority === 0 ? 'ingest' : 'backupIngest');
      if (!pushedRouting(r)) uses.push('listeners');
      if (s.edition === 'station') uses.push('autodj');
    }
    if (uses.length) out.push({ id: s.id, name: s.name, slug: s.slug, tenantId: s.tenantId, tenantName: s.tenantName, uses: [...new Set(uses)] });
  }
  return out;
}

/** Refuses a step that would put audio back on this server while it is "orchestrator only". */
export async function assertAudioAllowedHere(ctx: AppContext, what: string) {
  if ((await getSetting(ctx, 'orchestrator')).only) throw conflict(`This server is set to orchestrator only and carries no audio: ${what}`);
}
