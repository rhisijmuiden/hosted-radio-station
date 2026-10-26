export type NodeRole = 'relay' | 'source' | 'station' | 'fm';

/**
 * The messages between the main server and the node agent. A copy of apps/api/src/services/nodes/protocol.ts: keep
 * both in step, and raise PROTOCOL_VERSION when a change is not backwards compatible.
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
  /** Where the node pulls the stream from (the main server's listen route). Null when a station node pushes it. */
  url: string | null;
  /** A station node delivers this stream to the node's push port, signing in with this token. */
  push: { token: string } | null;
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
  relay: {
    maxListeners: number;
    mounts: RelayMount[];
    /** Where station nodes deliver their streams (TLS). */
    pushPort: number | null;
  } | null;
  source: {
    plainPort: number | null;
    tlsPort: number | null;
    /** The ingest gateway of the main server, where the node forwards encoders to. */
    upstream: { host: string; port: number; tls: boolean };
    /** Customer encoder names (src.<domain>) that point to this node; the node gets certificates for them. */
    hosts: string[];
  } | null;
  ingest: IngestPlan | null;
  probes: { intervalSeconds: number; targets: ProbeTarget[] } | null;
  /** Station node: the full server next to the agent runs the stations (it gets them itself from the main server). */
  station: { stations: number } | null;
  /** FM/MPX role (phase 11). */
  fm: FmPlan | null;
  update: { branch: string | null; commit: string | null; auto: boolean };
}

/** A mount of a station on an ingest node (phase 13). */
export interface IngestMount {
  path: string;
  name: string;
  /** source = fed by encoders; transcode = made on the ingest node from `sourcePath`. */
  kind: 'source' | 'transcode';
  format: string;
  bitrateKbps: number;
  sourcePath: string | null;
  /** Listeners (and the relays) hear this mount while this one has no source. */
  fallbackPath: string | null;
  isPublic: boolean;
}

/** A relay node an ingest pushes a station's public mounts to, with the token per stream key. */
export interface IngestTarget {
  nodeId: string;
  name: string;
  host: string;
  port: number;
  /** The relay has no public name, so it uses a certificate of its own. */
  insecureTls: boolean;
  tokens: Record<string, string>;
}

/** An external Icecast server the ingest feeds directly. */
export interface IngestOutput {
  id: string;
  mountPath: string;
  host: string;
  port: number;
  tls: boolean;
  mount: string;
  username: string;
  password: string;
}

export interface IngestStation {
  stationId: string;
  slug: string;
  name: string;
  tenantId: string;
  /** 0 = main ingest, 1 = backup: relays prefer the stream with the lowest number. */
  priority: number;
  mounts: IngestMount[];
  targets: IngestTarget[];
  outputs: IngestOutput[];
}

/** Ingest (phase 13): the node takes encoders of these stations itself and sends the audio straight to the relays. */
export interface IngestPlan {
  stations: IngestStation[];
  /** Customer encoder names (src.<domain>) → customer, so "/<mount>" works on a customer's own name. */
  hosts: Record<string, string>;
}

/** An encoder log-in the ingest node asks the main server about (the passwords live there). */
export interface AgentAuth {
  t: 'auth';
  id: number;
  stationId: string;
  mount: string;
  user: string | null;
  pass: string;
  ip: string;
  /** source = an encoder going on air; metadata = a title update. */
  purpose: 'source' | 'metadata';
}

export interface AuthResult {
  t: 'auth_result';
  id: number;
  ok: boolean;
  /** Shown to the encoder when it is refused. */
  message?: string;
  accountId?: string;
  accountName?: string;
  /** Highest bitrate the encoder may send to this mount, in kbps. */
  limitKbps?: number;
}

/** A broadcast on an ingest node starts or ends. The node picks the id, so it can report offline broadcasts later. */
export interface AgentLive {
  t: 'live';
  action: 'start' | 'end';
  sessionId: string;
  stationId: string;
  mount: string;
  accountId?: string | null;
  accountName?: string;
  via?: 'tls' | 'plain';
  ip?: string;
  userAgent?: string | null;
  bitrateKbps?: number | null;
  startedAt?: string;
  bytesIn?: number;
  reason?: string;
}

/** After (re)connecting: the broadcasts on air on the node; the others it started have ended. */
export interface AgentLiveSync {
  t: 'live_sync';
  sessionIds: string[];
}

/** A mount on air on an ingest node, sent with the stats. */
export interface IngestMountStatus {
  stationId: string;
  mount: string;
  title: string | null;
  bitrateKbps: number | null;
  contentType: string | null;
  /** Relay nodes the mount is pushed to right now. */
  pushing: string[];
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
  /** Ingest: mounts on air on this node. */
  ingest?: IngestMountStatus[];
  fm?: FmStatus | null;
}

export interface AgentEvent {
  t: 'event';
  kind: string;
  level: 'info' | 'warning' | 'error';
  details?: Record<string, string | number | null>;
}

export type AgentMessage = AgentHello | AgentStats | AgentEvent | AgentAuth | AgentLive | AgentLiveSync | { t: 'pong'; seq: number };

export type ServerMessage =
  | { t: 'welcome'; nodeId: string; name: string; serverTime: string }
  | { t: 'plan'; plan: NodePlan }
  | { t: 'ping'; seq: number }
  | { t: 'update'; branch: string | null; commit: string | null }
  | AuthResult
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
