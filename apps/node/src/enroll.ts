import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPath, paths, readInstallFile, readNodeFile, readVersion, writeAtomic, type NodeFile } from './config.js';
import { log } from './log.js';
import { facts } from './system.js';

/**
 * Enrollment (phase 16): how a bare node becomes a node of an orchestrator. Three ways, all ending in node.json:
 *   - a pairing code from the panel, with `hrs-node pair` or the setup page on port 8080
 *   - self-registration: the node registers, shows a short code and waits until an administrator accepts it
 */

const AGENT = 'Hosted Radio Station node';
export const ROLES = ['relay', 'source', 'station', 'fm'] as const;
export type Role = (typeof ROLES)[number];

export interface Registration {
  server: string;
  id: string;
  code: string;
  token: string;
  expiresAt: string;
  role: Role | null;
}

export const registrationPath = () => dataPath('registration.json');

export function normalizeServer(input: string) {
  let server = input.trim().replace(/\/+$/, '');
  if (server && !/^[a-z]+:\/\//i.test(server)) server = `https://${server}`;
  if (!/^https?:\/\/[\][A-Za-z0-9.:-]+(\/.*)?$/.test(server)) throw new Error('The orchestrator address must look like https://radio.example.com');
  return server;
}

async function post<T>(server: string, path: string, body: unknown): Promise<{ status: number; data: (T & { error?: { message?: string } }) | null }> {
  const res = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }).catch((err: Error) => {
    throw new Error(`The orchestrator cannot be reached at ${server}: ${(err.cause as Error | undefined)?.message ?? err.message}`);
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null };
}

async function writeNodeFile(file: NodeFile) {
  await writeAtomic(paths.config, JSON.stringify(file, null, 2), 0o600);
  await rm(registrationPath(), { force: true });
}

/** Pairs with a one-time code from the panel and writes node.json. */
export async function pairWithCode(serverInput: string, code: string, web = readInstallFile().web): Promise<NodeFile> {
  const server = normalizeServer(serverInput);
  if (!code.trim()) throw new Error('Enter the pairing code from the panel');
  const { status, data } = await post<{ nodeId?: string; name?: string; secret?: string }>(server, '/api/nodes/pair', { code: code.trim(), hostname: facts(web).hostname, version: readVersion().version });
  if (status >= 400 || !data?.nodeId || !data.secret) throw new Error(data?.error?.message ?? `The orchestrator answered ${status}`);
  const file: NodeFile = { server, nodeId: data.nodeId, secret: data.secret, name: data.name, web };
  await writeNodeFile(file);
  return file;
}

/** Registers this machine with an orchestrator; it waits under "Pending nodes" with the code it returns. */
export async function register(serverInput: string, role: Role | null): Promise<Registration> {
  const server = normalizeServer(serverInput);
  const f = facts(readInstallFile().web);
  const { status, data } = await post<{ id?: string; code?: string; token?: string; expiresAt?: string }>(server, '/api/nodes/register', {
    hostname: f.hostname,
    version: readVersion().version,
    addresses: f.facts.addresses.slice(0, 16),
    role,
  });
  if (status >= 400 || !data?.id || !data.code || !data.token) throw new Error(data?.error?.message ?? `The orchestrator answered ${status}`);
  const reg: Registration = { server, id: data.id, code: data.code, token: data.token, expiresAt: data.expiresAt ?? '', role };
  await writeAtomic(registrationPath(), JSON.stringify(reg, null, 2), 0o600);
  return reg;
}

export function readRegistration(): Registration | null {
  try {
    const r = JSON.parse(readFileSync(registrationPath(), 'utf8')) as Registration;
    return r.server && r.token && r.code ? r : null;
  } catch {
    return null;
  }
}

