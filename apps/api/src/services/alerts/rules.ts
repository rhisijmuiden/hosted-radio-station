import type { NodeRole, NodeStatus } from '../../db/schema.js';
import type { AlertKind, AlertSettings, NodeRollout } from '../settings.js';

/**
 * What is wrong right now, worked out from what the orchestrator already knows: which nodes are connected, what they
 * report, and the stream checks (remote probes) they send. Pure, so the rules can be tested without a network; the
 * monitor (monitor.ts) turns lasting conditions into alerts.
 */

export type Severity = 'critical' | 'warning';

export interface Condition {
  /** Names what is wrong, the same every round: one outage keeps one key. */
  key: string;
  kind: AlertKind;
  severity: Severity;
  nodeId: string | null;
  stationId: string | null;
  /** Names for the message (node, station, where). */
  params: Record<string, string>;
  message: string | null;
}

export interface RulesInput {
  now: number;
  nodes: { id: string; name: string; roles: NodeRole[]; pairedAt: Date | null; online: boolean; status: NodeStatus }[];
  stations: { id: string; name: string; slug: string; enabled: boolean }[];
  probes: { nodeId: string; target: string; stationId: string; ok: boolean; message: string | null; checkedAt: Date; lastOkAt?: Date | null; silent?: boolean | null; contentType?: string | null; bitrateKbps?: number | null }[];
  /** The public streams of the stations, for the deep checks of a monitoring node. */
  mounts?: { stationId: string; path: string; format: string; kind: string; bitrateKbps: number }[];
  probeIntervalSeconds: number;
  rollout: Pick<NodeRollout, 'current' | 'paused'>;
  dns: { mode: 'off' | 'dryRun' | 'on'; error: string | null };
  settings: Pick<AlertSettings, 'quietStations' | 'maintenance'>;
  /** The name of this server, for checks of the streams it serves itself ("@main"). */
  orchestratorName: string;
}

/** The content types a player gets per stream format. */
const FORMAT_TYPES: Record<string, string[]> = {
  mp3: ['audio/mpeg', 'audio/mp3'],
  aac: ['audio/aac', 'audio/aacp', 'audio/x-aac'],
  opus: ['audio/ogg', 'application/ogg', 'audio/opus'],
  vorbis: ['audio/ogg', 'application/ogg'],
};
/** A converted stream this far off the bitrate it is made at is wrong (an encoder sends at most its bitrate). */
const BITRATE_SLACK = 0.3;

/** A relay that reported its feeds longer ago than this has nothing to say about them any more. */
const REPORT_STALE_MS = 3 * 60_000;

/** Nodes and stations in maintenance now. */
export function inMaintenance(settings: Pick<AlertSettings, 'maintenance'>, now: number) {
  const nodes = new Set<string>();
  const stations = new Set<string>();
  for (const m of settings.maintenance) {
    if (m.until && new Date(m.until).getTime() <= now) continue;
    (m.kind === 'node' ? nodes : stations).add(m.id);
  }
  return { nodes, stations };
}

