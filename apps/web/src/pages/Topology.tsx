import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Plus } from 'lucide-react';
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { formatBps, formatMs, formatPct } from '../components/nodes/common';
import { Sparkline } from '../components/stats/charts';
import type { SceneData, SceneHealth, SceneKind } from '../components/topology/scene';
import { Badge, Button, Card, PageHeader, Select, Spinner } from '../components/ui';
import { api, type NodeEvent, type NodeMetric, type Tenant, type Topology, type TopologyNode } from '../lib/api';
import { isAdmin, useMe } from '../lib/auth';
import { formatDuration, formatRelative } from '../lib/format';
import { useThemeContext } from '../lib/theme-context';
import { eventText } from './NodeDetail';

const TopologyCanvas = lazy(() => import('../components/topology/TopologyCanvas'));

type Filter = 'all' | 'relays' | 'sources' | 'stations' | 'problems' | 'mine' | 'streams';

const kindOf = (n: TopologyNode): SceneKind => (n.roles.includes('station') ? 'station' : n.roles.includes('relay') ? 'relay' : n.roles.includes('source') ? 'source' : 'node');
const healthOf = (n: TopologyNode): SceneHealth => (!n.paired ? 'unpaired' : !n.online ? 'offline' : n.degraded ? 'degraded' : 'online');
const healthTone = { online: 'online', degraded: 'warning', offline: 'offline', unpaired: 'neutral' } as const;

function Kpi({ label, value, note, warn }: { label: string; value: ReactNode; note: ReactNode; warn?: boolean }) {
  return (
    <Card className="px-4 py-3 whitespace-nowrap">
      <div className="text-[11.5px] text-muted">{label}</div>
      <div className="display text-xl tabular-nums">{value}</div>
      <div className={clsx('mt-0.5 truncate text-[11px] font-semibold', warn ? 'text-warning' : 'text-online')}>{note}</div>
    </Card>
  );
}

