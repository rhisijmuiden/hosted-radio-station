import { z } from 'zod';

/** "local" = the ingest role of this server itself; otherwise the id of an ingest (source) node. */
const ingestRef = z.union([z.literal('local'), z.uuid()]);

/**
 * How a station's audio travels (phase 13): which ingest takes the encoders, which one stands by, and which relays
 * the ingest feeds. The orchestrator only hands this out; the audio goes from the ingest straight to the relays.
 */
export const routingSchema = z.object({
  ingest: ingestRef.default('local'),
  /** Takes over when the main ingest is gone: encoders connect there and it feeds the same relays. */
  backupIngest: ingestRef.nullable().default(null),
  /** "auto" = every relay that carries the station by its own settings; or a chosen list of relay nodes. */
  relays: z.union([z.literal('auto'), z.array(z.uuid()).max(100)]).default('auto'),
  /** When none of the chosen relays is online, the other relays step in until one is back. */
  spareRelays: z.boolean().default(true),
});
export type StationRouting = z.infer<typeof routingSchema>;

export const stationRouting = (s: { routing?: Record<string, unknown> | null }): StationRouting => {
  const r = routingSchema.safeParse(s.routing ?? {});
  return r.success ? r.data : routingSchema.parse({});
};

/** The ingests of a station, best first: priority 0 is the main ingest, 1 the backup. */
export function ingestsOf(r: StationRouting): { ref: string; priority: number }[] {
  const out = [{ ref: r.ingest, priority: 0 }];
  if (r.backupIngest && r.backupIngest !== r.ingest) out.push({ ref: r.backupIngest, priority: 1 });
  return out;
}

/** Ingest nodes of a station (without this server). */
export const ingestNodes = (r: StationRouting) => ingestsOf(r).filter((i) => i.ref !== 'local');

/** This server takes encoders for the station (as its main or backup ingest). */
export const localIngest = (r: StationRouting) => ingestsOf(r).some((i) => i.ref === 'local');

/** Priority of this server's own ingest, or null. */
export const localPriority = (r: StationRouting) => ingestsOf(r).find((i) => i.ref === 'local')?.priority ?? null;

/**
 * The relays get the stream pushed by the ingest(s) instead of pulling it from this server: as soon as an ingest node
 * is involved. A station with only this server as ingest keeps the classic pull.
 */
export const pushedRouting = (r: StationRouting) => ingestNodes(r).length > 0;
