import type { NodeRole } from '../../db/schema.js';

/**
 * The messages between the main server and the node agent. The agent (apps/node/src/protocol.ts) has its own copy of
 * these types: keep both in step, and raise PROTOCOL_VERSION when a change is not backwards compatible.
 */
export const PROTOCOL_VERSION = 1;

/** Close codes of the control channel. */
export const CLOSE = {
  /** The node id or secret is wrong, or the node was unpaired. The agent stops trying. */
  unauthorized: 4401,
  /** Another connection of the same node took over. */
  replaced: 4409,
  /** The agent speaks a protocol this server does not know; it should update. */
  protocol: 4426,
} as const;

export interface RelayMount {
  /** "<station slug><mount path>", also the path under /listen/ on the node. */
  key: string;
  stationId: string;
  slug: string;
  path: string;
  name: string;
  format: string;
  /** Where the node pulls the stream from (the main server's listen route). */
  url: string;
}

export interface ProbeTarget {
  target: string;
  stationId: string;
  url: string;
}

/** Everything a node has to do. Sent on connect and whenever it changes. */
export interface NodePlan {
  revision: string;
  nodeId: string;
  name: string;
  roles: NodeRole[];
  web: {
    /** Domain listeners and encoders use; the node's web server gets a certificate for it. */
    publicHost: string | null;
    /** Port for listeners without a domain (or without a web server on the node). Null = the agent's default. */
    listenPort: number | null;
  };
  relay: { maxListeners: number; mounts: RelayMount[] } | null;
  source: {
    plainPort: number | null;
    tlsPort: number | null;
    /** The ingest gateway of the main server, where the node forwards encoders to. */
    upstream: { host: string; port: number; tls: boolean };
    /** Customer encoder names (src.<domain>) that point to this node; the node gets certificates for them. */
    hosts: string[];
  } | null;
  probes: { intervalSeconds: number; targets: ProbeTarget[] } | null;
  /** FM/MPX role (phase 11). */
  fm: FmPlan | null;
  update: { branch: string | null; commit: string | null; auto: boolean };
}

/** What an FM/MPX node puts on air and how. */
export interface FmPlan {
  station: { id: string; slug: string; name: string };
  /** The stream it puts on air (the main server's listen route of the chosen mount); null without a station. */
  url: string | null;
  texts: {
    ps: string;
    psMode: 'static' | 'dynamic';
    psSeconds: number;
    rtSong: string;
    rtLive: string;
    rtIdle: string;
  };
  rds: { enabled: boolean; pi: number; pty: number; tp: boolean; ta: boolean; music: boolean; af: number[]; rtPlus: boolean; clock: boolean; timezone: string };
  audio: { stereo: boolean; preemphasis: 0 | 50 | 75; limiter: boolean; pilot: number; rdsLevel: number; gainDb: number; bufferSeconds: number };
  /** soundcard: a 192 kHz sound card (ALSA); rtp: MPX over IP (RTP, L24 192 kHz); none: no MPX (UECP only). */
  output: { kind: 'soundcard' | 'rtp' | 'none'; device: string; channels: 1 | 2; rtpHost: string; rtpPort: number; rtpTtl: number };
  /** An existing RDS encoder steered over UECP, or null. */
  uecp: { transport: 'tcp' | 'udp' | 'serial'; host: string; port: number; device: string; baud: number; site: number; encoder: number } | null;
}

/** What an FM/MPX node reports about its output, in every stats message. */
export interface FmStatus {
  input: 'idle' | 'connecting' | 'connected' | 'error';
  inputMessage?: string;
  /** The song title in the stream right now. */
  title: string | null;
  output: 'off' | 'starting' | 'running' | 'error';
  outputMessage?: string;
  uecp: 'off' | 'connecting' | 'connected' | 'error';
  uecpMessage?: string;
  meters: { peak: number; left: number; right: number; buffered: number; ppm: number; underruns: number; overruns: number; playing: boolean } | null;
  /** The PS on air now, all PS frames it rotates through, the RadioText and its RadioText+ tags. */
  ps: string;
  psFrames: string[];
  rt: string;
  tags: { type: number; start: number; length: number }[];
  /** RDS groups sent since the agent started, by type. */
  groups: Record<string, number>;
}

export interface AgentHello {
  t: 'hello';
  protocol: number;
  nodeId: string;
  secret: string;
  version: string;
  commit: string | null;
  hostname: string;
  facts: { cores: number; memoryMb: number; os: string; caddy: boolean; addresses: string[]; ffmpeg?: boolean; soundcards?: { device: string; name: string }[] };
}

export interface AgentStats {
  t: 'stats';
  cpu: number;
  memory: number;
  load: number;
  uptime: number;
  rxBps: number;
  txBps: number;
  listeners: number;
  encoders: number;
  icmp: { rttMs: number | null; loss: number } | null;
  problems: string[];
  update: { state: 'idle' | 'running' | 'succeeded' | 'failed'; message?: string; at?: string } | null;
  revision: string | null;
  fm?: FmStatus | null;
}

export interface AgentEvent {
  t: 'event';
  kind: string;
  level: 'info' | 'warning' | 'error';
  details?: Record<string, string | number | null>;
}

export type AgentMessage = AgentHello | AgentStats | AgentEvent | { t: 'pong'; seq: number };

export type ServerMessage =
  | { t: 'welcome'; nodeId: string; name: string; serverTime: string }
  | { t: 'plan'; plan: NodePlan }
  | { t: 'ping'; seq: number }
  | { t: 'update'; branch: string | null; commit: string | null }
  /** FM/MPX: who is live and which show runs, for the RadioText (the song comes from the stream itself). */
  | { t: 'fm'; dj: string | null; show: string | null };

/** The bulk report a node posts every 30 seconds (POST /api/nodes/agent/report). */
export interface AgentReport {
  relays: { key: string; state: 'connecting' | 'connected' | 'error' | 'idle'; message?: string; bitrateKbps?: number | null; listeners?: number }[];
  clients: { key: string; id: string; ip: string | null; userAgent: string | null; referer: string | null; connectedSeconds: number }[];
  probes: { target: string; stationId: string; url: string; ok: boolean; httpStatus: number | null; ttfbMs: number | null; message?: string; at: string }[];
  /** Listeners that left since the last report, with the moment they left. */
  ended?: { key: string; id: string; endedAt: string }[];
}