function Rows({ rows }: { rows: [ReactNode, ReactNode, boolean?][] }) {
  return (
    <div className="flex flex-col divide-y divide-line text-[13px]">
      {rows.map(([k, v, warn], i) => (
        <div key={i} className="flex justify-between gap-3 py-2">
          <span className="text-muted">{k}</span>
          <span className={clsx('text-right font-semibold', warn && 'text-warning')}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="display text-lg tabular-nums">{value}</div>
    </div>
  );
}

function NodePanel({ node, open }: { node: TopologyNode; open: boolean }) {
  const { t } = useTranslation();
  const metrics = useQuery({ queryKey: ['nodes', node.id, 'metrics', 1], queryFn: () => api<NodeMetric[]>(`/nodes/${node.id}/metrics?hours=1`), enabled: open, refetchInterval: 60_000 });
  const events = useQuery({ queryKey: ['nodes', node.id, 'events', 5], queryFn: () => api<NodeEvent[]>(`/nodes/${node.id}/events?limit=5`), enabled: open, refetchInterval: 30_000 });
  const health = healthOf(node);
  const rtts = (metrics.data ?? []).map((m) => m.rttAvg ?? 0);
  return (
    <>
      <div>
        <div className="text-[11px] tracking-[0.08em] text-muted uppercase">{t('topology.selected')}</div>
        <h2 className="display text-lg">{node.name}</h2>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone={healthTone[health]} dot>
          {t(`nodes.health.${health}`)}
        </Badge>
        {node.roles.map((r) => (
          <Badge key={r}>{t(`nodes.roles.${r}`)}</Badge>
        ))}
        {node.own && <Badge tone="accent">{t('topology.yourNode')}</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Tile label={t('topology.listenersNow')} value={node.online ? node.listeners.toLocaleString() : '—'} />
        <Tile label={t('nodes.detail.outgoing')} value={node.online ? formatBps(node.txBps) : '—'} />
        <Tile label={t('nodes.detail.cpu')} value={node.online && node.cpu != null ? `${Math.round(node.cpu * 100)}%` : '—'} />
        <Tile label={t('nodes.detail.encoders')} value={node.online ? node.encoders : '—'} />
      </div>
      <div className="rounded-md border border-line bg-surface px-3 py-2.5">
        <div className="flex justify-between text-[11px] text-muted">
          <span>{t('topology.latencyToMain')}</span>
          <span className={clsx('font-semibold', node.degraded ? 'text-warning' : 'text-online')}>{node.online ? formatMs(node.rttMs) : '—'}</span>
        </div>
        {open && rtts.length > 1 ? <Sparkline values={rtts} height={52} /> : <div className="h-[52px]" />}
      </div>
      <Rows
        rows={[
          [t('nodes.detail.timeouts24h'), node.timeouts24h ?? 0, (node.timeouts24h ?? 0) > 0],
          [t('nodes.detail.loss'), node.online ? formatPct(node.loss ?? 0) : '—', (node.loss ?? 0) > 0.05],
          ...(node.roles.includes('station') ? ([[t('topology.stationsOnNode'), String(node.stations), false]] as [ReactNode, ReactNode, boolean][]) : []),
          ...(node.roles.includes('relay') ? ([[t('topology.streamsRelayed'), t('topology.relayCount', { up: node.relaysUp, total: node.relaysTotal, stations: node.stations }), node.relaysUp < node.relaysTotal]] as [ReactNode, ReactNode, boolean][]) : []),
          [t('nodes.detail.place'), [node.city, node.country].filter(Boolean).join(', ') || node.location || '—'],
          [t('nodes.detail.version'), node.version ? `v${node.version}${node.updateAvailable ? ` · ${t('nodes.updateAvailable')}` : ''}` : '—', node.updateAvailable],
        ]}
      />
      {open && !!events.data?.length && (
        <>
          <div className="text-[11px] tracking-[0.08em] text-muted uppercase">{t('topology.recentEvents')}</div>
          <Rows rows={events.data.map((e) => [eventText(t, e), formatRelative(e.at), e.level !== 'info'])} />
        </>
      )}
      {open && (
        <Link to={`/nodes/${node.id}`}>
          <Button className="w-full">
            {t('topology.openNode')} <ArrowRight className="size-4" />
          </Button>
        </Link>
      )}
    </>
  );
}

function MainPanel({ data }: { data: Topology }) {
  const { t } = useTranslation();
  return (
    <>
      <div>
        <div className="text-[11px] tracking-[0.08em] text-muted uppercase">{t('topology.selected')}</div>
        <h2 className="display text-lg">{t('topology.main')}</h2>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="online" dot>
          {t('nodes.health.online')}
        </Badge>
        <Badge>{t('topology.orchestrator')}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Tile label={t('topology.listenersHere')} value={data.main.listeners.toLocaleString()} />
        <Tile label={t('topology.stations')} value={data.main.stations} />
        <Tile label={t('topology.nodesOnline')} value={`${data.kpis.nodesOnline} / ${data.kpis.nodesTotal}`} />
        <Tile label={t('topology.studiosLive')} value={data.studios.length} />
      </div>
      <Rows
        rows={[
          [t('nodes.detail.version'), `v${data.main.version}`],
          [t('topology.channel'), data.main.branch ?? '—'],
          [t('topology.relayListeners'), data.kpis.relayListeners.toLocaleString()],
          [t('topology.throughput'), formatBps(data.kpis.txBps)],
        ]}
      />
    </>
  );
}

function StudioPanel({ studio, target }: { studio: Topology['studios'][number]; target: string }) {
  const { t } = useTranslation();
  return (
    <>
      <div>
        <div className="text-[11px] tracking-[0.08em] text-muted uppercase">{t('topology.selected')}</div>
        <h2 className="display text-lg">{t('topology.studioOf', { station: studio.station })}</h2>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="accent" dot>
          {t('topology.onAir')}
        </Badge>
      </div>
      <Rows
        rows={[
          [t('topology.dj'), studio.account],
          [t('topology.mount'), <span className="font-mono">{studio.mount}</span>],
          [t('topology.via'), studio.via],
          [t('topology.connectsTo'), target],
          [t('topology.onAirFor'), formatDuration(studio.since)],
        ]}
      />
    </>
  );
}

export function TopologyPage() {
  const { t } = useTranslation();
  const me = useMe().data!;
  const admin = isAdmin(me);
  const { theme } = useThemeContext();
  const [params, setParams] = useSearchParams();
  const tenantId = admin ? (params.get('customer') ?? '') : '';
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const topo = useQuery({ queryKey: ['topology', tenantId], queryFn: () => api<Topology>(`/nodes/topology${tenantId ? `?tenantId=${tenantId}` : ''}`), refetchInterval: 5000 });
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants'), enabled: admin });
  const data = topo.data;
  const customer = data?.view === 'customer';
  const filters: Filter[] = customer ? ['all', 'mine', 'streams'] : ['all', 'relays', 'sources', 'stations', 'problems'];

  const scene = useMemo<SceneData>(() => {
    if (!data) return { nodes: [], links: [] };
    const matches = (n: TopologyNode) =>
      filter === 'all' || filter === 'streams' || (filter === 'relays' && n.roles.includes('relay')) || (filter === 'sources' && n.roles.includes('source')) || (filter === 'stations' && n.roles.includes('station')) || (filter === 'problems' && (n.degraded || !n.online)) || (filter === 'mine' && n.own);
    const nodes: SceneData['nodes'] = [
      { id: 'main', kind: 'main', label: t('topology.main'), meta: `${t('topology.orchestrator')} · v${data.main.version}`, health: 'online', listeners: data.main.listeners, dim: false },
      ...data.nodes.map((n) => {
        const kind = kindOf(n);
        const meta = !n.paired
          ? t('nodes.health.unpaired')
          : !n.online
            ? t('nodes.health.offline')
            : kind === 'relay'
              ? t('topology.listenersCount', { count: n.listeners })
              : kind === 'source'
                ? t('topology.encodersCount', { count: n.encoders })
                : kind === 'station'
                  ? t('topology.stationsCount', { count: n.stations })
                  : n.location || t('nodes.noRoles');
        return { id: n.id, kind, label: customer && n.own ? t('topology.myNode', { name: n.name }) : n.name, meta, health: healthOf(n), listeners: n.online ? n.listeners : 0, dim: !matches(n), own: customer && n.own };
      }),
      ...data.studios.map((s) => ({
        id: s.id,
        kind: 'studio' as const,
        label: t('topology.studioOf', { station: s.station }),
        meta: `${s.account} · ${s.via}`,
        health: 'online' as const,
        listeners: 0,
        dim: filter !== 'all' && filter !== 'streams' && !(s.nodeId && matches(data.nodes.find((n) => n.id === s.nodeId)!)),
      })),
    ];
    const dim = new Set(nodes.filter((n) => n.dim).map((n) => n.id));
    const links: SceneData['links'] = data.links.map((l) => ({
      from: l.from,
      to: l.to,
      kind: l.kind,
      state: !l.active ? 'down' : l.degraded ? 'degraded' : 'ok',
      label: l.kind === 'control' && l.active && l.rttMs != null ? `${formatMs(l.rttMs)}${(l.loss ?? 0) > 0.005 ? ` · ${formatPct(l.loss, 0)}` : ''}` : null,
      dim: dim.has(l.from) || dim.has(l.to) || (filter === 'streams' && l.kind === 'control'),
    }));
    return { nodes, links };
  }, [data, filter, customer, t]);

  const k = data?.kpis;
  const selNode = data?.nodes.find((n) => n.id === selected);
  const selStudio = data?.studios.find((s) => s.id === selected);
  const ownSel = selNode ?? (!selected && customer ? data?.nodes.find((n) => n.own) : undefined);

  return (
    <>
      <PageHeader
        title={customer && !admin ? t('topology.myTitle') : t('topology.title')}
        description={customer && !admin ? t('topology.mySubtitle') : t('topology.subtitle')}
        actions={
          <>
            {admin && (
              <div className="w-56">
                <Select className="h-9" value={tenantId} onChange={(e) => setParams(e.target.value ? { customer: e.target.value } : {}, { replace: true })} aria-label={t('topology.viewAs')}>
                  <option value="">{t('topology.wholeNetwork')}</option>
                  {(tenants.data ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {t('topology.asCustomer', { name: x.name })}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {filters.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={clsx(
                    'rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
                    filter === f ? 'border-nacht bg-nacht text-white dark:border-koraal dark:bg-koraal dark:text-nacht' : 'border-line bg-raised hover:bg-hover',
                  )}
                >
                  {t(`topology.filters.${f}`)}
                </button>
              ))}
            </div>
          </>
        }
      />
      {!data ? (
        <div className="grid place-items-center py-24">{topo.isError ? <p className="text-muted">{(topo.error as Error).message}</p> : <Spinner />}</div>
      ) : (
        <div className="flex flex-col gap-4 xl:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi
                label={t('topology.nodesOnline')}
                value={`${k!.nodesOnline} / ${k!.nodesTotal}`}
                note={k!.degraded ? t('topology.degradedCount', { count: k!.degraded }) : k!.nodesOnline < k!.nodesTotal ? t('topology.someOffline') : t('topology.allHealthy')}
                warn={!!k!.degraded || k!.nodesOnline < k!.nodesTotal}
              />
              <Kpi label={t('topology.listenersNow')} value={k!.listeners.toLocaleString()} note={t('topology.viaRelays', { count: k!.relayListeners })} />
              <Kpi
                label={customer ? t('topology.latencyToMain') : t('topology.avgLatency')}
                value={formatMs(k!.avgRttMs)}
                note={k!.worst && (k!.worstRttMs ?? 0) > (k!.avgRttMs ?? 0) * 1.5 ? `${k!.worst} ${formatMs(k!.worstRttMs)}` : t('topology.stable')}
                warn={!!data.nodes.some((n) => n.online && n.degraded)}
              />
              {customer ? (
                <Kpi label={t('nodes.detail.timeouts24h')} value={k!.timeouts24h} note={k!.timeouts24h ? t('topology.checkEvents') : t('topology.noIncidents')} warn={k!.timeouts24h > 0} />
              ) : (
                <Kpi label={t('topology.throughput')} value={formatBps(k!.txBps)} note={t('topology.fromNodes')} />
              )}
            </div>
            <div className="topo-stage relative h-[min(70vh,640px)] min-h-[420px] overflow-hidden rounded-lg border border-line">
              <Suspense
                fallback={
                  <div className="grid h-full place-items-center">
                    <Spinner />
                  </div>
                }
              >
                <TopologyCanvas data={scene} selected={selected ?? ownSel?.id ?? null} onSelect={setSelected} dark={theme === 'dark'} />
              </Suspense>
              <div className="pointer-events-none absolute bottom-3 left-3 hidden flex-wrap gap-3 rounded-md border border-line bg-raised/85 px-3 py-2 text-xs text-muted backdrop-blur sm:flex">
                <span className="flex items-center gap-1.5">
                  <i className="inline-block h-[3px] w-4 rounded bg-koraal" /> {t('topology.legend.stream')}
                </span>
                <span className="flex items-center gap-1.5">
                  <i className="inline-block h-[3px] w-4 rounded bg-lucht" /> {t('topology.legend.control')}
                </span>
                <span className="flex items-center gap-1.5">
                  <i className="inline-block h-[3px] w-4 rounded bg-warning" /> {t('topology.legend.degraded')}
                </span>
                <span className="flex items-center gap-1.5">
                  <i className="inline-block size-2 rounded-full bg-lucht" /> {t('topology.legend.listeners')}
                </span>
              </div>
              {!data.nodes.length && (
                <div className="absolute top-3 left-3 max-w-xs rounded-md border border-line bg-raised/90 p-3 text-[13px] backdrop-blur">
                  <p className="text-muted">{t('topology.noNodes')}</p>
                  <Link to="/nodes" className="mt-2 inline-block">
                    <Button size="sm" variant="primary">
                      <Plus className="size-4" /> {t('nodes.add.button')}
                    </Button>
                  </Link>
                </div>
              )}
              <p className="pointer-events-none absolute top-3 right-3 hidden text-[11px] text-muted md:block">{t('topology.hint')}</p>
            </div>
          </div>
          <Card className="flex w-full shrink-0 flex-col gap-3.5 p-5 xl:w-[330px]">
            {selStudio ? (
              <StudioPanel studio={selStudio} target={selStudio.nodeId ? (data.nodes.find((n) => n.id === selStudio.nodeId)?.name ?? '—') : t('topology.main')} />
            ) : ownSel ? (
              <NodePanel key={ownSel.id} node={ownSel} open={data.view === 'admin' || ownSel.own || admin} />
            ) : (
              <MainPanel data={data} />
            )}
          </Card>
        </div>
      )}
    </>
  );
}
