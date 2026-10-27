#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { Agent } from './agent.js';
import { dataPath, readNodeFile, readVersion } from './config.js';
import { pairWithCode, register, registrationSummary, ROLES, waitForPairing, type Role } from './enroll.js';
import { log } from './log.js';

function arg(args: string[], name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function pair(args: string[]) {
  const server = arg(args, 'server');
  const code = arg(args, 'code');
  const webArg = arg(args, 'web');
  if (!server || !code) throw new Error('Usage: hrs-node pair --server https://radio.example.com --code XXXX-XXXX-XXXX [--web caddy|direct]');
  const file = await pairWithCode(server, code, webArg ? (webArg === 'direct' ? 'direct' : 'caddy') : undefined);
  if (file.server.startsWith('http://')) console.log('Note: the main server is reached over plain HTTP. Use HTTPS in production, so the control channel is encrypted.');
  console.log(`Paired as "${file.name}" (${file.nodeId}).`);
}

/** Phase 16: register with an orchestrator and print the code to compare under "Pending nodes". */
async function registerCmd(args: string[]) {
  const server = arg(args, 'server');
  const role = arg(args, 'role') ?? null;
  if (!server) throw new Error('Usage: hrs-node register --server https://radio.example.com [--role relay|source|station|fm]');
  if (role && !(ROLES as readonly string[]).includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);
  if (readNodeFile()) throw new Error('This node is already paired; unpair it in the panel first, or pair it again with "hrs-node pair"');
  const reg = await register(server, role as Role | null);
  if (!args.includes('--quiet')) {
    console.log(`Registered with ${reg.server}.`);
    console.log(`Code: ${reg.code}`);
    console.log('Accept this node in the panel under Nodes → Pending nodes, after checking that it shows the same code.');
  } else console.log(reg.code);
}

async function status() {
  const file = readNodeFile();
  if (!file) {
    const pending = await registrationSummary();
    console.log(pending ? `Not paired yet: ${pending}.` : 'Not paired. Pair with: hrs-node pair --server <url> --code <code>, or register with: hrs-node register --server <url>');
    if (process.env.HRS_NODE_SETUP_PORT !== '0') console.log('Setup page: http://<this node>:8080 (until the node is paired)');
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
  // A bare node (phase 16): wait for pairing, with the setup page on port 8080 and any pending registration.
  let file = readNodeFile();
  if (!file) {
    log.info('not paired yet; pair with "hrs-node pair --server <url> --code <code>", the setup page, or wait for acceptance of a registration');
    const early = () => process.exit(0);
    process.once('SIGTERM', early);
    process.once('SIGINT', early);
    file = await waitForPairing();
    process.off('SIGTERM', early);
    process.off('SIGINT', early);
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
  else if (cmd === 'register') await registerCmd(rest);
  else if (cmd === 'status') await status();
  else if (cmd === 'run' || !cmd) await run();
  else throw new Error(`Unknown command: ${cmd} (pair, register, run, status)`);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
