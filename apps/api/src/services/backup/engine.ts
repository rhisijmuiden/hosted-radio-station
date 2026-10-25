import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnyTargetConfig, TargetType } from './targets.js';
import { rcloneSetup, tokenFromConf } from './targets.js';

/** Everything restic needs to reach one repository: environment with the rclone config and the password. */
export interface Remote {
  repo: string;
  env: NodeJS.ProcessEnv;
  /** OAuth token after the run, when rclone refreshed it (OneDrive). */
  readToken: () => Promise<string | null>;
}

export interface Target {
  type: TargetType;
  config: AnyTargetConfig;
  repoPassword: string;
}

/** Writes a private rclone.conf in a temporary folder, runs `fn`, and always removes the folder again. */
export async function withRemote<T>(target: Target, fn: (remote: Remote) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'hrs-backup-'));
  await chmod(dir, 0o700);
  try {
    const confPath = join(dir, 'rclone.conf');
    const { conf, repo, knownHosts } = rcloneSetup(target.type, target.config, join(dir, 'known_hosts'));
    await writeFile(confPath, conf, { mode: 0o600 });
    if (knownHosts) await writeFile(join(dir, 'known_hosts'), knownHosts, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? dir,
      LANG: 'C.UTF-8',
      RCLONE_CONFIG: confPath,
      RESTIC_PASSWORD: target.repoPassword,
      RESTIC_PROGRESS_FPS: '0.5',
    };
    return await fn({
      repo,
      env,
      readToken: async () => tokenFromConf(await readFile(confPath, 'utf8').catch(() => '')),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
  }
}

/** Runs a program without a shell. Lines on stdout/stderr are passed to `onLine` while it runs. */
export function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; onLine?: (line: string, stream: 'out' | 'err') => void; timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const feed = (stream: 'out' | 'err') => {
      let rest = '';
      return (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stream === 'out') stdout = (stdout + text).slice(-2_000_000);
        else stderr = (stderr + text).slice(-200_000);
        if (!opts.onLine) return;
        const lines = (rest + text).split('\n');
        rest = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) opts.onLine(l, stream);
      };
    };
    child.stdout.on('data', feed('out'));
    child.stderr.on('data', feed('err'));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(opts.input ?? '');
  });
}

/** The last meaningful error line of restic or rclone, without timestamps. */
export function errorLine(res: RunResult) {
  const lines = res.stderr
    .split('\n')
    .map((l) => l.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, '').trim())
    .filter((l) => l && !l.startsWith('{'));
  const fatal = lines.find((l) => l.startsWith('Fatal:')) ?? lines.findLast((l) => /error|failed|denied|refused|timeout/i.test(l)) ?? lines.at(-1);
  return (fatal ?? `exit code ${res.code}`).replace(/^Fatal:\s*/, '').slice(0, 500);
}

export const restic = (remote: Remote, args: string[], opts: Parameters<typeof run>[2] = {}) =>
  run('restic', ['-r', remote.repo, ...args], { ...opts, env: { ...remote.env, ...opts.env } });

const NO_REPO = /does not exist|Is there a repository|unable to open config file|config: not found|no such file or directory|repository not found|object not found/i;
const WRONG_PASSWORD = /wrong password|no key found/i;

export type RepoState = 'ready' | 'empty' | 'wrong_password';

/** Looks at the repository without changing anything. Throws when the location cannot be reached. */
export async function repositoryState(remote: Remote): Promise<RepoState> {
  const res = await restic(remote, ['cat', 'config', '--no-cache', '--no-lock'], { timeoutMs: 120_000 });
  if (res.code === 0) return 'ready';
  const text = `${res.stderr}\n${res.stdout}`;
  if (WRONG_PASSWORD.test(text)) return 'wrong_password';
  if (res.code === 10 || NO_REPO.test(text)) {
    // "does not exist" can also mean the folder above it is missing or not readable; rclone tells us which.
    return 'empty';
  }
  throw new CommandError(errorLine(res), res);
}

export async function initRepository(remote: Remote) {
  const res = await restic(remote, ['init', '--no-cache'], { timeoutMs: 300_000 });
  if (res.code !== 0) throw new CommandError(`Creating the backup repository failed: ${errorLine(res)}`, res);
}

/** Makes sure the repository exists and the password fits; creates it when the location is empty. */
export async function ensureRepository(remote: Remote) {
  const state = await repositoryState(remote);
  if (state === 'wrong_password') throw new Error('The recovery key does not match the backup repository at this location');
  if (state === 'empty') await initRepository(remote);
  return state;
}

export interface Snapshot {
  id: string;
  shortId: string;
  time: string;
  hostname: string;
  tags: string[];
  paths: string[];
  kind: 'full' | 'incremental' | 'unknown';
  sizeBytes: number | null;
  filesNew: number | null;
}

export async function listSnapshots(remote: Remote): Promise<Snapshot[]> {
  const res = await restic(remote, ['snapshots', '--json', '--no-cache', '--no-lock'], { timeoutMs: 300_000 });
  if (res.code !== 0) throw new CommandError(errorLine(res), res);
  const raw = JSON.parse(res.stdout || '[]') as Array<{
    id: string;
    short_id: string;
    time: string;
    hostname: string;
    tags?: string[];
    paths: string[];
    summary?: { total_bytes_processed?: number; files_new?: number };
  }>;
  return raw
    .map((s) => ({
      id: s.id,
      shortId: s.short_id,
      time: s.time,
      hostname: s.hostname,
      tags: s.tags ?? [],
      paths: s.paths,
      kind: (s.tags?.includes('full') ? 'full' : s.tags?.includes('incremental') ? 'incremental' : 'unknown') as Snapshot['kind'],
      sizeBytes: s.summary?.total_bytes_processed ?? null,
      filesNew: s.summary?.files_new ?? null,
    }))
    .sort((a, b) => b.time.localeCompare(a.time));
}

