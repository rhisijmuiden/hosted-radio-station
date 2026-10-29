import { desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import type { NodeHub } from '../nodes/hub.js';
import { serverNames } from '../nodes/names.js';
import { getSetting, type AlertKind, type AlertSettings } from '../settings.js';
import { deliver, type AlertNotice, type DeliveryResult } from './notify.js';
import { OutsideChecks } from './outside.js';
import { evaluate, type Condition } from './rules.js';

const TICK_MS = 15_000;
/** After this server starts, nodes need a moment to connect again (about half a minute); until then nobody is offline. */
const START_GRACE_MS = 90_000;

type Row = typeof schema.alerts.$inferSelect;

const notice = (r: Row): AlertNotice => ({ id: r.id, kind: r.kind as AlertKind, severity: r.severity as AlertNotice['severity'], params: r.params, message: r.message, openedAt: r.openedAt, resolvedAt: r.resolvedAt, nodeId: r.nodeId, stationId: r.stationId });

/**
 * Monitoring on the orchestrator (phase 20). Every 15 seconds it works out what is wrong (rules.ts). A problem that
 * lasts longer than the wait time becomes an alert, and the alert is solved once the problem has been gone for the
 * recovery time, so one outage that flaps gives one message. New and solved alerts of a round go out together, in one
 * message per channel.
 */
export class AlertMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Conditions seen but not yet long enough: key → first seen. */
  private pending = new Map<string, number>();
  /** Open alerts whose condition is gone: key → first round without it. */
  private missing = new Map<string, number>();
  private readonly startedAt = Date.now();
  /** The outcome of the last message per channel, for the panel. */
  lastDelivery: (DeliveryResult & { at: string })[] = [];
  /** Ports and public DNS, checked from outside every few minutes. */
  readonly outside: OutsideChecks;

  constructor(
    private readonly ctx: AppContext,
    private readonly hub: NodeHub,
    private readonly log: FastifyBaseLogger,
    private readonly startGraceMs = START_GRACE_MS,
  ) {
    this.outside = new OutsideChecks(ctx, hub, log);
  }

  start() {
    this.timer = setInterval(() => {
      this.outside.due();
      void this.tick().catch((err) => this.log.warn({ err }, 'monitoring round failed'));
    }, TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** What is wrong right now, before the wait times. */
  async conditions(now = Date.now()): Promise<Condition[]> {
    const mounts = await this.ctx.db
      .select({ stationId: schema.stationMounts.stationId, path: schema.stationMounts.path, format: schema.stationMounts.format, kind: schema.stationMounts.kind, bitrateKbps: schema.stationMounts.bitrateKbps })
      .from(schema.stationMounts);
    const [nodes, stations, probes, nodeSettings, rollout, dns, settings, names] = await Promise.all([
      this.ctx.db.select({ id: schema.nodes.id, name: schema.nodes.name, roles: schema.nodes.roles, pairedAt: schema.nodes.pairedAt, status: schema.nodes.status }).from(schema.nodes),
      this.ctx.db.select({ id: schema.stations.id, name: schema.stations.name, slug: schema.stations.slug, enabled: schema.stations.enabled }).from(schema.stations),
      this.ctx.db
        .select({
          nodeId: schema.nodeProbes.nodeId,
          target: schema.nodeProbes.target,
          stationId: schema.nodeProbes.stationId,
          ok: schema.nodeProbes.ok,
          message: schema.nodeProbes.message,
          checkedAt: schema.nodeProbes.checkedAt,
          lastOkAt: schema.nodeProbes.lastOkAt,
          silent: schema.nodeProbes.silent,
          contentType: schema.nodeProbes.contentType,
          bitrateKbps: schema.nodeProbes.bitrateKbps,
        })
        .from(schema.nodeProbes),
      getSetting(this.ctx, 'nodes'),
      getSetting(this.ctx, 'nodeRollout'),
      getSetting(this.ctx, 'dnsState'),
      getSetting(this.ctx, 'alerts'),
      serverNames(this.ctx),
    ]);
    return evaluate({
      now,
      nodes: nodes.map((n) => ({ ...n, online: this.hub.isOnline(n.id), status: this.hub.liveStatus(n.id) ?? n.status })),
      stations,
      probes,
      mounts,
      probeIntervalSeconds: nodeSettings.probeIntervalSeconds,
      rollout,
      dns,
      settings,
      orchestratorName: names.orchestrator,
      firewall: this.outside.firewallResults(now),
      dnsWrong: this.outside.dnsResults(now),
    });
  }

  /** One round. Returns what opened and what was solved, for tests. */
  async tick(now = Date.now()) {
    if (this.running || now - this.startedAt < this.startGraceMs) return { opened: [] as Row[], resolved: [] as Row[] };
    this.running = true;
    try {
      return await this.round(now);
    } finally {
      this.running = false;
    }
  }

  private async round(now: number) {
    const settings = await getSetting(this.ctx, 'alerts');
    const conditions = await this.conditions(now);
    const open = await this.ctx.db.select().from(schema.alerts).where(isNull(schema.alerts.resolvedAt));
    const openByKey = new Map(open.map((a) => [a.key, a]));
    const seen = new Set(conditions.map((c) => c.key));
    const at = new Date(now);
    const opened: Row[] = [];
    const resolved: Row[] = [];

    for (const c of conditions) {
      const existing = openByKey.get(c.key);
      if (existing) {
        this.missing.delete(c.key);
        await this.ctx.db.update(schema.alerts).set({ lastSeenAt: at, message: c.message, severity: c.severity, params: c.params }).where(eq(schema.alerts.id, existing.id));
        continue;
      }
      const first = this.pending.get(c.key) ?? now;
      this.pending.set(c.key, first);
      if (now - first < settings.graceSeconds * 1000) continue;
      this.pending.delete(c.key);
      const [row] = await this.ctx.db
        .insert(schema.alerts)
        .values({ key: c.key, kind: c.kind, severity: c.severity, nodeId: c.nodeId, stationId: c.stationId, params: c.params, message: c.message, openedAt: new Date(first), lastSeenAt: at })
        .onConflictDoNothing()
        .returning();
      if (row) opened.push(row);
    }
    for (const key of [...this.pending.keys()]) if (!seen.has(key)) this.pending.delete(key);

    for (const a of open) {
      if (seen.has(a.key)) continue;
      const first = this.missing.get(a.key) ?? now;
      this.missing.set(a.key, first);
      if (now - first < settings.recoverSeconds * 1000) continue;
      this.missing.delete(a.key);
      // Solved at the first round without it, not when the wait ended.
      const [row] = await this.ctx.db.update(schema.alerts).set({ resolvedAt: new Date(first) }).where(eq(schema.alerts.id, a.id)).returning();
      if (row) resolved.push(row);
    }
    for (const key of [...this.missing.keys()]) if (!openByKey.has(key)) this.missing.delete(key);

    const toSend = opened.filter((a) => settings.minSeverity === 'warning' || a.severity === 'critical');
    const recovered = settings.notifyRecovery ? resolved.filter((a) => a.notified) : [];
    for (const a of toSend) a.notified = true;
    // Only those that went out are marked: the others stay quiet when they are solved, too.
    if (toSend.length) await this.ctx.db.update(schema.alerts).set({ notified: true }).where(inArray(schema.alerts.id, toSend.map((a) => a.id)));
    if (toSend.length || recovered.length) await this.send(settings, toSend.map(notice), recovered.map(notice));
    return { opened, resolved };
  }

  private async send(settings: AlertSettings, opened: AlertNotice[], resolved: AlertNotice[]) {
    const results = await deliver(this.ctx, settings, opened, resolved).catch((err) => {
      this.log.warn({ err }, 'sending alerts failed');
      return [] as DeliveryResult[];
    });
    for (const r of results) if (!r.ok) this.log.warn({ channel: r.channel, error: r.error }, 'an alert could not be sent');
    this.record(results);
  }

  record(results: DeliveryResult[]) {
    const at = new Date().toISOString();
    for (const r of results) this.lastDelivery = [...this.lastDelivery.filter((d) => d.channel !== r.channel), { ...r, at }];
  }

  async list(state: 'open' | 'resolved' | 'all', limit: number) {
    const where = state === 'open' ? isNull(schema.alerts.resolvedAt) : state === 'resolved' ? isNotNull(schema.alerts.resolvedAt) : undefined;
    return this.ctx.db.select().from(schema.alerts).where(where).orderBy(desc(schema.alerts.openedAt)).limit(limit);
  }
}
