import { join } from 'node:path';
import type { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';

type Station = typeof schema.stations.$inferSelect;
type Mount = typeof schema.stationMounts.$inferSelect;

export const stationDir = (ctx: AppContext, stationId: string) => join(ctx.config.DATA_DIR, 'stations', stationId);
export const mediaDir = (ctx: AppContext, stationId: string) => join(stationDir(ctx, stationId), 'media');
export const icecastConfigPath = (ctx: AppContext, stationId: string) => join(stationDir(ctx, stationId), 'icecast.xml');
export const icecastPidPath = (ctx: AppContext, stationId: string) => join(stationDir(ctx, stationId), 'icecast.pid');

const xml = (v: string | number) =>
  String(v).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

export const CONTENT_TYPES: Record<Mount['format'], string> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  vorbis: 'audio/ogg',
};

export interface IcecastConfigInput {
  station: Station;
  mounts: Mount[];
  hostname: string;
  adminPassword: string;
  sourcePassword: string;
  /** Extra connections for relays and transcoders that listen on this server. */
  internalClients: number;
  /** Base URL of the listener hooks (statistics), or null to leave them out. */
  listenerHook?: string | null;
}

/** The icecast.xml of one station. Only reachable on 127.0.0.1; the web server and the ingest gateway sit in front. */
/**
 * Icecast reports every listener that connects and disconnects to the streams service, with the listener's real
 * address that the web server passes in X-Hrs-Client. The web server answers "allowed" itself when the streams
 * service is down, so listening never depends on it.
 */
function listenerAuth(base: string) {
  return [
    `    <authentication type="url">`,
    `      <option name="listener_add" value="${xml(`${base}/add`)}" />`,
    `      <option name="listener_remove" value="${xml(`${base}/remove`)}" />`,
    `      <option name="auth_header" value="icecast-auth-user: 1" />`,
    `      <option name="headers" value="x-hrs-client,x-hrs-via,referer" />`,
    `      <option name="header_prefix" value="h_" />`,
    `    </authentication>`,
  ].join('\n');
}

export function renderIcecastConfig(ctx: AppContext, input: IcecastConfigInput): string {
  const { station, mounts } = input;
  const dir = stationDir(ctx, station.id);
  const byId = new Map(mounts.map((m) => [m.id, m]));
  const mountXml = mounts
    .map((m) => {
      const fallback = m.fallbackMountId ? byId.get(m.fallbackMountId) : undefined;
      const lines = [
        `    <mount-name>${xml(m.path)}</mount-name>`,
        m.maxListeners ? `    <max-listeners>${m.maxListeners + input.internalClients}</max-listeners>` : '',
        fallback ? `    <fallback-mount>${xml(fallback.path)}</fallback-mount>\n    <fallback-override>1</fallback-override>` : '',
        `    <stream-name>${xml(m.name ? `${station.name} – ${m.name}` : station.name)}</stream-name>`,
        station.description ? `    <stream-description>${xml(station.description)}</stream-description>` : '',
        station.genre ? `    <genre>${xml(station.genre)}</genre>` : '',
        station.website ? `    <stream-url>${xml(station.website)}</stream-url>` : '',
        `    <public>0</public>`,
        m.isPublic ? '' : `    <hidden>1</hidden>`,
        // Encoders that do not say otherwise send UTF-8 titles.
        m.format === 'mp3' || m.format === 'aac' ? `    <charset>UTF-8</charset>` : '',
        input.listenerHook ? listenerAuth(`${input.listenerHook}/icecast/${station.id}`) : '',
      ].filter(Boolean);
      return `  <mount type="normal">\n${lines.join('\n')}\n  </mount>`;
    })
    .join('\n');

  return `<!-- Managed by Hosted Radio Station for station "${xml(station.slug)}". Changes are overwritten. -->
<icecast>
  <location>${xml(station.name)}</location>
  <admin>noreply@${xml(input.hostname)}</admin>
  <hostname>${xml(input.hostname)}</hostname>
  <limits>
    <clients>${station.maxListeners + input.internalClients + 10}</clients>
    <sources>${mounts.length + 2}</sources>
    <queue-size>1048576</queue-size>
    <client-timeout>30</client-timeout>
    <header-timeout>15</header-timeout>
    <source-timeout>10</source-timeout>
    <burst-on-connect>1</burst-on-connect>
    <burst-size>65535</burst-size>
  </limits>
  <authentication>
    <source-password>${xml(input.sourcePassword)}</source-password>
    <relay-password>${xml(input.sourcePassword)}</relay-password>
    <admin-user>admin</admin-user>
    <admin-password>${xml(input.adminPassword)}</admin-password>
  </authentication>
  <listen-socket>
    <port>${station.icecastPort}</port>
    <bind-address>127.0.0.1</bind-address>
  </listen-socket>
  <http-headers>
    <header name="Access-Control-Allow-Origin" value="*" />
  </http-headers>
${mountXml}
  <fileserve>1</fileserve>
  <paths>
    <basedir>/usr/share/icecast2</basedir>
    <logdir>${xml(join(dir, 'logs'))}</logdir>
    <webroot>/usr/share/icecast2/web</webroot>
    <adminroot>/usr/share/icecast2/admin</adminroot>
    <pidfile>${xml(join(dir, 'icecast.pid'))}</pidfile>
  </paths>
  <logging>
    <accesslog>access.log</accesslog>
    <errorlog>error.log</errorlog>
    <loglevel>3</loglevel>
    <logsize>10000</logsize>
    <logarchive>0</logarchive>
  </logging>
  <security>
    <chroot>0</chroot>
  </security>
</icecast>
`;
}

