export type NodeRole = 'relay' | 'source';

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
  update: { branch: string | null; commit: string | null; auto: boolean };
}

export interface AgentHello {
  t: 'hello';
  protocol: number;
  nodeId: string;
  secret: string;
  version: string;
  commit: string | null;
  hostname: string;
  facts: { cores: number; memoryMb: number; os: string; caddy: boolean; addresses: string[] };
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
  | { t: 'update'; branch: string | null; commit: string | null };

/** The bulk report a node posts every 30 seconds (POST /api/nodes/agent/report). */
export interface AgentReport {
  relays: { key: string; state: 'connecting' | 'connected' | 'error' | 'idle'; message?: string; bitrateKbps?: number | null; listeners?: number }[];
  clients: { key: string; id: string; ip: string | null; userAgent: string | null; referer: string | null; connectedSeconds: number }[];
  probes: { target: string; stationId: string; url: string; ok: boolean; httpStatus: number | null; ttfbMs: number | null; message?: string; at: string }[];
}
