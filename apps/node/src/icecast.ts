import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dataPath, ports, writeAtomic } from './config.js';
import type { RelayMount } from './protocol.js';

/** The user agent of everything the node itself sends; the main server leaves it out of its statistics. */
export const AGENT = 'Hosted Radio Station node';

const xml = (v: string | number) =>
  String(v).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

export const icecastDir = () => dataPath('icecast');
export const icecastConfigPath = () => dataPath('icecast', 'icecast.xml');
export const icecastPidPath = () => dataPath('icecast', 'icecast.pid');

export interface IcecastSecrets {
  source: string;
  admin: string;
}

/** Passwords of the node's own Icecast server, made once. Only the agent and Icecast use them. */
export async function icecastSecrets(): Promise<IcecastSecrets> {
  const path = dataPath('icecast', 'secrets.json');
  try {
    const s = JSON.parse(await readFile(path, 'utf8')) as IcecastSecrets;
    if (s.source && s.admin) return s;
  } catch {
    /* first start */
  }
  const s = { source: randomBytes(18).toString('base64url'), admin: randomBytes(18).toString('base64url') };
  await writeAtomic(path, JSON.stringify(s));
  return s;
}

export interface IcecastLayout {
  /** 127.0.0.1 behind Caddy, 0.0.0.0 when listeners connect to Icecast directly. */
  bind: string;
  port: number;
}

/** Mount name on the node: the same path as the listen route of the main server, so URLs look alike. */
export const localMount = (m: Pick<RelayMount, 'slug' | 'path'>) => `/listen/${m.slug}${m.path}`;

export function renderIcecastConfig(input: { name: string; hostname: string; layout: IcecastLayout; mounts: RelayMount[]; maxListeners: number; secrets: IcecastSecrets }): string {
  const { mounts, layout } = input;
  const hook = `http://127.0.0.1:${ports.hooks}/hook`;
  const mountXml = mounts
    .map((m) =>
      [
        `  <mount type="normal">`,
        `    <mount-name>${xml(localMount(m))}</mount-name>`,
        `    <stream-name>${xml(m.name)}</stream-name>`,
        `    <public>0</public>`,
        m.format === 'mp3' || m.format === 'aac' ? `    <charset>UTF-8</charset>` : '',
        `    <authentication type="url">`,
        `      <option name="listener_add" value="${xml(`${hook}/add`)}" />`,
        `      <option name="listener_remove" value="${xml(`${hook}/remove`)}" />`,
        `      <option name="auth_header" value="icecast-auth-user: 1" />`,
        `      <option name="headers" value="x-hrs-client,referer" />`,
        `      <option name="header_prefix" value="h_" />`,
        `    </authentication>`,
        `  </mount>`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
  const clients = input.maxListeners ? input.maxListeners + mounts.length + 10 : 100_000;
  const dir = icecastDir();
  return `<!-- Managed by the Hosted Radio Station node agent. Changes are overwritten. -->
<icecast>
  <location>${xml(input.name)}</location>
  <admin>noreply@${xml(input.hostname)}</admin>
  <hostname>${xml(input.hostname)}</hostname>
  <limits>
    <clients>${clients}</clients>
    <sources>${mounts.length + 2}</sources>
    <queue-size>1048576</queue-size>
    <client-timeout>30</client-timeout>
    <header-timeout>15</header-timeout>
    <source-timeout>10</source-timeout>
    <burst-on-connect>1</burst-on-connect>
    <burst-size>65535</burst-size>
  </limits>
  <authentication>
    <source-password>${xml(input.secrets.source)}</source-password>
    <relay-password>${xml(input.secrets.source)}</relay-password>
    <admin-user>admin</admin-user>
    <admin-password>${xml(input.secrets.admin)}</admin-password>
  </authentication>
  <listen-socket>
    <port>${layout.port}</port>
    <bind-address>${xml(layout.bind)}</bind-address>
  </listen-socket>
  <http-headers>
    <header name="Access-Control-Allow-Origin" value="*" />
  </http-headers>
${mountXml}
  <fileserve>1</fileserve>
  <paths>
    <basedir>/usr/share/icecast2</basedir>
    <logdir>${xml(`${dir}/logs`)}</logdir>
    <webroot>/usr/share/icecast2/web</webroot>
    <adminroot>/usr/share/icecast2/admin</adminroot>
    <pidfile>${xml(icecastPidPath())}</pidfile>
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

/** Asks the running Icecast to read its configuration again (keeps listeners connected). */
export async function reloadIcecast(): Promise<boolean> {
  try {
    const pid = Number((await readFile(icecastPidPath(), 'utf8')).trim());
    if (pid > 1) {
      process.kill(pid, 'SIGHUP');
      return true;
    }
  } catch {
    /* not running */
  }
  return false;
}

export interface IcecastClient {
  id: string;
  ip: string;
  userAgent: string;
  connectedSeconds: number;
}

const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'))?.[1] ?? '';

/** Parses /admin/listclients. Exported for tests. */
export function parseClients(body: string): IcecastClient[] {
  return [...body.matchAll(/<listener[^>]*>([\s\S]*?)<\/listener>/gi)].map((m) => ({
    id: tag(m[1]!, 'ID'),
    ip: tag(m[1]!, 'IP'),
    userAgent: tag(m[1]!, 'UserAgent').replace(/&amp;/g, '&'),
    connectedSeconds: Number(tag(m[1]!, 'Connected')) || 0,
  }));
}

async function admin(port: number, password: string, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`, 'user-agent': AGENT },
    signal: AbortSignal.timeout(4000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`icecast answered ${res.status}`);
  return body;
}

export const listClients = async (port: number, password: string, mount: string) =>
  parseClients(await admin(port, password, `/admin/listclients?mount=${encodeURIComponent(mount)}`));

export const updateTitle = (port: number, password: string, mount: string, title: string) =>
  admin(port, password, `/admin/metadata?${new URLSearchParams({ mount, mode: 'updinfo', song: title, charset: 'UTF-8' })}`);

export const killClient = (port: number, password: string, mount: string, id: string) => admin(port, password, `/admin/killclient?${new URLSearchParams({ mount, id })}`);