export function evaluate(input: RulesInput): Condition[] {
  const { now } = input;
  const out: Condition[] = [];
  const maint = inMaintenance(input.settings, now);
  const quiet = new Set(input.settings.quietStations);
  // The update planner takes this node offline on purpose, and handles a failed update itself.
  const updating = input.rollout.current?.nodeId ?? null;
  const nodes = new Map(input.nodes.filter((n) => n.pairedAt).map((n) => [n.id, n]));
  const watchedNode = (id: string) => nodes.has(id) && !maint.nodes.has(id) && id !== updating;
  const stations = new Map(input.stations.map((s) => [s.id, s]));
  const watchedStation = (id: string) => {
    const s = stations.get(id);
    return !!s && s.enabled && !quiet.has(id) && !maint.stations.has(id);
  };

  // Nodes: offline, or online with a problem of their own (web server, ports).
  for (const n of nodes.values()) {
    if (!watchedNode(n.id)) continue;
    if (!n.online) {
      out.push({ key: `node_offline:${n.id}`, kind: 'node_offline', severity: 'critical', nodeId: n.id, stationId: null, params: { node: n.name }, message: null });
    } else if (n.status.problems?.length) {
      out.push({ key: `node_problem:${n.id}`, kind: 'node_problem', severity: 'warning', nodeId: n.id, stationId: null, params: { node: n.name }, message: n.status.problems.join('; ').slice(0, 500) });
    }
  }

  // Streams, from the stream checks: a target is down when every fresh check of it failed. A check of a relay that is
  // offline or being updated says nothing new (the node itself has its alert, or none on purpose).
  const fresh = now - (input.probeIntervalSeconds * 3 + 30) * 1000;
  type Target = { target: string; stationId: string; where: string; ok: boolean; everOk: boolean; message: string | null; silent: boolean | null; contentType: string | null; bitrateKbps: number | null };
  const targets = new Map<string, Target>();
  for (const p of input.probes) {
    if (p.checkedAt.getTime() < fresh || !watchedStation(p.stationId)) continue;
    const where = p.target.slice(p.target.lastIndexOf('@') + 1);
    if (where !== 'main') {
      const relay = nodes.get(where);
      if (!relay || !relay.online || !watchedNode(where)) continue;
    }
    const t = targets.get(p.target);
    const measured = { silent: p.ok ? (p.silent ?? null) : null, contentType: p.ok ? (p.contentType ?? null) : null, bitrateKbps: p.ok ? (p.bitrateKbps ?? null) : null };
    const everOk = p.ok || !!p.lastOkAt;
    if (!t) targets.set(p.target, { target: p.target, stationId: p.stationId, where, ok: p.ok, everOk, message: p.ok ? null : p.message, ...measured });
    else if (everOk) t.everOk = true;
    if (t && p.ok) {
      // A node that hears it play (or hears sound) wins over one that does not.
      t.ok = true;
      t.silent = t.silent === false || measured.silent === false ? false : (measured.silent ?? t.silent);
      t.contentType ??= measured.contentType;
      t.bitrateKbps ??= measured.bitrateKbps;
    }
  }
  const byStation = new Map<string, Target[]>();
  for (const t of targets.values()) byStation.set(t.stationId, [...(byStation.get(t.stationId) ?? []), t]);
  const offAir = new Set<string>();
  for (const [stationId, list] of byStation) {
    const s = stations.get(stationId)!;
    const down = list.filter((t) => !t.ok);
    // A station that never played since it is checked (a distribution station waiting for its first encoder) is not
    // off air, it has not started yet.
    if (!down.length || !list.some((t) => t.everOk)) continue;
    if (down.length === list.length) {
      offAir.add(stationId);
      out.push({ key: `station_off_air:${stationId}`, kind: 'station_off_air', severity: 'critical', nodeId: null, stationId, params: { station: s.name }, message: down[0]!.message });
      continue;
    }
    for (const t of down) {
      const where = t.where === 'main' ? input.orchestratorName : (nodes.get(t.where)?.name ?? t.where);
      out.push({ key: `stream_down:${stationId}:${t.where}`, kind: 'stream_down', severity: 'warning', nodeId: t.where === 'main' ? null : t.where, stationId, params: { station: s.name, where }, message: t.message });
    }
  }

  // Deep checks (monitoring node): a station whose every playing check hears silence is off air for the listeners
  // too; a stream in another format, or a converted stream at another bitrate, sounds wrong.
  for (const [stationId, list] of byStation) {
    if (offAir.has(stationId)) continue;
    const s = stations.get(stationId)!;
    const heard = list.filter((t) => t.ok && t.silent !== null);
    if (heard.length && heard.every((t) => t.silent)) {
      offAir.add(stationId);
      out.push({ key: `station_silent:${stationId}`, kind: 'station_silent', severity: 'critical', nodeId: null, stationId, params: { station: s.name }, message: null });
      continue;
    }
    const wrong = new Map<string, string>();
    for (const t of list) {
      if (!t.ok) continue;
      const path = t.target.slice(s.slug.length, t.target.lastIndexOf('@'));
      const m = input.mounts?.find((x) => x.stationId === stationId && x.path === path);
      if (!m) continue;
      if (t.contentType && FORMAT_TYPES[m.format] && !FORMAT_TYPES[m.format]!.includes(t.contentType.toLowerCase())) wrong.set(path, `${t.contentType} instead of ${m.format}`);
      else if (m.kind === 'transcode' && t.bitrateKbps && Math.abs(t.bitrateKbps - m.bitrateKbps) > m.bitrateKbps * BITRATE_SLACK) wrong.set(path, `${t.bitrateKbps} kbps instead of ${m.bitrateKbps} kbps`);
    }
    for (const [path, message] of wrong) {
      out.push({ key: `stream_quality:${stationId}:${path}`, kind: 'stream_quality', severity: 'warning', nodeId: null, stationId, params: { station: s.name, mount: path }, message });
    }
  }

  // Relays that lost the feed of a station they carry. A station that is off air as a whole already has its alert.
  const bySlug = new Map(input.stations.map((s) => [s.slug, s]));
  for (const n of nodes.values()) {
    if (!n.online || !watchedNode(n.id) || !n.status.relays?.length) continue;
    if (!n.status.reportedAt || new Date(n.status.reportedAt).getTime() < now - REPORT_STALE_MS) continue;
    for (const r of n.status.relays) {
      if (r.state !== 'error' && r.state !== 'connecting') continue;
      const s = bySlug.get(r.key.split('/')[0]!);
      if (!s || !watchedStation(s.id) || offAir.has(s.id)) continue;
      out.push({ key: `feed_lost:${n.id}:${r.key}`, kind: 'feed_lost', severity: 'warning', nodeId: n.id, stationId: s.id, params: { node: n.name, station: s.name, mount: r.key }, message: r.message ?? null });
    }
  }

  if (input.rollout.paused) {
    const n = input.rollout.paused.nodeId ? nodes.get(input.rollout.paused.nodeId) : undefined;
    out.push({ key: 'updates_paused', kind: 'updates_paused', severity: 'warning', nodeId: n?.id ?? null, stationId: null, params: { node: n?.name ?? '' }, message: input.rollout.paused.reason });
  }
  if (input.dns.mode === 'on' && input.dns.error) {
    out.push({ key: 'dns_error', kind: 'dns_error', severity: 'warning', nodeId: null, stationId: null, params: {}, message: input.dns.error });
  }
  return out;
}
