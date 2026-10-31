import type { NodeRole } from '../../db/schema.js';

/**
 * The messages between the main server and the node agent. The agent (apps/node/src/protocol.ts) has its own copy of
 * these types: keep both in step, and raise PROTOCOL_VERSION when a change is not backwards compatible.
 */
export const PROTOCOL_VERSION = 1;
/**
 * The oldest agent protocol the main server still accepts. Nodes are updated one by one (or not at all, when an
 * administrator keeps them on their version), so the server must keep talking to agents of the previous version: when
 * PROTOCOL_VERSION goes up, leave this one behind for at least one release.
 */
export const MIN_PROTOCOL_VERSION = 1;

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
  /**
   * Monitoring node (phase 20): listen for a few seconds and also measure bitrate, format, title and audio level.
   * Older agents ignore it and do the short check.
   */
  deep?: { seconds: number } | null;
}

/** What a deep stream check measured (monitoring node, phase 20). */
export interface ProbeMeasure {
  bitrateKbps: number | null;
  contentType: string | null;
  title: string | null;
  /** Loudest moment in dBFS over the check, from ffmpeg; null without ffmpeg. */
  levelDb: number | null;
  /** The stream plays, but nothing louder than the silence threshold was heard. */
  silent: boolean | null;
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
    /**
     * Names to fetch certificates for through Cloudflare DNS (DNS-01, phase 15): the main server sets the TXT record
     * when the node asks (POST /api/nodes/agent/acme/present). Null or missing = HTTP as usual.
     */
    dnsCerts?: { hosts: string[]; email: string } | null;
  };
  relay: {
    maxListeners: number;
    mounts: RelayMount[];
    /** Where station nodes deliver their streams (TLS). Agents before 1.3 listen on this one only. */
    pushPort: number | null;
    /** Every push port to listen on (port plan, 1.3): the node's own and, while it keeps them, the old one. */
    pushPorts?: number[];
  } | null;
  source: {
    /** Agents before 1.3 listen on these two only. */
    plainPort: number | null;
    tlsPort: number | null;
    /** Every encoder port to listen on (port plan, 1.3): the node's own and, while it keeps them, the old ones. */
    ports?: { plain: number[]; tls: number[] };
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
  /**
   * The node's own firewall (security hardening for external nodes): incoming traffic is dropped except SSH and these
   * ports ("8200" or "8210-8299"). Missing in plans of older main servers: the node leaves its firewall alone.
   */
  firewall?: { enabled: boolean; takeOver: boolean; tcp: string[]; udp: string[]; sshFrom?: string[]; sshLimit?: boolean };
  /** Recorder (phase 21). Missing in plans of older main servers. */
  recorder?: RecorderPlan | null;
  update: { branch: string | null; commit: string | null; auto: boolean };
}

/** What a recorder node records (phase 21). */
export interface RecorderPlan {
  stations: {
    stationId: string;
    slug: string;
    name: string;
    /**
     * Continuous recording in files of one hour: where to listen, the MP3 bitrate, and how many days to keep.
     * `fallback`: the same stream straight from the station's ingest node, for while no relay carries it (a relay
     * update): the recorder switches there at once and goes back to the relay at the end of the hour (small fixes).
     */
    logging: { url: string; kbps: number; days: number; fallback?: string } | null;
    /**
     * Live shows (step 2): the broadcasts on air now, recorded as they are sent (no new encoding) until they leave
     * the plan. Shorter than minMinutes = thrown away; kept `days` days. Missing in plans of older servers.
     * `paused`: broadcasts still on air whose recording the DJ stopped; their parts so far are kept until the
     * broadcast ends, and only then measured against minMinutes together with later parts (step 4).
     */
    shows?: { days: number; minMinutes: number; live: RecorderShow[]; paused?: string[] } | null;
  }[];
}

/** A live broadcast a recorder records: where to listen, and the format and bitrate of that stream. */
export interface RecorderShow {
  sessionId: string;
  dj: string;
  startedAt: string;
  url: string;
  format: 'mp3' | 'aac' | 'opus' | 'vorbis';
  kbps: number;
}

/** What a recorder node is doing, in every stats message. */
export interface RecorderStatus {
  stations: { stationId: string; kind: 'log' | 'show'; sessionId?: string; state: 'starting' | 'recording' | 'waiting' | 'error'; message?: string; since?: string; via?: 'ingest' }[];
  /** The disk of the recordings folder. */
  disk: { totalBytes: number; freeBytes: number; usedBytes: number } | null;
}

/** A file on a recorder node, in the bulk report. `file` is relative to its recordings folder. */
export interface RecordingFile {
  stationId: string;
  kind: 'log' | 'show';
  /** A show: the live broadcast it is a recording of. */
  sessionId?: string;
  file: string;
  startedAt: string;
  seconds: number;
  bytes: number;
  /** Still being written. */
  open: boolean;
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
  /**
   * Thimeo Stereo Tool (command-line version) as the audio processor, or null for the node's own light chain. Plans
   * of older main servers have no such field.
   */
  stereoTool?: FmStereoTool | null;
}

export interface FmStereoTool {
  /** The program the administrator uploaded; the agent fetches it from the main server. Null = none uploaded yet. */
  binary: { sha256: string; size: number } | null;
  /** Licence key of the station; empty = Stereo Tool's free mode. */
  licence: string;
  /** stereotool: Stereo Tool makes the MPX (its own stereo encoder, RDS through UECP); node: it only processes. */
  mpx: 'stereotool' | 'node';
  /** Sample rate of the audio fed to Stereo Tool. */
  inputRate: 48000 | 192000;
  /** Port of Stereo Tool's web interface on the node (local, behind the node firewall). */
  webPort: number;
  /** TCP port Stereo Tool's RDS encoder takes UECP on; the agent sends the RDS texts there. */
  uecpPort: number;
  /** Extra command-line arguments for Stereo Tool, for options this panel does not have. */
  extraArgs: string[];
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
  /** Stereo Tool, when it is the processor. */
  stereoTool?: { state: 'installing' | 'starting' | 'running' | 'error'; message?: string; restarts: number } | null;
}

