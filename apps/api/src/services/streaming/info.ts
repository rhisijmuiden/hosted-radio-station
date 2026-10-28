import { and, eq, isNotNull } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { namesFrom } from '../nodes/names.js';
import { nodeHost, nodeSettings } from '../nodes/plan.js';
import { externalAddress, inboundPorts, internalAddress, STATION_NODE_STREAMING, type PortService } from '../nodes/ports.js';
import { OLD_PORTS } from '../nodes/portplan.js';
import { ingestsOf, pushedRouting, stationRouting } from '../nodes/routing-rules.js';
import { getSetting } from '../settings.js';
import type { Mount, Station } from './state.js';

/** The verified domain of a customer, if any (the first one added). */
export async function tenantDomain(ctx: AppContext, tenantId: string) {
  const [d] = await ctx.db
    .select()
    .from(schema.tenantDomains)
    .where(and(eq(schema.tenantDomains.tenantId, tenantId), eq(schema.tenantDomains.status, 'verified')))
    .orderBy(schema.tenantDomains.createdAt)
    .limit(1);
  return d ?? null;
}

export interface ConnectionInfo {
  /** Where encoders connect. */
  ingestHost: string;
  /** The source node behind the ingest name, when the customer routed it to one. */
  node: { id: string; name: string } | null;
  /** The ingest that takes over when the main one is gone (phase 13): encoders can use it as their backup server. */
  backup: { host: string; node: { id: string; name: string } | null; tls: { port: number; available: boolean }; plain: { port: number } | null } | null;
  /** Where files are uploaded (SFTP/FTP always run on this server). */
  uploadHost: string;
  tls: { port: number; available: boolean };
  plain: { port: number } | null;
  legacy: { port: number; sourcePort: number; mount: string | null } | null;
  /** Base of the listen URLs, e.g. https://stream.example.com */
  listenBase: string;
  mounts: { id: string; path: string; encoderMount: string; listenUrl: string | null }[];
  /** The upload ports of the server that holds the library (this server, or the station node); null = no uploads. */
  upload: { sftpPort: number | null; ftpPort: number | null; ftpRequireTls: boolean; passive: { from: number; to: number } | null } | null;
  /**
   * Where everything connects, as the orchestrator hands it out from the station's routing (phase 18): the station
   * node with its external and internal address, or the ingest(s) the customer may stream to, and where uploads go.
   */
  endpoints: Endpoint[];
  /** Panel address RHIS Studio signs in to. */
  panelUrl: string;
}

export interface Endpoint {
  role: 'stationNode' | 'ingest' | 'backupIngest' | 'uploads';
  /** Server name (phase 18). */
  name: string;
  /** Null = this server (the orchestrator or one of its roles). */
  node: { id: string; name: string } | null;
  online: boolean;
  /** Address from outside (internet). */
  external: string | null;
  /** Address on the customer's or studio's own network, when known. */
  internal: string | null;
  /** `old`: a port from before the port plan (1.3), listed after the new one; clients use it when the new one is closed. */
  ports: { service: PortService; port: number; to?: number; tls?: boolean; old?: boolean }[];
}

/** Everything a DJ needs to set up an encoder, and the listen URLs of the public mounts. */
export async function connectionInfo(ctx: AppContext, station: Station, mounts: Mount[], localEnabled: boolean): Promise<ConnectionInfo> {
  const base = await baseConnection(ctx, station, mounts, localEnabled);
  return { ...base, ...(await endpointsOf(ctx, station, base)) };
}

type BaseConnection = Omit<ConnectionInfo, 'endpoints' | 'panelUrl' | 'upload'>;

const INTERNAL_TLDS = new Set(['loc', 'local', 'lan', 'home', 'internal', 'intranet', 'corp', 'localdomain', 'test', 'invalid', 'localhost', 'arpa']);

/**
 * A name a public certificate can exist for: a dotted DNS name outside the internal suffixes. An IP address or a
 * name such as radionode3.mngt.example.loc only ever gets a self-signed certificate, which encoders do not trust.
 */
export function publicName(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h || h.includes(':') || /^\d+(\.\d+){3}$/.test(h) || !h.includes('.')) return false;
  return !INTERNAL_TLDS.has(h.slice(h.lastIndexOf('.') + 1));
}

