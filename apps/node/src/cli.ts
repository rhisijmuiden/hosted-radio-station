#!/usr/bin/env node
import { hostname } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { Agent } from './agent.js';
import { dataPath, paths, readNodeFile, readVersion, writeAtomic } from './config.js';
import { log } from './log.js';

function arg(args: string[], name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function pair(args: string[]) {
  const server = arg(args, 'server')?.replace(/\/$/, '');
  const code = arg(args, 'code');
  const web = arg(args, 'web') === 'direct' ? 'direct' : 'caddy';
  if (!server || !code) throw new Error('Usage: hrs-node pair --server https://radio.example.com --code XXXX-XXXX-XXXX [--web caddy|direct]');
  if (!/^https?:\/\//.test(server)) throw new Error('--server must start with http:// or https://');
  const res = await fetch(`${server}/api/nodes/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Hosted Radio Station node' },
    body: JSON.stringify({ code, hostname: hostname(), version: readVersion().version }),
    signal: AbortSignal.timeout(20_000),
  }).catch((err: Error) => {
    throw new Error(`The main server cannot be reached at ${server}: ${err.message}`);
  });
  const data = (await res.json().catch(() => null)) as { nodeId?: string; name?: string; secret?: string; error?: { message?: string } } | null;
  if (!res.ok || !data?.nodeId || !data.secret) throw new Error(data?.error?.message ?? `The main server answered ${res.status}`);
  await writeAtomic(paths.config, JSON.stringify({ server, nodeId: data.nodeId, secret: data.secret, name: data.name, web }, null, 2), 0o600);
  if (server.startsWith('http://')) console.log('Note: the main server is reached over plain HTTP. Use HTTPS in production, so the control channel is encrypted.');
  console.log(`Paired as "${data.name}" (${data.nodeId}).`);
}

async function status() {
  const file = readNodeFile();
  if (!file) {
    console.log('Not paired. Pair with: hrs-node pair --server <url> --code <code>');
    return;
  }
  const v = readVersion();
  const plan = JSON.parse(await readFile(dataPath('plan.json'), 'utf8').catch(() => 'null'));
  const update = JSON.parse(await readFile(dataPath('run', 'update-status.json'), 'utf8').catch(() => 'null'));
  const apply = JSON.parse(await readFile(dataPath('run', 'apply-status.json'), 'utf8').catch(() => 'null'));
  console.log(`Node:      ${file.name ?? ''} (${file.nodeId})`);
  console.log(`Server:    ${file.server}`);
  console.log(`Web:       ${file.web}`);
  console.log(`Version:   ${v.version} ${v.commit?.slice(0, 7) ?? ''}`);
  console.log(`Roles:     ${plan?.roles?.join(', ') || 'none'}`);
  console.log(`Relays:    ${plan?.relay?.mounts?.length ?? 0} streams`);
  const certs = (await readdir(dataPath('certs')).catch(() => [] as string[])).some((f) => f.endsWith('.crt'));
  const tlsPort = plan?.source?.tlsPort ? `${plan.source.tlsPort} (TLS${certs ? '' : ', waiting for a certificate'})` : '-';
  console.log(`Encoders:  ${plan?.source ? `ports ${plan.source.plainPort ?? '-'} / ${tlsPort}` : 'off'}`);
  console.log(`Probes:    ${plan?.probes?.targets?.length ?? 0} streams`);
  if (apply) console.log(`Setup:     ${apply.state}${apply.message ? ` – ${apply.message}` : ''}`);
  if (update) console.log(`Update:    ${update.state}${update.message ? ` – ${update.message}` : ''}`);
}

async function run() {
  const file = readNodeFile();
  if (!file) {
    log.error(`not paired: ${paths.config} is missing; pair with "hrs-node pair --server <url> --code <code>"`);
    process.exit(78);
  }
  const agent = new Agent(file);
  await agent.start();
  const shutdown = (signal: string) => {
    log.info('stopping', { signal });
    void agent.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'pair') await pair(rest);
  else if (cmd === 'status') await status();
  else if (cmd === 'run' || !cmd) await run();
  else throw new Error(`Unknown command: ${cmd} (pair, run, status)`);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
