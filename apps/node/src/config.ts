import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Where the agent keeps things. The installer creates these; tests point them elsewhere with the environment. */
export const paths = {
  config: process.env.HRS_NODE_CONFIG ?? '/etc/hrs-node/node.json',
  data: process.env.HRS_NODE_DATA ?? '/var/lib/hrs-node',
  install: process.env.HRS_NODE_INSTALL ?? '/opt/hrs-node',
};
export const dataPath = (...p: string[]) => join(paths.data, ...p);

/** Choices of the installer (phase 16), kept for pairing later from the setup page or the shell. */
export interface InstallFile {
  /** Web mode the node pairs with, see NodeFile.web. */
  web: 'caddy' | 'direct';
  /** Serve the setup page on port 8080 while the node is not paired. */
  setupPage: boolean;
}

export const installFilePath = () => process.env.HRS_NODE_INSTALL_FILE ?? join(dirname(paths.config), 'install.json');

export function readInstallFile(): InstallFile {
  try {
    const f = JSON.parse(readFileSync(installFilePath(), 'utf8')) as Partial<InstallFile>;
    return { web: f.web === 'direct' ? 'direct' : 'caddy', setupPage: f.setupPage !== false };
  } catch {
    return { web: 'caddy', setupPage: true };
  }
}

/** Ports on the node itself. Icecast listens on 127.0.0.1 behind Caddy (or publicly without it). */
export const ports = {
  icecast: Number(process.env.HRS_NODE_ICECAST_PORT ?? 17000),
  hooks: Number(process.env.HRS_NODE_HOOK_PORT ?? 17001),
};

export interface NodeFile {
  /** Base URL of the main server, e.g. https://radio.example.com */
  server: string;
  nodeId: string;
  secret: string;
  name?: string;
  /** caddy = the node's own web server serves listeners (HTTPS with a domain); direct = Icecast does. */
  web: 'caddy' | 'direct';
}

export function readNodeFile(path = paths.config): NodeFile | null {
  try {
    const f = JSON.parse(readFileSync(path, 'utf8')) as Partial<NodeFile>;
    if (!f.server || !f.nodeId || !f.secret) return null;
    return { server: f.server.replace(/\/$/, ''), nodeId: f.nodeId, secret: f.secret, name: f.name, web: f.web === 'direct' ? 'direct' : 'caddy' };
  } catch {
    return null;
  }
}

export async function writeAtomic(path: string, data: string, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

export function readVersion(): { version: string; commit: string | null } {
  let version = '0.0.0';
  let commit: string | null = null;
  try {
    version = JSON.parse(readFileSync(join(paths.install, 'package.json'), 'utf8')).version;
  } catch {
    /* not a checkout */
  }
  try {
    // Read the commit without running git (the checkout belongs to root).
    const head = readFileSync(join(paths.install, '.git', 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) commit = head;
    else if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      try {
        commit = readFileSync(join(paths.install, '.git', ref), 'utf8').trim();
      } catch {
        const packed = readFileSync(join(paths.install, '.git', 'packed-refs'), 'utf8');
        commit = packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] ?? null;
      }
    }
  } catch {
    /* no git metadata */
  }
  return { version, commit };
}