export interface AgentHello {
  t: 'hello';
  protocol: number;
  nodeId: string;
  secret: string;
  version: string;
  commit: string | null;
  hostname: string;
  facts: { cores: number; memoryMb: number; os: string; caddy: boolean; addresses: string[]; ffmpeg?: boolean; soundcards?: { device: string; name: string }[]; features?: string[] };
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
  /** The end of the log of the last configuration run, when it failed. */
  applyLog?: string[];
  update: { state: 'idle' | 'running' | 'succeeded' | 'failed'; message?: string; at?: string } | null;
  revision: string | null;
  /** The node's public IPv4 address as the internet sees it, looked up by the node itself (phase 19). */
  publicIp?: string | null;
  /** Names the node has a valid certificate from an authority for (1.3), so others can reach it over checked TLS. */
  certs?: string[];
  /** Ingest: mounts on air on this node. */
  ingest?: IngestMountStatus[];
  fm?: FmStatus | null;
  /** The node's firewall as its root helper reports it. */
  firewall?: NodeFirewallStatus | null;
  recorder?: RecorderStatus | null;
}

export interface NodeFirewallStatus {
  state: 'off' | 'running' | 'pending' | 'active' | 'foreign' | 'rolledBack' | 'failed' | 'unsupported';
  message?: string;
  /** Firewall rules of something else found on the server (iptables, ufw, firewalld, other nftables tables). */
  foreign?: string[];
  /** What is let in: SSH, and the TCP and UDP ports of the roles. */
  ports?: { ssh: string[]; tcp: string[]; udp: string[] };
  /** SSH: the admin addresses it is limited to (empty = anywhere), the attempt limit, and whether sshd takes passwords. */
  ssh?: { from: string[]; limit: boolean; password: string };
  at?: string;
}

export interface AgentEvent {
  t: 'event';
  kind: string;
  level: 'info' | 'warning' | 'error';
  details?: Record<string, string | number | null>;
}

/** A port the server asked a monitoring node to try from outside (phase 20), with the outcome. */
export interface PortCheckResult {
  port: number;
  ok: boolean;
  /** refused, timeout, unreachable, dns or another error code. */
  message: string | null;
  ms: number | null;
}

/** The answer of a monitoring node to a port check. */
export interface AgentPortCheckResult {
  t: 'portcheck_result';
  id: number;
  /** The address it connected to (the name looked up there, or the address it was given). */
  address: string | null;
  results: PortCheckResult[];
}

/** A recorder node cannot send a file the server asked for (rec_send). */
export interface AgentRecordingError {
  t: 'rec_error';
  id: string;
  message: string;
}

export type AgentMessage = AgentHello | AgentStats | AgentEvent | AgentAuth | AgentLive | AgentLiveSync | AgentPortCheckResult | AgentRecordingError | { t: 'pong'; seq: number };

export type ServerMessage =
  | { t: 'welcome'; nodeId: string; name: string; serverTime: string }
  | { t: 'plan'; plan: NodePlan }
  | { t: 'ping'; seq: number }
  /** The main server restarts: reconnect soon. A proxy in between (Caddy) may keep the WebSocket open after the server closed it. */
  | { t: 'restart' }
  | { t: 'update'; branch: string | null; commit: string | null }
  /** Restart the agent (its service starts it again) or the node's Icecast, from the node page (feature "restart"). */
  | { t: 'restart_service'; service: 'agent' | 'icecast' }
  /**
   * An update of this node is coming: no new listeners are sent here, and the agent moves the ones it has over this
   * many seconds (they reconnect through the listen route, which picks another relay). 0 = stop draining.
   */
  | { t: 'drain'; seconds: number }
  | AuthResult
  /** Monitoring node (phase 20): try these TCP ports of a node from outside and answer with portcheck_result. */
  | { t: 'portcheck'; id: number; host: string; ports: number[] }
  /** FM/MPX: who is live and which show runs, for the RadioText (the song comes from the stream itself). */
  | { t: 'fm'; dj: string | null; show: string | null }
  /**
   * Recorder (phase 21): post bytes start..end (end exclusive, null = up to the end) of this file to
   * POST /api/nodes/agent/recordings/<id>, or answer with rec_error.
   */
  | { t: 'rec_send'; id: string; file: string; start: number; end: number | null }
  /** Recorder node (step 3): this finished file has been uploaded everywhere it had to go, remove it. */
  | { t: 'rec_delete'; file: string };

/** The bulk report a node posts every 30 seconds (POST /api/nodes/agent/report). */
export interface AgentReport {
  relays: { key: string; state: 'connecting' | 'connected' | 'error' | 'idle'; message?: string; bitrateKbps?: number | null; listeners?: number }[];
  clients: { key: string; id: string; ip: string | null; userAgent: string | null; referer: string | null; connectedSeconds: number }[];
  probes: ({ target: string; stationId: string; url: string; ok: boolean; httpStatus: number | null; ttfbMs: number | null; message?: string; at: string } & Partial<ProbeMeasure>)[];
  /** Listeners that left since the last report, with the moment they left. */
  ended?: { key: string; id: string; endedAt: string }[];
  /** Recorder: every file it has, when that changed (or now and then). Missing = no news. */
  recordings?: RecordingFile[];
}
