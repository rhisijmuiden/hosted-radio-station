import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AppContext } from '../lib/context.js';
import { badRequest, HttpError } from '../lib/errors.js';
import type { ProxySettings } from './settings.js';

const run = promisify(execFile);

export const CHANNELS = ['main', 'test'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface VersionInfo {
  version: string;
  commit: string | null;
  commitDate: string | null;
  /** Git branch the installation runs from: main = production, test = test. */
  branch: string | null;
  node: string;
  helpers: boolean;
}

export interface UpdateCheck {
  channel: Channel;
  currentCommit: string | null;
  latestCommit: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  error: string | null;
}

export interface JobStatus {
  id: string | null;
  state: 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';
  channel?: string;
  fromCommit?: string;
  toCommit?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  log: string;
}

/** git refuses repositories owned by another user unless they are marked safe; /opt/hosted-radio is owned by root. */
async function git(ctx: AppContext, ...args: string[]) {
  const { stdout } = await run('git', ['-c', `safe.directory=${ctx.config.INSTALL_DIR}`, '-C', ctx.config.INSTALL_DIR, ...args], {
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

export async function getVersionInfo(ctx: AppContext): Promise<VersionInfo> {
  let version = '0.0.0';
  try {
    version = JSON.parse(await readFile(join(ctx.config.INSTALL_DIR, 'package.json'), 'utf8')).version;
  } catch {
    /* not a checkout */
  }
  const safe = (p: Promise<string>) => p.catch(() => null);
  const [commit, commitDate, branch] = await Promise.all([
    safe(git(ctx, 'rev-parse', 'HEAD')),
    safe(git(ctx, 'log', '-1', '--format=%cI')),
    safe(git(ctx, 'rev-parse', '--abbrev-ref', 'HEAD')),
  ]);
  return { version, commit, commitDate, branch, node: process.version, helpers: ctx.config.SYSTEM_HELPERS === '1' };
}

/** Compares the running commit with the head of the channel branch. Uses ls-remote, so the checkout is not touched. */
export async function checkForUpdates(ctx: AppContext, channel: Channel): Promise<UpdateCheck> {
  const info = await getVersionInfo(ctx);
  const checkedAt = new Date().toISOString();
  try {
    const out = await git(ctx, 'ls-remote', 'origin', `refs/heads/${channel}`);
    const latestCommit = out.split(/\s+/)[0] || null;
    if (!latestCommit) throw new Error(`Branch "${channel}" does not exist in the repository`);
    const updateAvailable = latestCommit !== info.commit || info.branch !== channel;
    return { channel, currentCommit: info.commit, latestCommit, updateAvailable, checkedAt, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n').find((l) => l.trim()) ?? err.message : String(err);
    return { channel, currentCommit: info.commit, latestCommit: null, updateAvailable: false, checkedAt, error: message };
  }
}

const runDir = (ctx: AppContext) => join(ctx.config.DATA_DIR, 'run');

async function writeAtomic(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o640 });
  await rename(tmp, path);
}

async function readJob(ctx: AppContext, name: 'update' | 'proxy'): Promise<JobStatus> {
  const dir = runDir(ctx);
  let status: JobStatus = { id: null, state: 'idle', log: '' };
  try {
    status = { ...status, ...JSON.parse(await readFile(join(dir, `${name}-status.json`), 'utf8')) };
  } catch {
    /* no job has run yet */
  }
  try {
    const request = JSON.parse(await readFile(join(dir, `${name}-request.json`), 'utf8'));
    if (request.id && request.id !== status.id) status = { ...status, id: request.id, state: 'queued' };
  } catch {
    /* no pending request */
  }
  try {
    // Strip terminal colour codes from pnpm/vite output; the panel shows the log as plain text.
    const log = (await readFile(join(dir, `${name}.log`), 'utf8')).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    status.log = log.split('\n').slice(-200).join('\n');
  } catch {
    /* no log */
  }
  return status;
}

/**
 * Privileged work (git checkout, build, restarting services, rewriting the Caddyfile) is done by root-owned
 * systemd units installed by install.sh. The API only drops a request file that a .path unit picks up.
 */
async function queueJob(ctx: AppContext, name: 'update' | 'proxy', payload: Record<string, unknown>, by: string) {
  if (ctx.config.SYSTEM_HELPERS !== '1') {
    throw new HttpError(501, 'helpers_missing', 'This action needs the system helpers that install.sh sets up');
  }
  const current = await readJob(ctx, name);
  if (current.state === 'queued' || current.state === 'running') throw new HttpError(409, 'busy', 'A job is already running');
  const dir = runDir(ctx);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  await writeAtomic(join(dir, `${name}-request.json`), { id, ...payload, requestedBy: by, requestedAt: new Date().toISOString() });
  return id;
}

export const getUpdateStatus = (ctx: AppContext) => readJob(ctx, 'update');
export const getProxyStatus = (ctx: AppContext) => readJob(ctx, 'proxy');

export function requestUpdate(ctx: AppContext, channel: Channel, by: string) {
  if (!CHANNELS.includes(channel)) throw badRequest('Unknown channel');
  return queueJob(ctx, 'update', { channel }, by);
}

export function requestProxyApply(ctx: AppContext, proxy: ProxySettings, by: string) {
  return queueJob(ctx, 'proxy', { ...proxy }, by);
}
