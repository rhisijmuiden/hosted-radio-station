import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dataPath, writeAtomic } from './config.js';

/**
 * Privileged work on the node (Caddy, certificates, restarting Icecast, updating the code) is done by root-owned
 * helpers that systemd starts when a request file appears in run/ (see deploy/node). The agent itself runs unprivileged.
 */
export interface WebState {
  web: 'caddy' | 'direct';
  publicHost: string | null;
  /** Port of the plain HTTP site (Caddy) or of Icecast itself (direct). */
  listenPort: number;
  icecastPort: number;
  icecastBind: string;
  /** Names the web server gets certificates for (the node's own and customer encoder names). */
  certHosts: string[];
  /** The node has the station node role: the root helper installs and links the station runtime (phase 12). */
  station: boolean;
  /** The node makes converted mounts as an ingest: the root helper installs ffmpeg when it is missing (phase 13). */
  ffmpeg: boolean;
}

export interface JobStatus {
  id?: string;
  state: 'idle' | 'running' | 'succeeded' | 'failed';
  message?: string;
  problems?: string[];
  /** The end of the log when the job failed. */
  log?: string[];
  at?: string;
}

const run = (name: string) => dataPath('run', name);

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

let lastWeb = '';

/** Hands the web server settings to the root helper when they changed. */
export async function applyWeb(state: WebState) {
  const body = JSON.stringify(state);
  if (body === lastWeb) return false;
  lastWeb = body;
  await writeAtomic(run('apply-state.json'), JSON.stringify(state, null, 2), 0o640);
  await writeAtomic(run('apply-request.json'), JSON.stringify({ id: randomBytes(8).toString('hex'), at: new Date().toISOString() }), 0o640);
  return true;
}

export const applyStatus = () => readJson<JobStatus>(run('apply-status.json'));

/** Asks the root helper to update the node to a version of the main server. */
export async function requestUpdate(branch: string | null, commit: string | null) {
  const id = randomBytes(8).toString('hex');
  await writeAtomic(run('update-request.json'), JSON.stringify({ id, branch, commit, at: new Date().toISOString() }), 0o640);
  return id;
}

export const updateStatus = () => readJson<JobStatus>(run('update-status.json'));
