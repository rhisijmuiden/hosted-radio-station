import { and, eq, isNotNull } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { nodeSettings } from '../nodes/plan.js';
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
  /** Where files are uploaded (SFTP/FTP always run on this server). */
  uploadHost: string;
  tls: { port: number; available: boolean };
  plain: { port: number } | null;
  legacy: { port: number; sourcePort: number; mount: string | null } | null;
  /** Base of the listen URLs, e.g. https://stream.example.com */
  listenBase: string;
  mounts: { id: string; path: string; encoderMount: string; listenUrl: string | null }[];
}

/** Everything a DJ needs to set up an encoder, and the listen URLs of the public mounts. */
export async function connectionInfo(ctx: AppContext, station: Station, mounts: Mount[], localEnabled: boolean): Promise<ConnectionInfo> {
  const [proxy, streaming, domain] = await Promise.all([getSetting(ctx, 'proxy'), getSetting(ctx, 'streaming'), tenantDomain(ctx, station.tenantId)]);
  const publicUrl = new URL(ctx.config.PUBLIC_URL);
  const ingestHost = domain?.ingestHost ?? (proxy.domain || publicUrl.hostname);
  const listenBase = domain ? `https://${domain.panelHost}` : ctx.config.PUBLIC_URL.replace(/\/$/, '');
  const legacyMount = mounts.find((m) => m.id === station.legacyMountId) ?? mounts.find((m) => m.kind === 'source') ?? null;
  const [node] = domain?.ingestNodeId
    ? await ctx.db.select().from(schema.nodes).where(and(eq(schema.nodes.id, domain.ingestNodeId), isNotNull(schema.nodes.pairedAt)))
    : [];
  if (node?.roles.includes('source')) {
    // Encoders go to the customer's source node, which passes them on to this server.
    const c = nodeSettings(node);
    return {
      ingestHost,
      node: { id: node.id, name: node.name },
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
    uploadHost: ingestHost,
    // Certificates come from the built-in web server; behind an external proxy, TLS for encoders is set up there.
    tls: { port: streaming.ingestTlsPort, available: proxy.mode === 'builtin' && (!!domain || !!proxy.domain) },
    plain: streaming.ingestPlainPort ? { port: streaming.ingestPlainPort } : null,
    legacy: station.legacyPort ? { port: station.legacyPort, sourcePort: station.legacyPort + 1, mount: legacyMount?.path ?? null } : null,
    listenBase,
    mounts: mounts.map((m) => ({
      id: m.id,
      path: m.path,
      encoderMount: `/${station.slug}${m.path}`,
      listenUrl: m.isPublic && localEnabled ? `${listenBase}/listen/${station.slug}${m.path}` : null,
    })),
  };
}