async function baseConnection(ctx: AppContext, station: Station, mounts: Mount[], localEnabled: boolean): Promise<BaseConnection> {
  const [proxy, streaming, domain] = await Promise.all([getSetting(ctx, 'proxy'), getSetting(ctx, 'streaming'), tenantDomain(ctx, station.tenantId)]);
  const publicUrl = new URL(ctx.config.PUBLIC_URL);
  const ingestHost = domain?.ingestHost ?? (streaming.encoderHost || proxy.domain || publicUrl.hostname);
  // A separate encoder address has no certificate of its own: TLS only on the customer's src. name or the main domain.
  const tlsHere = proxy.mode === 'builtin' && (!!domain || (!!proxy.domain && !streaming.encoderHost));
  const listenBase = domain ? `https://${domain.panelHost}` : ctx.config.PUBLIC_URL.replace(/\/$/, '');
  const legacyMount = mounts.find((m) => m.id === station.legacyMountId) ?? mounts.find((m) => m.kind === 'source') ?? null;
  // A station on a station node (phase 12): encoders and RHIS Studio connect to the node in the studio itself.
  if (station.nodeId) {
    const [sn] = await ctx.db.select().from(schema.nodes).where(and(eq(schema.nodes.id, station.nodeId), isNotNull(schema.nodes.pairedAt)));
    if (sn) {
      const c = nodeSettings(sn);
      const name = nodeHost(sn);
      const host = c.lanAddress || name || sn.status.ip || ingestHost;
      const d = STATION_NODE_STREAMING;
      // TLS only where encoders connect to the node's public name: its certificate is for that name, so a LAN address
      // (plain inside the studio) or an internal name would fail on the certificate.
      const tlsOk = !c.lanAddress && !!name && publicName(name) && !!sn.status.caddy;
      return {
        ingestHost: host,
        node: { id: sn.id, name: sn.name },
        backup: null,
        // The library lives on the node, so uploads go there too.
        uploadHost: externalAddress(sn) ?? host,
        // The node's own ingest gateway takes encoders, on the ports of a fresh install; TLS only with a name and a
        // certificate of its own.
        tls: { port: d.ingestTlsPort, available: tlsOk },
        plain: d.ingestPlainPort ? { port: d.ingestPlainPort } : null,
        legacy: station.legacyPort ? { port: station.legacyPort, sourcePort: station.legacyPort + 1, mount: legacyMount?.path ?? null } : null,
        listenBase,
        // Listeners go through the relays the node feeds; this server has no audio of the station.
        mounts: mounts.map((m) => ({ id: m.id, path: m.path, encoderMount: m.path, listenUrl: m.isPublic ? `${listenBase}/api/public/stations/${station.slug}/listen${m.path}` : null })),
      };
    }
  }
  const routing = stationRouting(station);
  const nodeRow = async (id: string) => (await ctx.db.select().from(schema.nodes).where(and(eq(schema.nodes.id, id), isNotNull(schema.nodes.pairedAt))))[0];
  // An ingest node (phase 13) takes the encoders itself; its address comes from its own name, else the customer's
  // src. name when that points to it, else its IP address.
  const nodeIngest = async (id: string) => {
    const n = await nodeRow(id);
    if (!n?.roles.includes('source')) return null;
    const c = nodeSettings(n);
    const host = domain?.ingestNodeId === n.id ? domain.ingestHost : nodeHost(n) || n.status.ip || n.name;
    return { host, node: { id: n.id, name: n.name }, tls: { port: c.sourceTlsPort ?? streaming.ingestTlsPort, available: !!c.sourceTlsPort && !!n.status.caddy && publicName(host) }, plain: c.sourcePlainPort ? { port: c.sourcePlainPort } : null };
  };
  const here = { host: ingestHost, node: null, tls: { port: streaming.ingestTlsPort, available: tlsHere }, plain: streaming.ingestPlainPort ? { port: streaming.ingestPlainPort } : null };
  const backup = routing.backupIngest && routing.backupIngest !== routing.ingest ? (routing.backupIngest === 'local' ? here : await nodeIngest(routing.backupIngest)) : null;
  const pushed = pushedRouting(routing);
  if (routing.ingest !== 'local') {
    const main = await nodeIngest(routing.ingest);
    if (main) {
      return {
        ingestHost: main.host,
        node: main.node,
        backup,
        uploadHost: domain?.panelHost ?? (proxy.domain || publicUrl.hostname),
        tls: main.tls,
        plain: main.plain,
        legacy: null,
        listenBase,
        // Listeners are sent to the relays; this server has no audio of the station.
        mounts: mounts.map((m) => ({ id: m.id, path: m.path, encoderMount: `/${station.slug}${m.path}`, listenUrl: m.isPublic ? `${listenBase}/api/public/stations/${station.slug}/listen${m.path}` : null })),
      };
    }
  }
  const [node] = domain?.ingestNodeId ? [await nodeRow(domain.ingestNodeId)].filter(Boolean) : [];
  if (node?.roles.includes('source')) {
    // Encoders go to the customer's source node, which passes them on to this server.
    const c = nodeSettings(node);
    return {
      ingestHost,
      node: { id: node.id, name: node.name },
      backup,
      uploadHost: domain!.panelHost,
      tls: { port: c.sourceTlsPort ?? streaming.ingestTlsPort, available: !!c.sourceTlsPort && !!node.status.caddy },
      plain: c.sourcePlainPort ? { port: c.sourcePlainPort } : null,
      legacy: null,
      listenBase,
      mounts: mounts.map((m) => ({ id: m.id, path: m.path, encoderMount: `/${station.slug}${m.path}`, listenUrl: m.isPublic && localEnabled ? `${listenBase}/listen/${station.slug}${m.path}` : null })),
    };
  }
  return {
    ingestHost,
    node: null,
    backup,
    uploadHost: ingestHost,
    // Certificates come from the built-in web server; behind an external proxy, TLS for encoders is set up there.
    tls: { port: streaming.ingestTlsPort, available: tlsHere },
    plain: streaming.ingestPlainPort ? { port: streaming.ingestPlainPort } : null,
    legacy: station.legacyPort ? { port: station.legacyPort, sourcePort: station.legacyPort + 1, mount: legacyMount?.path ?? null } : null,
    listenBase,
    mounts: mounts.map((m) => ({
      id: m.id,
      path: m.path,
      encoderMount: `/${station.slug}${m.path}`,
      listenUrl: m.isPublic && pushed ? `${listenBase}/api/public/stations/${station.slug}/listen${m.path}` : m.isPublic && localEnabled ? `${listenBase}/listen/${station.slug}${m.path}` : null,
    })),
  };
}

