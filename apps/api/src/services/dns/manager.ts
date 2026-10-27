import net from 'node:net';
import { asc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema } from '../../db/index.js';
import { writeAudit } from '../../lib/audit.js';
import type { AppContext } from '../../lib/context.js';
import type { NodeHub } from '../nodes/hub.js';
import { nodeHost, nodeSettings } from '../nodes/plan.js';
import { forgetRelays } from '../nodes/routing.js';
import { drainingNodes } from '../nodes/updates.js';
import { getSetting, putSetting, type CloudflareSettings, type DnsState } from '../settings.js';
import { checkHost } from '../streaming/domains.js';
import { applyStreams } from '../streaming/state.js';
import { desiredCacheRules, planCacheRules } from './cache.js';
import { Cloudflare, CloudflareError } from './cloudflare.js';
import { dnsConfig, installId } from './config.js';
import { desiredRecords, nodeAddresses, planChanges, toInput, type DesiredRecord, type DnsDomain, type DnsNode, type RecordPlan } from './records.js';

/** How often the zone is compared with what the platform wants: a relay that goes down leaves the pool within this. */
const INTERVAL_MS = 30_000;
/** Own host names of nodes (not platform names) are checked this often. */
const OWN_NAME_MS = 5 * 60_000;
/** The cache rules are compared this often, and at once when their settings change or a run is asked for. */
const CACHE_MS = 10 * 60_000;

type Change = DnsState['lastChanges'][number];

/**
 * Cloudflare DNS (phase 15): keeps the records of the platform domain in line with the network. Every 30 seconds, and
 * shortly after a node connects, drops out or is drained, it works out the records the platform wants (this server,
 * each node, the relay pool, the targets of customer domains), compares them with the zone and, in mode "on", writes
 * the difference. Only records it made itself (comment hrs:<install>:…) are ever changed or deleted. Every change goes
 * into the audit log; in dry run the panel shows what would change and nothing is written.
 */