// Admin client

export interface IcecastTarget {
  port: number;
  adminPassword: string;
  host?: string;
}

export interface MountStats {
  mount: string;
  listeners: number;
  listenerPeak: number;
  title: string | null;
  bitrateKbps: number | null;
  contentType: string | null;
  sourceIp: string | null;
  userAgent: string | null;
  streamStart: string | null;
  bytesRead: number;
  bytesSent: number;
}

function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!;
  });
}

/** Icecast decodes legacy titles as Latin-1 and re-encodes them; turn "TÃ­tle" back into "Títle" where possible. */
function fixMojibake(s: string) {
  if (!/[Â-ô][\u0080-¿]/.test(s)) return s;
  const bytes = Buffer.from(s, 'latin1');
  const utf8 = bytes.toString('utf8');
  return utf8.includes('�') ? s : utf8;
}

/** Parses /admin/stats. Exported for tests. */
export function parseStats(body: string): MountStats[] {
  const out: MountStats[] = [];
  for (const m of body.matchAll(/<source mount="([^"]*)">([\s\S]*?)<\/source>/g)) {
    const fields: Record<string, string> = {};
    for (const f of m[2]!.matchAll(/<([a-z_0-9]+)>([^<]*)<\/\1>/g)) fields[f[1]!] = decodeEntities(f[2]!);
    // Sources report their bitrate in different fields: "bitrate" (kbps), "audio_bitrate" (bps) or ice-audio-info.
    let bitrate = fields.bitrate ? Number(fields.bitrate) : fields.audio_bitrate ? Number(fields.audio_bitrate) / 1000 : NaN;
    if (Number.isNaN(bitrate) && fields.audio_info) {
      const b = fields.audio_info.match(/(?:ice-)?bitrate=(\d+)/);
      if (b) bitrate = Number(b[1]);
    }
    out.push({
      mount: decodeEntities(m[1]!),
      listeners: Number(fields.listeners ?? 0),
      listenerPeak: Number(fields.listener_peak ?? 0),
      title: fields.title !== undefined ? fixMojibake(fields.title) : null,
      bitrateKbps: Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : null,
      contentType: fields.server_type ?? null,
      sourceIp: fields.source_ip ?? null,
      userAgent: fields.user_agent ?? null,
      streamStart: fields.stream_start_iso8601 ?? null,
      bytesRead: Number(fields.total_bytes_read ?? 0),
      bytesSent: Number(fields.total_bytes_sent ?? 0),
    });
  }
  return out;
}

async function adminRequest(t: IcecastTarget, path: string, timeoutMs = 3000) {
  const res = await fetch(`http://${t.host ?? '127.0.0.1'}:${t.port}${path}`, {
    headers: { authorization: `Basic ${Buffer.from(`admin:${t.adminPassword}`).toString('base64')}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Icecast answered ${res.status}`);
  return body;
}

/** Live mounts of a station's Icecast server. Throws when the server is not running. */
export async function fetchStats(t: IcecastTarget): Promise<MountStats[]> {
  return parseStats(await adminRequest(t, '/admin/stats'));
}

/** User agent of the transcoders and relays of the streams service; these readers are not listeners. */
export const INTERNAL_AGENT = 'Hosted Radio Station';

export interface IcecastClient {
  id: string;
  ip: string;
  userAgent: string;
  connectedSeconds: number;
}

/** Parses /admin/listclients. Exported for tests. */
export function parseClients(body: string): IcecastClient[] {
  return [...body.matchAll(/<listener[^>]*>([\s\S]*?)<\/listener>/g)].map((m) => {
    const f: Record<string, string> = {};
    for (const x of m[1]!.matchAll(/<([A-Za-z]+)>([^<]*)<\/\1>/g)) f[x[1]!] = decodeEntities(x[2]!);
    return { id: f.ID ?? '', ip: f.IP ?? '', userAgent: f.UserAgent ?? '', connectedSeconds: Number(f.Connected ?? 0) };
  });
}

/** Everyone connected to a mount, listeners and our own readers alike. */
export async function listClients(t: IcecastTarget, mount: string) {
  return parseClients(await adminRequest(t, `/admin/listclients?mount=${encodeURIComponent(mount)}`));
}

/** Number of readers of a mount that belong to the streams service (transcoders, relays). */
export async function internalReaders(t: IcecastTarget, mount: string) {
  return (await listClients(t, mount)).filter((c) => c.userAgent.startsWith(INTERNAL_AGENT)).length;
}

/** Disconnects the encoder of a mount; listeners stay or move to the fallback mount. */
export async function killSource(t: IcecastTarget, mount: string) {
  await adminRequest(t, `/admin/killsource?mount=${encodeURIComponent(mount)}`);
}

/** Sets the now-playing title of an MP3/AAC mount. */
export async function updateMetadata(t: IcecastTarget, mount: string, title: string) {
  const q = new URLSearchParams({ mount, mode: 'updinfo', song: title, charset: 'UTF-8' });
  await adminRequest(t, `/admin/metadata?${q}`);
}