/** The endpoints of a station, its upload ports and the panel address (see ConnectionInfo.endpoints). */
async function endpointsOf(ctx: AppContext, station: Station, conn: BaseConnection): Promise<Pick<ConnectionInfo, 'endpoints' | 'panelUrl' | 'upload'>> {
  const [streaming, orchestrator, proxy, domain] = await Promise.all([getSetting(ctx, 'streaming'), getSetting(ctx, 'orchestrator'), getSetting(ctx, 'proxy'), tenantDomain(ctx, station.tenantId)]);
  const names = namesFrom(orchestrator, proxy.domain || streaming.cnameTarget || new URL(ctx.config.PUBLIC_URL).hostname);
  const panelUrl = domain ? `https://${domain.panelHost}` : ctx.config.PUBLIC_URL.replace(/\/$/, '');
  const nodeRow = async (id: string) => (await ctx.db.select().from(schema.nodes).where(and(eq(schema.nodes.id, id), isNotNull(schema.nodes.pairedAt))))[0];
  const uploadPorts = (s: typeof streaming) => ({
    sftpPort: s.sftp.enabled ? s.sftp.port : null,
    ftpPort: s.ftp.enabled ? s.ftp.port : null,
    ftpRequireTls: s.ftp.requireTls,
    passive: s.ftp.enabled ? { from: s.ftp.passivePortFrom, to: s.ftp.passivePortTo } : null,
  });
  const uploadList = (u: ReturnType<typeof uploadPorts>): Endpoint['ports'] => [
    ...(u.sftpPort ? [{ service: 'sftp' as const, port: u.sftpPort }] : []),
    ...(u.ftpPort ? [{ service: 'ftp' as const, port: u.ftpPort, tls: u.ftpRequireTls }] : []),
    ...(u.passive ? [{ service: 'ftpPassive' as const, port: u.passive.from, to: u.passive.to }] : []),
  ];
  const endpoints: Endpoint[] = [];

  if (station.nodeId) {
    const sn = await nodeRow(station.nodeId);
    if (sn) {
      const routed = domain?.ingestNodeId === sn.id ? domain.ingestHost : null;
      const ports = (await inboundPorts(ctx, sn)).filter((p) => p.service !== 'legacy' || p.station === station.slug).map((p) => ({ service: p.service, port: p.port, ...(p.to ? { to: p.to } : {}), ...(p.service === 'encoderTls' ? { tls: true } : {}), ...(p.old ? { old: true } : {}) }));
      endpoints.push({ role: 'stationNode', name: sn.name, node: { id: sn.id, name: sn.name }, online: !!sn.status.online, external: routed ?? externalAddress(sn), internal: internalAddress(sn), ports });
      return { endpoints, panelUrl, upload: uploadPorts(STATION_NODE_STREAMING) };
    }
  }

  const routing = stationRouting(station);
  for (const i of ingestsOf(routing)) {
    const role = i.priority === 0 ? 'ingest' : 'backupIngest';
    if (i.ref === 'local') {
      if (orchestrator.only) continue;
      // Encoders may come through the customer's source node, which passes them on to this server.
      const viaNode = i.priority === 0 ? conn.node : null;
      endpoints.push({
        role,
        name: viaNode?.name ?? names.ingest,
        node: viaNode,
        online: true,
        external: i.priority === 0 ? conn.ingestHost : (conn.backup?.host ?? conn.ingestHost),
        internal: null,
        ports: [
          { service: 'encoderTls' as const, port: conn.tls.port, tls: true },
          ...(streaming.ingestPlainPort ? [{ service: 'encoderPlain' as const, port: streaming.ingestPlainPort }] : []),
          ...(station.legacyPort && !viaNode ? [{ service: 'legacy' as const, port: station.legacyPort, to: station.legacyPort + 1 }] : []),
          // Old ports (port plan, 1.3) after the new ones, while this server keeps them.
          ...(orchestrator.oldPorts && !viaNode && conn.tls.port !== OLD_PORTS.tls ? [{ service: 'encoderTls' as const, port: OLD_PORTS.tls, tls: true, old: true }] : []),
          ...(orchestrator.oldPorts && !viaNode && streaming.ingestPlainPort && streaming.ingestPlainPort !== OLD_PORTS.plain ? [{ service: 'encoderPlain' as const, port: OLD_PORTS.plain, old: true }] : []),
        ].filter((p) => p.service !== 'encoderTls' || (i.priority === 0 ? conn.tls.available : !!conn.backup?.tls.available)),
      });
      continue;
    }
    const n = await nodeRow(i.ref);
    if (!n) continue;
    const c = nodeSettings(n);
    const tlsOk = !!c.sourceTlsPort && !!n.status.caddy && publicName(domain?.ingestNodeId === n.id ? domain.ingestHost : nodeHost(n));
    endpoints.push({
      role,
      name: n.name,
      node: { id: n.id, name: n.name },
      online: !!n.status.online,
      external: domain?.ingestNodeId === n.id ? domain.ingestHost : externalAddress(n),
      // The address on the customer's own network only for the customer's own node.
      internal: n.tenantId === station.tenantId ? internalAddress(n) : null,
      ports: [
        ...(c.sourceTlsPort && tlsOk ? [{ service: 'encoderTls' as const, port: c.sourceTlsPort, tls: true }] : []),
        ...(c.sourcePlainPort ? [{ service: 'encoderPlain' as const, port: c.sourcePlainPort }] : []),
        ...(c.oldPorts && c.sourceTlsPort && tlsOk && c.sourceTlsPort !== OLD_PORTS.tls ? [{ service: 'encoderTls' as const, port: OLD_PORTS.tls, tls: true, old: true }] : []),
        ...(c.oldPorts && c.sourcePlainPort && c.sourcePlainPort !== OLD_PORTS.plain ? [{ service: 'encoderPlain' as const, port: OLD_PORTS.plain, old: true }] : []),
      ],
    });
  }
  // Without a station node the library is on this server; an orchestrator only takes no uploads.
  const upload = orchestrator.only ? null : uploadPorts(streaming);
  if (upload && (upload.sftpPort || upload.ftpPort)) endpoints.push({ role: 'uploads', name: names.orchestrator, node: null, online: true, external: conn.uploadHost, internal: null, ports: uploadList(upload) });
  return { endpoints, panelUrl, upload };
}