/** Asks the orchestrator about a registration; an accepted one becomes node.json. */
export async function checkRegistration(reg: Registration): Promise<'pending' | 'accepted' | 'rejected' | 'expired'> {
  const { status, data } = await post<{ state?: 'pending' | 'accepted' | 'rejected' | 'expired'; nodeId?: string; name?: string; secret?: string }>(reg.server, '/api/nodes/register/status', { token: reg.token });
  if (status >= 400 || !data?.state) throw new Error(data?.error?.message ?? `The orchestrator answered ${status}`);
  if (data.state === 'accepted' && data.nodeId && data.secret) {
    await writeNodeFile({ server: reg.server, nodeId: data.nodeId, secret: data.secret, name: data.name, web: readInstallFile().web });
    return 'accepted';
  }
  if (data.state === 'rejected' || data.state === 'expired') await rm(registrationPath(), { force: true });
  return data.state === 'accepted' ? 'pending' : data.state;
}

/**
 * Until the node is paired: serve the setup page and follow a registration. Resolves with node.json once the node is
 * paired, whichever way that happened (also `hrs-node pair` from the shell). The setup page closes for good then.
 */
export function waitForPairing(): Promise<NodeFile> {
  const setup = readInstallFile().setupPage ? new SetupPage() : null;
  void setup?.start();
  return new Promise((resolve) => {
    let lastCheck = 0;
    let checking = false;
    let reported = '';
    const tick = async () => {
      const file = readNodeFile();
      if (file) {
        clearInterval(timer);
        await setup?.stop();
        resolve(file);
        return;
      }
      const reg = readRegistration();
      if (!reg || checking || Date.now() - lastCheck < 5000) return;
      checking = true;
      lastCheck = Date.now();
      try {
        const state = await checkRegistration(reg);
        if (state !== reported) {
          reported = state;
          if (state === 'pending') log.info('waiting for an administrator to accept this node', { server: reg.server, code: reg.code });
          else if (state === 'rejected') log.error('the orchestrator refused this node; register again or pair it with a code', { server: reg.server });
          else if (state === 'expired') log.error('the registration expired; register again with "hrs-node register" or pair it with a code', { server: reg.server });
          else log.info('accepted by the orchestrator', { server: reg.server });
        }
      } catch (err) {
        log.warn('asking the orchestrator about the registration failed', { err });
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void tick(), 1000);
    void tick();
  });
}

// The setup page

const TEXT = {
  en: {
    title: 'Set up this node',
    intro: 'Connect this node to its orchestrator. Add the node in the panel under Nodes, then enter the address and the pairing code you see there.',
    server: 'Orchestrator URL',
    code: 'Pairing code',
    submit: 'Pair',
    done: 'Paired as “{name}”',
    doneText: 'This node is now connected to {server}. Give it a role in the panel. This page has closed.',
  },
  nl: {
    title: 'Deze node instellen',
    intro: 'Koppel deze node aan de orchestrator. Voeg de node toe in het panel onder Nodes en vul hier het adres en de koppelcode in die je daar ziet.',
    server: 'Orchestrator-URL',
    code: 'Koppelcode',
    submit: 'Koppelen',
    done: 'Gekoppeld als “{name}”',
    doneText: 'Deze node is nu verbonden met {server}. Geef hem een rol in het panel. Deze pagina is gesloten.',
  },
};
type Lang = keyof typeof TEXT;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function logo() {
  try {
    return readFileSync(join(paths.install, 'brand', 'logo', 'rhis-icon-koraal.svg'), 'utf8').replace(/<\?xml[^>]*>/, '');
  } catch {
    return '';
  }
}

export function setupPageHtml(lang: Lang, opts: { server?: string; error?: string; paired?: { name: string; server: string } } = {}) {
  const t = TEXT[lang];
  const body = opts.paired
    ? `<h1>${esc(t.done.replace('{name}', opts.paired.name))}</h1><p class="muted">${esc(t.doneText.replace('{server}', opts.paired.server))}</p>`
    : `<h1>${esc(t.title)}</h1><p class="muted">${esc(t.intro)}</p>
<form method="post" action="/">
<label>${esc(t.server)}<input name="server" type="url" required placeholder="https://radio.example.com" value="${esc(opts.server ?? '')}" autocomplete="url"></label>
<label>${esc(t.code)}<input name="code" required placeholder="XXXX-XXXX-XXXX" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" class="mono"></label>
${opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : ''}
<button type="submit">${esc(t.submit)}</button>
</form>`;
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.title)} · Hosted Radio Station</title>
<style>
:root{--nacht:#14213D;--koraal:#FF6B57;--surface:#F6F7FB;--raised:#fff;--ink:#14213D;--muted:#4F5B73;--line:#DCE1EB;--error:#C23434;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--surface:#0E1626;--raised:#16213A;--ink:#EEF1F7;--muted:#A3AEC4;--line:#26324D;--error:#FF7A7A}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--surface);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:420px;background:var(--raised);border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 10px 30px rgb(0 0 0/.08)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:20px;font-size:13px;color:var(--muted)}.brand svg{width:28px;height:28px}
h1{margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:-.01em}.muted{color:var(--muted);margin:0 0 20px}
label{display:block;font-size:13px;font-weight:600;margin-bottom:14px}input{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);font:inherit}
input:focus{outline:2px solid var(--koraal);outline-offset:1px;border-color:transparent}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}
button{width:100%;padding:11px;border:0;border-radius:10px;background:var(--koraal);color:var(--nacht);font:inherit;font-weight:700;cursor:pointer}button:hover{filter:brightness(1.05)}
.error{color:var(--error);font-size:13px;margin:0 0 14px}footer{margin-top:20px;font-size:12px;color:var(--muted);text-align:center}
</style></head><body><main><div class="brand">${logo()}<span>Hosted Radio Station node</span></div>${body}<footer>Powered by RHIS</footer></main></body></html>`;
}

const pickLang = (req: http.IncomingMessage): Lang => (/^\s*nl\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'nl' : 'en');

/**
 * A small web page on port 8080 while the node is not paired (phase 16): only the orchestrator URL and the pairing
 * code. It stops when the node is paired, and is never served again after that.
 */
export class SetupPage {
  private server: http.Server | null = null;
  private attempts: number[] = [];
  readonly port = Number(process.env.HRS_NODE_SETUP_PORT ?? 8080);

  start() {
    if (!this.port) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      server.on('error', (err) => {
        log.warn('the setup page cannot use its port; pair from the shell with "hrs-node pair"', { port: this.port, err });
        this.server = null;
        resolve();
      });
      server.listen(this.port, () => {
        log.info(`setup page on port ${this.port}: open http://<this node>:${this.port} to pair it`);
        resolve();
      });
      this.server = server;
    });
  }

  stop() {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      log.info('setup page closed');
    });
  }

  private send(res: http.ServerResponse, status: number, html: string) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const lang = pickLang(req);
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') return this.send(res, 200, setupPageHtml(lang));
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' }).end();
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += String(chunk);
      if (body.length > 4096) {
        res.writeHead(413).end();
        return;
      }
    }
    const form = new URLSearchParams(body);
    const server = form.get('server') ?? '';
    // Ten tries a minute: the orchestrator limits guessing too, this keeps the page from being used to hammer it.
    const now = Date.now();
    this.attempts = this.attempts.filter((t) => now - t < 60_000);
    if (this.attempts.length >= 10) return this.send(res, 429, setupPageHtml(lang, { server, error: lang === 'nl' ? 'Te veel pogingen; probeer het over een minuut opnieuw.' : 'Too many attempts; try again in a minute.' }));
    this.attempts.push(now);
    try {
      const file = await pairWithCode(server, form.get('code') ?? '');
      log.info('paired from the setup page', { server: file.server, name: file.name });
      this.send(res, 200, setupPageHtml(lang, { paired: { name: file.name ?? file.nodeId, server: file.server } }));
    } catch (err) {
      this.send(res, 400, setupPageHtml(lang, { server, error: (err as Error).message }));
    }
  }
}

/** The pending registration, for `hrs-node status`. */
export async function registrationSummary() {
  const raw = await readFile(registrationPath(), 'utf8').catch(() => null);
  if (!raw) return null;
  const r = JSON.parse(raw) as Registration;
  return `waiting for acceptance at ${r.server}, code ${r.code}${r.role ? `, preferred role ${r.role}` : ''}`;
}