export interface BackupSummary {
  snapshotId: string;
  filesNew: number;
  filesChanged: number;
  bytesAdded: number;
  bytesTotal: number;
  warnings: boolean;
}

/**
 * Full = every file is read again and stored as a complete, independent snapshot (`--force`).
 * Incremental = only files that changed since the previous snapshot are read.
 * Both kinds can be restored on their own; restic deduplicates, so a full backup costs little extra space.
 */
export async function runBackup(
  remote: Remote,
  opts: { kind: 'full' | 'incremental'; paths: string[]; excludes: string[]; host: string },
  log: (line: string) => void,
  progress: (text: string) => void,
): Promise<BackupSummary> {
  await restic(remote, ['unlock'], { timeoutMs: 120_000 }); // removes stale locks of a crashed run, never live ones
  const args = ['backup', '--json', '--host', opts.host, '--tag', 'hrs', '--tag', opts.kind, '--one-file-system'];
  if (opts.kind === 'full') args.push('--force');
  for (const e of opts.excludes) args.push('--exclude', e);
  args.push(...opts.paths);
  let summary: BackupSummary | null = null;
  const res = await restic(remote, args, {
    onLine: (line, stream) => {
      if (stream === 'err') return log(line);
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.message_type === 'status') {
          const pct = Math.round(Number(msg.percent_done ?? 0) * 100);
          progress(`${pct}% · ${formatBytes(Number(msg.bytes_done ?? 0))} / ${formatBytes(Number(msg.total_bytes ?? 0))}`);
        } else if (msg.message_type === 'summary') {
          summary = {
            snapshotId: String(msg.snapshot_id ?? ''),
            filesNew: Number(msg.files_new ?? 0),
            filesChanged: Number(msg.files_changed ?? 0),
            bytesAdded: Number(msg.data_added ?? 0),
            bytesTotal: Number(msg.total_bytes_processed ?? 0),
            warnings: false,
          };
          log(`Snapshot ${summary.snapshotId.slice(0, 8)} saved: ${summary.filesNew} new and ${summary.filesChanged} changed files, ${formatBytes(summary.bytesAdded)} added.`);
        } else if (msg.message_type === 'error') {
          log(`Warning: ${JSON.stringify(msg.error ?? msg)} ${msg.item ?? ''}`);
        }
      } catch {
        log(line);
      }
    },
  });
  // Exit code 3: snapshot written, but some files could not be read.
  if ((res.code === 0 || res.code === 3) && summary) return { ...(summary as BackupSummary), warnings: res.code === 3 };
  throw new CommandError(`Backup failed: ${errorLine(res)}`, res);
}

export async function applyRetention(remote: Remote, keep: { keepLast: number; keepDaily: number; keepWeekly: number; keepMonthly: number }, host: string, log: (line: string) => void) {
  const args = ['forget', '--prune', '--host', host, '--tag', 'hrs'];
  if (keep.keepLast) args.push('--keep-last', String(keep.keepLast));
  if (keep.keepDaily) args.push('--keep-daily', String(keep.keepDaily));
  if (keep.keepWeekly) args.push('--keep-weekly', String(keep.keepWeekly));
  if (keep.keepMonthly) args.push('--keep-monthly', String(keep.keepMonthly));
  if (args.length === 6) return; // nothing configured: keep everything
  const res = await restic(remote, args, { onLine: (l) => log(l) });
  if (res.code !== 0) throw new CommandError(`Cleaning up old backups failed: ${errorLine(res)}`, res);
}

export async function restoreSnapshot(remote: Remote, snapshotId: string, targetDir: string, log: (line: string) => void) {
  const res = await restic(remote, ['restore', snapshotId, '--target', targetDir], { onLine: (l) => log(l) });
  if (res.code !== 0) throw new CommandError(`Downloading the snapshot failed: ${errorLine(res)}`, res);
}

/** Checks that the location itself can be reached with these credentials (before restic gets involved). */
export async function checkLocation(target: Target, remote: Remote) {
  if (target.type === 'local') {
    const res = await run('test', ['-d', remote.repo.replace(/\/[^/]+\/?$/, '') || '/']);
    if (res.code !== 0) throw new Error('The parent folder does not exist on this server');
    return;
  }
  const res = await run('rclone', ['lsf', '--max-depth', '1', '--low-level-retries', '1', '--retries', '1', '--contimeout', '15s', '--timeout', '30s', 'hrs:'], {
    env: remote.env,
    timeoutMs: 90_000,
  });
  if (res.code !== 0) throw new CommandError(`Cannot connect: ${errorLine(res)}`, res);
  await createFolder(remote);
}

/** Creates the backup folder on the remote side; some FTP servers refuse to open a folder that does not exist yet. */
export async function createFolder(remote: Remote) {
  if (!remote.repo.startsWith('rclone:')) return;
  const res = await run('rclone', ['mkdir', '--low-level-retries', '1', '--retries', '1', remote.repo.slice('rclone:'.length)], { env: remote.env, timeoutMs: 90_000 });
  if (res.code !== 0) throw new CommandError(`Cannot create the backup folder: ${errorLine(res)}`, res);
}

export function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