export class DnsManager {
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private running: Promise<DnsState> | null = null;
  private again = false;
  private detected: { at: number; ip: string | null } | null = null;
  private zone: { token: string; domain: string; id: string; name: string } | null = null;
  private ownCheckedAt = 0;
  private cacheChecked: { at: number; key: string } | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly hub: NodeHub | null,
    private readonly log: FastifyBaseLogger,
  ) {}

  start() {
    this.timer = setInterval(() => void this.run().catch((err) => this.log.warn({ err }, 'DNS run failed')), INTERVAL_MS);
    this.timer.unref();
    const first = setTimeout(() => void this.run().catch((err) => this.log.warn({ err }, 'DNS run failed')), 10_000);
    first.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
  }

  /** A run in a few seconds, once for a burst of changes (nodes connecting after a restart). */
  nudge() {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.run().catch((err) => this.log.warn({ err }, 'DNS run failed'));
    }, 3000);
    this.soon.unref();
  }

  /** Forgets the zone found earlier (after the token or domain changed). */
  forgetZone() {
    this.zone = null;
  }

  /** One run at a time; a run asked for while one is busy follows it. A purge waits for the busy run and goes alone. */
  async run(opts: { by?: string | null; purge?: boolean } = {}): Promise<DnsState> {
    if (opts.purge) while (this.running) await this.running.catch(() => undefined);
    else if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let state: DnsState;
      do {
        this.again = false;
        state = await this.once(opts);
      } while (this.again && !opts.purge);
      return state;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** This server's public addresses: set for DNS, else under Streaming, else looked up (at most once a minute). */
  async originAddresses(s: CloudflareSettings): Promise<DnsState['origin']> {
    if (s.originAddresses.length) return { addresses: s.originAddresses, source: 'settings' };
    const streaming = await getSetting(this.ctx, 'streaming');
    const ips = streaming.publicIps.filter((ip) => net.isIP(ip));
    if (ips.length) return { addresses: ips, source: 'streaming' };
    const url = this.ctx.config.PUBLIC_IP_URL;
    if (!url) return { addresses: [], source: 'none' };
    if (!this.detected || Date.now() - this.detected.at > 60_000) {
      let ip: string | null = null;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const m = (await res.text()).match(/^ip=(.+)$/m);
        if (m && net.isIP(m[1]!.trim())) ip = m[1]!.trim();
      } catch {
        ip = this.detected?.ip ?? null;
      }
      this.detected = { at: Date.now(), ip };
    }
    return this.detected.ip ? { addresses: [this.detected.ip], source: 'detected' } : { addresses: [], source: 'none' };
  }

  private async zoneOf(cf: Cloudflare, s: CloudflareSettings, base: string) {
    if (s.zoneId) return { id: s.zoneId, name: s.zoneName || base };
    if (this.zone && this.zone.token === s.apiToken && this.zone.domain === base) return this.zone;
    const z = await cf.findZone(base);
    if (!z) throw new CloudflareError(`No zone for ${base} that this token can see`, 404);
    this.zone = { token: s.apiToken, domain: base, ...z };
    return this.zone;
  }

  /** Gives customer domains without one a target label: the customer's slug, then slug-2, slug-3 … */
  private async labelDomains() {
    const rows = await this.ctx.db
      .select({ id: schema.tenantDomains.id, label: schema.tenantDomains.targetLabel, slug: schema.tenants.slug })
      .from(schema.tenantDomains)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantDomains.tenantId))
      .orderBy(asc(schema.tenantDomains.createdAt));
    const taken = new Set(rows.map((r) => r.label).filter((l): l is string => !!l));
    for (const r of rows) {
      if (r.label) continue;
      const base = r.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50) || 'customer';
      let label = base;
      for (let i = 2; taken.has(label); i++) label = `${base}-${i}`;
      taken.add(label);
      await this.ctx.db.update(schema.tenantDomains).set({ targetLabel: label }).where(eq(schema.tenantDomains.id, r.id));
    }
  }

  /** The facts the record plan is made of. */
  async inputs() {
    const { s, base } = await dnsConfig(this.ctx);
    await this.labelDomains();
    const [origin, nodeRows, tenants, domainRows] = await Promise.all([
      this.originAddresses(s),
      this.ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt)),
      this.ctx.db.select({ id: schema.tenants.id, slug: schema.tenants.slug }).from(schema.tenants),
      this.ctx.db.select().from(schema.tenantDomains),
    ]);
    const slug = new Map(tenants.map((t) => [t.id, t.slug]));
    const nodes: DnsNode[] = nodeRows.map((n) => {
      const c = nodeSettings(n);
      const status = this.hub?.liveStatus(n.id) ?? n.status;
      return {
        id: n.id,
        name: n.name,
        tenantSlug: n.tenantId ? (slug.get(n.tenantId) ?? 'customer') : null,
        roles: n.roles,
        online: !!this.hub?.isOnline(n.id),
        draining: drainingNodes.has(n.id),
        dnsName: c.dnsName,
        dnsRecord: c.dnsRecord,
        publicAddress: c.publicAddress,
        ip: status.ip ?? null,
        addresses: status.addresses ?? [],
      };
    });
    const domains: DnsDomain[] = domainRows.map((d) => ({ id: d.id, tenantSlug: slug.get(d.tenantId) ?? '', targetLabel: d.targetLabel, ingestNodeId: d.ingestNodeId }));
    return { s, base, origin, nodes, nodeRows, domains };
  }

  private async once(opts: { by?: string | null; purge?: boolean }): Promise<DnsState> {
    const prev = await getSetting(this.ctx, 'dnsState');
    if ((await getSetting(this.ctx, 'cloudflare')).mode === 'off' && !opts.purge) {
      // Off: nothing is looked at; nodes lose their platform names (the records stay until removed in the panel).
      await this.setNodeHosts(await this.ctx.db.select().from(schema.nodes), new Map());
      if (prev.mode === 'off' && prev.at) return prev;
      const state: DnsState = { ...prev, at: new Date().toISOString(), mode: 'off', error: null, records: [], stale: [], problems: [] };
      await putSetting(this.ctx, 'dnsState', state);
      return state;
    }
    const { s, base, origin, nodes, nodeRows, domains } = await this.inputs();
    const state: DnsState = { ...prev, at: new Date().toISOString(), mode: s.mode, error: null, origin, records: [], stale: [], problems: [] };
    const { records, problems } = opts.purge ? { records: [] as DesiredRecord[], problems: [] } : desiredRecords({ base, settings: s, origin: origin.addresses, nodes, domains });
    state.problems = problems;
    try {
      if (!base) throw new CloudflareError('Set the platform domain first (Web server, or the domain here)', 400);
      if (!s.apiToken) throw new CloudflareError('Enter an API token first', 400);
      const cf = new Cloudflare(s.apiToken, this.ctx.config.CLOUDFLARE_API_URL);
      const zone = await this.zoneOf(cf, s, base);
      const install = installId(this.ctx);
      const zoneRecords = await cf.listRecords(zone.id);
      const plan = planChanges(install, base, records, zoneRecords);
      const write = s.mode === 'on' || !!opts.purge;
      const changes = write ? await this.apply(cf, zone.id, plan, opts.by ?? null) : [];
      state.records = describe(plan, write);
      state.stale = write ? [] : plan.deletes.map((r) => ({ name: r.name, type: r.type, content: r.content }));
      for (const c of plan.conflicts) state.problems.push({ kind: 'conflict', ref: c.record.ref, name: c.record.name });
      if (changes.length) {
        state.lastChanges = changes.slice(-200);
        state.lastChangeAt = state.at;
      }
      if (write && !opts.purge) {
        // A node's platform name counts once its record is in the zone.
        const live = new Map<string, string>();
        for (const r of [...plan.keeps.map((k) => k.record), ...plan.updates.map((u) => u.record), ...plan.creates]) if (r.purpose === 'node' && r.ref) live.set(r.ref, r.name);
        await this.setNodeHosts(nodeRows, live);
      } else await this.setNodeHosts(nodeRows, new Map());
      await this.cacheRules(cf, zone.id, install, s, base, state, write, opts);
      if (Date.now() - this.ownCheckedAt > OWN_NAME_MS) {
        this.ownCheckedAt = Date.now();
        await this.checkOwnNames().catch((err) => this.log.warn({ err }, 'checking node host names failed'));
      }
    } catch (err) {
      state.error = (err as Error).message.slice(0, 500);
      if (!(err instanceof CloudflareError)) this.log.warn({ err }, 'DNS run failed');
    }
    await putSetting(this.ctx, 'dnsState', state);
    return state;
  }

  /**
   * Keeps the cache rules of the panel host in line with the settings (phase 15, step 2). A failure here (often a token
   * without the Cache Rules permission) is shown with the rules and does not stop the records.
   */
  private async cacheRules(cf: Cloudflare, zoneId: string, install: string, s: CloudflareSettings, base: string, state: DnsState, write: boolean, opts: { by?: string | null; purge?: boolean }) {
    const host = ((await getSetting(this.ctx, 'proxy')).domain || base).replace(/\.$/, '');
    const want = s.cacheRules && !opts.purge;
    const key = `${s.mode}|${want}|${host}|${zoneId}`;
    const due = !this.cacheChecked || this.cacheChecked.key !== key || Date.now() - this.cacheChecked.at > CACHE_MS || opts.by !== undefined || opts.purge;
    if (!due) return;
    this.cacheChecked = { at: Date.now(), key };
    const at = new Date().toISOString();
    try {
      const desired = want ? desiredCacheRules(install, host) : [];
      const plan = planCacheRules(install, await cf.cacheRules(zoneId), desired);
      if (plan.rules && write) {
        await cf.putCacheRules(zoneId, plan.rules);
        await writeAudit(this.ctx, {
          action: 'dns.cacheRules',
          via: opts.by ? 'panel' : 'system',
          actorEmail: opts.by ?? null,
          targetType: 'dns',
          details: { host, rules: desired.length, before: plan.current },
        }).catch(() => undefined);
        this.log.info({ host, rules: desired.length }, 'Cloudflare cache rules updated');
      }
      const rules = plan.rules && write ? desired.length : plan.current;
      state.cache = { state: plan.rules && !write ? 'pending' : rules ? 'ok' : 'off', host: want ? host : null, rules, foreign: plan.foreign, error: null, at };
    } catch (err) {
      this.cacheChecked = null;
      const msg = (err as Error).message;
      const denied = err instanceof CloudflareError && (err.status === 403 || err.status === 401);
      state.cache = { ...state.cache, state: 'error', host, error: (denied ? `The token may not change cache rules (add Zone › Cache Rules › Edit): ${msg}` : msg).slice(0, 500), at };
    }
  }

  /** Writes the plan: deletes first (a name may change type), then updates, then new records. */
  private async apply(cf: Cloudflare, zoneId: string, plan: RecordPlan, by: string | null): Promise<Change[]> {
    const done: Change[] = [];
    const log = async (c: Change) => {
      done.push(c);
      await writeAudit(this.ctx, {
        action: `dns.${c.action}`,
        via: by ? 'panel' : 'system',
        actorEmail: by,
        targetType: 'dns',
        details: { name: c.name, type: c.type, content: c.content, proxied: c.proxied, ...(c.before ? { before: c.before } : {}) },
      }).catch(() => undefined);
    };
    for (const r of plan.deletes) {
      await cf.deleteRecord(zoneId, r.id);
      await log({ action: 'delete', name: r.name, type: r.type, content: r.content, proxied: r.proxied, before: null });
    }
    for (const u of plan.updates) {
      await cf.updateRecord(zoneId, u.current.id, toInput(u.record));
      await log({ action: 'update', name: u.record.name, type: u.record.type, content: u.record.content, proxied: u.record.proxied, before: `${u.current.type} ${u.current.content}${u.current.proxied ? ' (proxied)' : ''}` });
    }
    for (const r of plan.creates) {
      await cf.createRecord(zoneId, toInput(r));
      await log({ action: 'create', name: r.name, type: r.type, content: r.content, proxied: r.proxied, before: null });
    }
    if (done.length) this.log.info({ changes: done.length }, 'DNS records updated');
    return done;
  }

  /**
   * Stores each node's platform name (or clears it), so plans and connection details use it, and sends the nodes
   * whose name changed a new plan (their web server then gets a certificate for it).
   */
  private async setNodeHosts(nodes: (typeof schema.nodes.$inferSelect)[], live: Map<string, string>) {
    let changed = false;
    for (const n of nodes) {
      const want = live.get(n.id) ?? '';
      if ((n.config.dnsHost ?? '') === want) continue;
      const before = nodeHost(n);
      const config = { ...n.config, dnsHost: want };
      await this.ctx.db.update(schema.nodes).set({ config }).where(eq(schema.nodes.id, n.id));
      if (nodeHost({ config }) !== before) changed = true;
    }
    if (changed) await this.hostsChanged();
  }

  /** A node's host name changed: listener links, relay plans and the plans of the nodes that use it follow. */
  private async hostsChanged() {
    forgetRelays();
    await applyStreams(this.ctx, { by: 'dns' }).catch((err) => this.log.warn({ err }, 'applying streams after a DNS change failed'));
    void this.hub?.refreshAll();
  }

  /** Checks the own host name of each node that has one besides its platform name (e.g. studio.harder.fm). */
  async checkOwnNames(nodeId?: string) {
    const { base } = await dnsConfig(this.ctx);
    const rows = await this.ctx.db.select().from(schema.nodes).where(nodeId ? eq(schema.nodes.id, nodeId) : isNotNull(schema.nodes.pairedAt));
    for (const n of rows) {
      const c = nodeSettings(n);
      const own = c.publicHost;
      const needed = !!own && !!c.dnsHost && own !== c.dnsHost && !(base && own.endsWith(`.${base}`));
      if (!needed) {
        if (c.publicHostCheck) await this.storeCheck(n, null);
        continue;
      }
      const status = this.hub?.liveStatus(n.id) ?? n.status;
      const ips = nodeAddresses({ publicAddress: c.publicAddress, ip: status.ip ?? null, addresses: status.addresses ?? [] });
      const check = await checkHost(own, { cname: c.dnsHost, ips });
      await this.storeCheck(n, { ok: check.ok, found: check.found, error: check.error, at: new Date().toISOString() });
    }
  }

  private async storeCheck(n: typeof schema.nodes.$inferSelect, check: NonNullable<typeof n.config.publicHostCheck> | null) {
    const before = nodeHost(n);
    const config = { ...n.config, publicHostCheck: check };
    await this.ctx.db.update(schema.nodes).set({ config }).where(eq(schema.nodes.id, n.id));
    if (nodeHost({ config }) !== before) await this.hostsChanged();
  }
}

/** The wanted records with what the zone has, for the overview in the panel. */
function describe(plan: RecordPlan, written: boolean): DnsState['records'] {
  const row = (r: DesiredRecord, state: DnsState['records'][number]['state']) => ({ name: r.name, type: r.type, content: r.content, proxied: r.proxied, ttl: r.ttl, purpose: r.purpose, ref: r.ref, state });
  return [
    ...plan.keeps.map((k) => row(k.record, 'ok')),
    ...plan.updates.map((u) => row(u.record, written ? 'ok' : 'update')),
    ...plan.creates.map((r) => row(r, written ? 'ok' : 'create')),
    ...plan.conflicts.map((c) => row(c.record, 'conflict')),
  ].sort((a, b) => a.name.localeCompare(b.name) || a.content.localeCompare(b.content));
}

