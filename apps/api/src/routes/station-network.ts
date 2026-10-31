import os from 'node:os';
import { and, asc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import type { NodeStatus } from '../db/schema.js';
import { isDedicated, serves } from '../services/nodes/dedication.js';
import { studioDelivery } from '../services/nodes/delivery.js';
import { serverNames } from '../services/nodes/names.js';
import { relaysOf } from '../services/nodes/plan.js';
import { ingestsOf, stationRouting } from '../services/nodes/routing-rules.js';
import { getSetting } from '../services/settings.js';
import { readStreamsStatus } from '../services/streaming/status.js';
import { runningVersion } from '../services/system.js';
import { stationAccess } from './stations.js';

const params = z.object({ id: z.uuid() });

const issueOut = z.object({
  /** offline, problem (applying the configuration failed), check (a monitoring check fails or hears silence), relay (a mount does not connect), firewall (failed or rolled back). */
  kind: z.enum(['offline', 'problem', 'check', 'relay', 'firewall']),
  message: z.string().nullable(),
});

const networkOut = z.object({
  nodes: z.array(
    z.object({
      /** A node id, or "main" for this server. */
      id: z.string(),
      name: z.string(),
      role: z.enum(['station', 'ingest', 'backupIngest', 'relay', 'recorder']),
      shared: z.boolean(),
      state: z.enum(['online', 'standby', 'warning', 'offline']),
      /** Percent of the node's CPU and memory in use. */
      cpu: z.number().nullable(),
      memory: z.number().nullable(),
      /** What the monitoring nodes hear on it for this station; null = not checked. */
      checks: z.object({ ok: z.number(), total: z.number() }).nullable(),
      /** The state the node reports for its firewall (see firewall.node.state), or null when it reports none. */
      firewall: z.string().nullable(),
      version: z.string().nullable(),
      /** The commit of the build, so test builds can be told apart. */
      commit: z.string().nullable(),
      listeners: z.number().nullable(),
      issues: z.array(issueOut),
    }),
  ),
});

type NodeRow = z.infer<typeof networkOut>['nodes'][number];

/**
 * The nodes one station uses, for the Manage view of RHIS Studio (phase 24): its station node, ingests and relays with
 * their health, and what needs attention. Station managers only. Mounted under /api/stations.
 */
export const stationNetworkRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const hub = app.nodes;

  app.get(
    '/:id/network',
    { schema: { tags: ['Stations'], summary: 'The nodes this station uses and their health: station node, ingests and relays', params, response: { 200: networkOut } } },
    async (req) => {
      const { station } = await stationAccess(ctx, req, req.params.id, 'manager');
      const rows = await ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt)).orderBy(asc(schema.nodes.name));
      const nodes = rows.map((n) => ({ ...n, status: (hub.liveStatus(n.id) ?? { ...n.status, online: false }) as NodeStatus }));
      const r = stationRouting(station);
      const [worker, names, settings, version] = await Promise.all([readStreamsStatus(ctx).then((s) => s.worker), serverNames(ctx), getSetting(ctx, 'nodes'), runningVersion(ctx)]);

      // Monitoring checks of this station per server: "main" or a node id.
      const monitors = nodes.filter((n) => n.roles.includes('monitor')).map((n) => n.id);
      const checks = new Map<string, { ok: number; total: number; failures: string[] }>();
      if (monitors.length) {
        const fresh = new Date(Date.now() - (settings.probeIntervalSeconds * 3 + 30) * 1000);
        const probes = await ctx.db
          .select({ target: schema.nodeProbes.target, ok: schema.nodeProbes.ok, silent: schema.nodeProbes.silent, lastOkAt: schema.nodeProbes.lastOkAt, message: schema.nodeProbes.message })
          .from(schema.nodeProbes)
          .where(and(inArray(schema.nodeProbes.nodeId, monitors), eq(schema.nodeProbes.stationId, station.id), gt(schema.nodeProbes.checkedAt, fresh)));
        for (const p of probes) {
          // A stream that never played since it is checked says nothing about the server, as for the alerts.
          if (!p.ok && !p.lastOkAt) continue;
          const where = p.target.slice(p.target.lastIndexOf('@') + 1);
          const c = checks.get(where) ?? { ok: 0, total: 0, failures: [] };
          const good = p.ok && p.silent !== true;
          c.total++;
          if (good) c.ok++;
          else c.failures.push(`${p.target.slice(station.slug.length, p.target.lastIndexOf('@'))}: ${p.ok ? 'silence' : (p.message ?? 'no audio')}`);
          checks.set(where, c);
        }
      }

      const out: NodeRow[] = [];
      const add = (n: (typeof nodes)[number], role: NodeRow['role'], standby = false, relayIssues: string[] = []) => {
        if (out.some((x) => x.id === n.id)) return;
        const s = n.status;
        const c = checks.get(n.id);
        const issues: NodeRow['issues'] = [];
        if (!s.online) issues.push({ kind: 'offline', message: null });
        for (const p of s.problems ?? []) issues.push({ kind: 'problem', message: p });
        for (const f of c?.failures ?? []) issues.push({ kind: 'check', message: f });
        for (const m of relayIssues) issues.push({ kind: 'relay', message: m });
        if (s.firewall && (s.firewall.state === 'failed' || s.firewall.state === 'rolledBack')) issues.push({ kind: 'firewall', message: s.firewall.message ?? null });
        out.push({
          id: n.id,
          name: n.name,
          role,
          shared: !isDedicated(n),
          state: !s.online ? 'offline' : issues.length ? 'warning' : standby ? 'standby' : 'online',
          cpu: s.online && typeof s.cpu === 'number' ? Math.round(s.cpu * 100) : null,
          memory: s.online && typeof s.memory === 'number' ? Math.round(s.memory * 100) : null,
          checks: c ? { ok: c.ok, total: c.total } : null,
          firewall: s.firewall?.state ?? null,
          version: s.version ?? null,
          commit: s.commit ?? null,
          listeners: role === 'relay' ? (s.relays ?? []).filter((x) => x.key.startsWith(`${station.slug}/`)).reduce((a, x) => a + (x.listeners ?? 0), 0) : null,
          issues,
        });
      };
      const addMain = (role: NodeRow['role'], standby: boolean) => {
        if (out.some((x) => x.id === 'main')) return;
        const c = checks.get('main');
        const issues: NodeRow['issues'] = [];
        if (!worker?.alive) issues.push({ kind: 'offline', message: null });
        for (const f of c?.failures ?? []) issues.push({ kind: 'check', message: f });
        const cores = os.cpus().length || 1;
        out.push({
          id: 'main',
          name: names.ingest,
          role,
          shared: true,
          state: !worker?.alive ? 'offline' : issues.length ? 'warning' : standby ? 'standby' : 'online',
          cpu: Math.min(100, Math.round((os.loadavg()[0]! / cores) * 100)),
          memory: Math.round((1 - os.freemem() / os.totalmem()) * 100),
          checks: c ? { ok: c.ok, total: c.total } : null,
          firewall: null,
          version: version.version,
          commit: version.commit ?? null,
          listeners: null,
          issues,
        });
      };

      const studio = station.nodeId ? nodes.find((n) => n.id === station.nodeId) : null;
      if (studio) add(studio, 'station');
      // The ingests: on a station node the ones its streams go through now, else the chosen ones.
      const refs = station.nodeId ? studioDelivery(station, rows).ingests.map((i) => ({ ref: i.node.id, priority: i.priority })) : ingestsOf(r);
      const onAir = (ref: string) => (ref === 'local' ? !!worker?.onAir[station.id]?.length : !!nodes.find((n) => n.id === ref)?.status.ingest?.some((m) => m.stationId === station.id));
      const anyOnAir = refs.some((i) => onAir(i.ref));
      for (const i of refs) {
        const role = i.priority === 0 ? 'ingest' : 'backupIngest';
        // A backup that is fine but does not carry the station now stands by.
        const standby = i.priority > 0 && anyOnAir && !onAir(i.ref);
        if (i.ref === 'local') addMain(role, standby);
        else {
          const n = nodes.find((x) => x.id === i.ref);
          if (n) add(n, role, standby);
        }
      }
      const relays = nodes.filter((n) => n.roles.includes('relay') && serves(n, station));
      for (const n of relaysOf(station, relays)) {
        const failing = (n.status.relays ?? []).filter((x) => x.key.startsWith(`${station.slug}/`) && x.state === 'error').map((x) => `${x.key.slice(station.slug.length)}: ${x.message ?? 'error'}`);
        add(n as (typeof nodes)[number], 'relay', false, failing);
      }
      // The recorders that record this station (phase 21).
      for (const n of nodes) {
        const rec = n.config?.recordStations ?? [];
        if (n.roles.includes('recorder') && serves(n, station) && (rec === 'all' || rec.includes(station.id))) add(n, 'recorder');
      }
      return { nodes: out };
    },
  );
};
