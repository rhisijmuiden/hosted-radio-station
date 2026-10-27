import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Eye, EyeOff, Plus, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { formatBps, formatMs, formatPct } from '../components/nodes/common';
import { Sparkline } from '../components/stats/charts';
import type { SceneData, SceneHealth, SceneKind } from '../components/topology/scene';
import TopologyFlat, { countryName, flag, nodeName, streamWidth, type FlatLayout } from '../components/topology/TopologyFlat';
import TopologyMatrix from '../components/topology/TopologyMatrix';
import { Badge, Button, Card, PageHeader, Select, Spinner } from '../components/ui';
import { api, type NodeEvent, type NodeMetric, type Tenant, type Topology, type TopologyNode } from '../lib/api';
import { isAdmin, useMe } from '../lib/auth';
import { formatDuration, formatRelative } from '../lib/format';
import { useThemeContext } from '../lib/theme-context';
import { eventText } from './NodeDetail';

const TopologyCanvas = lazy(() => import('../components/topology/TopologyCanvas'));

/** Layers (A, the default), one station's path (B), the matrix (D) and the 3D skyline (phase 18). */
type View = 'layers' | 'station' | 'matrix' | '3d';
const VIEWS: View[] = ['layers', 'station', 'matrix', '3d'];
const ORIENTATIONS: FlatLayout[] = ['lr', 'tb'];

function load<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage is off: the choice lasts for this visit */
  }
}

/** The chosen view and the direction of the flat views, remembered per user in this browser. */
function useView(userId: string) {
  const viewKey = `hrs-topology-view:${userId}`;
  const flowKey = `hrs-topology-layout:${userId}`;
  // Before phase 18 one setting held both: "3d", "lr" or "tb".
  const [view, setView] = useState<View>(() => load(viewKey, VIEWS, load(flowKey, ['3d'], 'layers' as View)));
  const [flow, setFlow] = useState<FlatLayout>(() => load(flowKey, ORIENTATIONS, 'lr'));
  return {
    view,
    flow,
    setView: (v: View) => {
      setView(v);
      save(viewKey, v);
    },
    setFlow: (f: FlatLayout) => {
      setFlow(f);
      save(flowKey, f);
    },
  };
}

/** A row of rounded toggle buttons. */
function Segmented<T extends string>({ value, options, label, onChange, text, title }: { value: T; options: T[]; label: string; onChange: (v: T) => void; text: (v: T) => ReactNode; title?: (v: T) => string }) {
  return (
    <div className="flex rounded-full border border-line bg-raised p-[3px]" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          title={title?.(o)}
          onClick={() => onChange(o)}
          className={clsx('rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap transition-colors', value === o ? 'bg-nacht text-white dark:bg-koraal dark:text-nacht' : 'text-muted hover:text-ink')}
        >
          {text(o)}
        </button>
      ))}
    </div>
  );
}

type Filter = 'all' | 'relays' | 'sources' | 'stations' | 'problems' | 'mine' | 'streams';

const kindOf = (n: TopologyNode): SceneKind =>
  n.roles.includes('station') ? 'station' : n.roles.includes('relay') ? 'relay' : n.roles.includes('source') ? 'source' : n.roles.includes('fm') ? 'fm' : 'node';

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

function Host({ node }: { node: Pick<TopologyNode, 'hostname' | 'ip'> }) {
  const text = [node.hostname, node.ip].filter(Boolean).join(' · ');
  return text ? <div className="font-mono text-[11.5px] text-muted">{text}</div> : null;
}

/** One of this server's own roles: no node page, no metrics of its own. */
function LocalPanel({ node }: { node: TopologyNode }) {
  const { t } = useTranslation();
  const ingest = node.id === 'local:ingest';
  return (
    <>
      <div>
        <div className="text-[11px] tracking-[0.08em] text-muted uppercase">{t('topology.selected')}</div>
        <h2 className="display text-lg">{nodeName(t, node, false)}</h2>
        <Host node={node} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone={node.online ? 'online' : 'offline'} dot>
          {t(node.online ? 'nodes.health.online' : 'nodes.health.offline')}
        </Badge>
        <Badge>{t(ingest ? 'nodes.roles.source' : 'nodes.roles.relay')}</Badge>
      </div>
      <p className="text-[13px] text-muted">{t(ingest ? 'topology.local.ingestHint' : 'topology.local.relayHint')}</p>
      <div className="grid grid-cols-2 gap-2">
        {ingest ? <Tile label={t('nodes.detail.encoders')} value={node.encoders} /> : <Tile label={t('topology.listenersNow')} value={node.listeners.toLocaleString()} />}
        <Tile label={t('topology.stations')} value={node.stations} />
      </div>
    </>
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
        <Host node={node} />
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
        <h2 className="display text-lg">{data.main.name}</h2>
        {data.main.host && <div className="font-mono text-[11.5px] text-muted">{data.main.host}</div>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="online" dot>
          {t('nodes.health.online')}
        </Badge>
        <Badge tone="accent">{t('topology.orchestrator')}</Badge>
        <Badge>{data.main.orchestratorOnly ? t('orchestratorOnly.badgeOn') : t('topology.controlOnly')}</Badge>
      </div>
      <p className="text-[13px] text-muted">{t('topology.orchestratorHint')}</p>
      <div className="grid grid-cols-2 gap-2">
        <Tile label={t('topology.ingestNodes')} value={data.nodes.filter((n) => !n.local && n.roles.includes('source')).length} />
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
  const { t, i18n } = useTranslation();
  const me = useMe().data!;
  const admin = isAdmin(me);
  const { theme } = useThemeContext();
  const [params, setParams] = useSearchParams();
  const tenantId = admin ? (params.get('customer') ?? '') : '';
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  // Escape clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Control lines stay hidden unless asked for, or for the selected block: the audio paths stay readable.
  const [showControl, setShowControl] = useState(false);
  const { view, flow, setView, setFlow } = useView(me.user.id);
  const topo = useQuery({ queryKey: ['topology', tenantId], queryFn: () => api<Topology>(`/nodes/topology${tenantId ? `?tenantId=${tenantId}` : ''}`), refetchInterval: 5000 });
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants'), enabled: admin });
  const data = topo.data;
  const customer = data?.view === 'customer';
  const filters: Filter[] = customer ? ['all', 'mine', 'streams'] : ['all', 'relays', 'sources', 'stations', 'problems'];
  // The per station view: the station in the URL, else the one with the most listeners.
  const stationId = params.get('station');
  const focus = view === 'station' && data ? (data.stations.find((s) => s.id === stationId) ?? [...data.stations].sort((a, b) => b.listeners - a.listeners)[0] ?? null) : null;
  const pickStation = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('station', id);
    setParams(next, { replace: true });
    setSelected(null);
  };

  const scene = useMemo<SceneData>(() => {
    if (!data) return { nodes: [], links: [] };
    const matches = (n: TopologyNode) =>
      filter === 'all' || filter === 'streams' || (filter === 'relays' && n.roles.includes('relay')) || (filter === 'sources' && n.roles.includes('source')) || (filter === 'stations' && n.roles.includes('station')) || (filter === 'problems' && (n.degraded || !n.online)) || (filter === 'mine' && n.own);
    // Relays of one location stand next to each other.
    const ordered = [...data.nodes].sort((a, b) => (a.roles.includes('relay') && b.roles.includes('relay') ? a.location.localeCompare(b.location) : 0));
    const nodes: SceneData['nodes'] = [
      // The orchestrator carries no audio: it hovers above as a ring with control lines only.
      { id: 'main', kind: 'main', label: data.main.name, meta: data.main.orchestratorOnly ? t('orchestratorOnly.badgeOn') : t('topology.orchestrator'), health: 'online', listeners: 0, dim: false },
      ...ordered.map((n) => {
        const kind = kindOf(n);
        const meta = !n.paired
          ? t('nodes.health.unpaired')
          : !n.online
            ? t('nodes.health.offline')
            : kind === 'relay'
              ? `${t('topology.listenersCount', { count: n.listeners })}${n.rttMs != null && !n.local ? ` · ${formatMs(n.rttMs)}` : ''}`
              : kind === 'source'
                ? t('topology.encodersCount', { count: n.encoders })
                : kind === 'station'
                  ? t('topology.stationsCount', { count: n.stations })
                  : kind === 'fm'
                    ? n.fmOnAir
                      ? t('topology.fmOnAir')
                      : t('topology.fmOff')
                    : n.location || t('nodes.noRoles');
        const load = n.cpu ?? Math.min(1, n.encoders / 8);
        // An FM/MPX node of a station on a station node stands beside that node, in the studio.
        const homeId = kind === 'fm' ? (n.home ?? data.stations.find((s) => s.cells[n.id] && s.stationNode)?.stationNode) : undefined;
        const home = homeId && data.nodes.some((x) => x.id === homeId && x.roles.includes('station')) ? homeId : undefined;
        return { id: n.id, kind, label: nodeName(t, n, customer), meta, health: healthOf(n), listeners: n.online ? n.listeners : 0, load: n.online ? load : 0, dim: !matches(n), own: customer && n.own, home };
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
    // Listeners per country: the six biggest as towers of their own, the rest together.
    const perCountry = new Map<string, number>();
    for (const a of data.audience) perCountry.set(a.country ?? '', (perCountry.get(a.country ?? '') ?? 0) + a.listeners);
    const top = [...perCountry].filter(([cc]) => cc).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([cc]) => cc);
    const countryId = (cc: string | null) => `country:${cc && top.includes(cc) ? cc : 'other'}`;
    for (const [cc, n] of [...perCountry].sort((a, b) => b[1] - a[1])) {
      const id = countryId(cc);
      const known = nodes.find((x) => x.id === id);
      if (known) known.listeners += n;
      else nodes.push({ id, kind: 'country', label: id === 'country:other' ? `🌐 ${t('topology.flat.other')}` : `${flag(cc)} ${countryName(cc, i18n.language)}`, meta: '', health: 'online', listeners: n, dim: filter !== 'all' && filter !== 'streams' && filter !== 'relays' });
    }
    for (const n of nodes) if (n.kind === 'country') n.meta = t('topology.listenersCount', { count: n.listeners });
    const dim = new Set(nodes.filter((n) => n.dim).map((n) => n.id));
    const links: SceneData['links'] = data.links.map((l) => ({
      from: l.from,
      to: l.to,
      kind: l.kind,
      state: !l.active ? 'down' : l.degraded ? 'degraded' : 'ok',
      label: l.kind === 'control' && l.active && l.rttMs != null ? `${formatMs(l.rttMs)}${(l.loss ?? 0) > 0.005 ? ` · ${formatPct(l.loss, 0)}` : ''}` : null,
      dim: dim.has(l.from) || dim.has(l.to) || (filter === 'streams' && l.kind === 'control'),
      width: l.kind === 'stream' ? streamWidth(l) : undefined,
      standby: l.standby,
    }));
    // Relays hand their listeners to the countries.
    const toCountry = new Map<string, number>();
    for (const a of data.audience) {
      const key = `${a.nodeId}>${countryId(a.country)}`;
      toCountry.set(key, (toCountry.get(key) ?? 0) + a.listeners);
    }
    for (const [key, n] of toCountry) {
      const [from, to] = key.split('>') as [string, string];
      links.push({ from, to, kind: 'stream', state: 'ok', label: null, dim: dim.has(from) || dim.has(to), width: 1.5 + Math.min(5, Math.log2(1 + n) / 1.6) });
    }
    return { nodes, links, lanes: { studios: t('topology.lanes.studios'), ingest: t('topology.lanes.ingest'), relays: t('topology.lanes.relays'), listeners: t('topology.lanes.listeners') } };
  }, [data, filter, customer, t, i18n.language]);

  const dimmed = useMemo(() => new Set(scene.nodes.filter((n) => n.dim).map((n) => n.id)), [scene]);
  const k = data?.kpis;
  const selNode = data?.nodes.find((n) => n.id === selected);
  const selStudio = data?.studios.find((s) => s.id === selected);
  // In 3D the panel always shows something; the other views use the whole width until a block is clicked.
  const ownSel = selNode ?? (!selected && customer && view === '3d' ? data?.nodes.find((n) => n.own) : undefined);
  const showPanel = view === '3d' || (!!selected && !selected.startsWith('country:'));
  const flat = view === 'layers' || view === 'station';
  const studioTarget = (s: Topology['studios'][number]) => {
    const to = data?.links.find((l) => l.from === s.id)?.to;
    const n = data?.nodes.find((x) => x.id === to);
    return n ? nodeName(t, n, !!customer) : data?.main.name ?? t('topology.main');
  };
  const subtitle = `topology.views.${view}Hint`;

  return (
    <>
      <PageHeader
        title={customer && !admin ? t('topology.myTitle') : t('topology.title')}
        description={t(subtitle)}
        actions={
          <>
            {admin && (
              <div className="w-56">
                <Select
                  className="h-9"
                  value={tenantId}
                  onChange={(e) => {
                    setParams(e.target.value ? { customer: e.target.value } : {}, { replace: true });
                    setSelected(null);
                  }}
                  aria-label={t('topology.viewAs')}
                >
                  <option value="">{t('topology.wholeNetwork')}</option>
                  {(tenants.data ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {t('topology.asCustomer', { name: x.name })}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <Segmented
              value={view}
              options={VIEWS}
              label={t('topology.views.label')}
              text={(v) => t(`topology.views.${v}`)}
              onChange={(v) => {
                setView(v);
                setSelected(null);
              }}
            />
            {flat && <Segmented value={flow} options={ORIENTATIONS} label={t('topology.layout.label')} text={(f) => t(`topology.layout.${f}`)} title={(f) => t(`topology.layout.${f}Title`)} onChange={setFlow} />}
            {view !== 'station' && view !== 'matrix' && (
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
            )}
          </>
        }
      />
      {!data ? (
        <div className="grid place-items-center py-24">{topo.isError ? <p className="text-muted">{(topo.error as Error).message}</p> : <Spinner />}</div>
      ) : (
        <div className="flex flex-col gap-4 xl:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {view === 'station' ? (
              <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="w-72 max-w-full">
                  <Select className="h-9" value={focus?.id ?? ''} onChange={(e) => pickStation(e.target.value)} aria-label={t('topology.station.pick')}>
                    {!data.stations.length && <option value="">{t('topology.station.none')}</option>}
                    {[...data.stations]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </Select>
                </div>
                {focus && (
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <Badge tone={focus.active ? 'online' : 'offline'} dot>
                      {focus.active ? t('topology.onAir') : t('topology.station.offAir')}
                    </Badge>
                    <span className="text-muted">{t('topology.listenersCount', { count: focus.listeners })}</span>
                    <span className="text-muted">· {t('topology.station.relays', { count: focus.relays.length })}</span>
                    <Link to={`/stations/${focus.id}?tab=routing`} className="font-semibold text-accent-text hover:underline">
                      {t('topology.station.routing')}
                    </Link>
                  </div>
                )}
              </Card>
            ) : (
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
            )}
            <div className={clsx('relative h-[min(70vh,640px)] min-h-[420px] overflow-hidden rounded-lg border border-line', view === 'matrix' ? 'bg-raised' : 'topo-stage')}>
              {view === '3d' ? (
                <Suspense
                  fallback={
                    <div className="grid h-full place-items-center">
                      <Spinner />
                    </div>
                  }
                >
                  <TopologyCanvas data={scene} selected={selected ?? ownSel?.id ?? null} onSelect={setSelected} dark={theme === 'dark'} />
                </Suspense>
              ) : view === 'matrix' ? (
                <TopologyMatrix data={data} customer={!!customer} selected={selected} onSelect={setSelected} />
              ) : view === 'station' && !focus ? (
                <p className="p-6 text-[13px] text-muted">{t('topology.station.none')}</p>
              ) : (
                <TopologyFlat data={data} layout={flow} dimmed={view === 'station' ? new Set() : dimmed} selected={selected ?? ownSel?.id ?? null} showControl={showControl} focus={focus} onSelect={setSelected} />
              )}
              {view !== 'matrix' && (
                <div className="pointer-events-none absolute bottom-3 left-3 hidden max-w-[calc(100%-10rem)] flex-wrap gap-x-3 gap-y-1.5 rounded-md border border-line bg-raised/85 px-3 py-2 text-xs text-muted backdrop-blur sm:flex">
                  <span className="flex items-center gap-1.5">
                    <i className="inline-block h-[3px] w-4 rounded bg-koraal" /> {t('topology.legend.stream')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <i className="inline-block w-4 border-t-2 border-dashed border-lucht" /> {t('topology.legend.standby')}
                  </span>
                  {/* The control legend doubles as the switch for the control lines. */}
                  {view !== '3d' && (
                    <button
                      type="button"
                      aria-pressed={showControl}
                      title={t(showControl ? 'topology.controlLinesHide' : 'topology.controlLinesShow')}
                      onClick={() => setShowControl((x) => !x)}
                      className={clsx('pointer-events-auto -my-1 flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors', showControl ? 'border-lucht bg-lucht/15 text-ink' : 'border-line hover:text-ink')}
                    >
                      <i className="inline-block w-4 border-t-2 border-dotted border-lucht" /> {t('topology.legend.control')}
                      {showControl ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                    </button>
                  )}
                  {view === '3d' && (
                    <span className="flex items-center gap-1.5">
                      <i className="inline-block w-4 border-t-2 border-dotted border-lucht" /> {t('topology.legend.control')}
                    </span>
                  )}
                  <span className="flex items-center gap-1.5">
                    <i className="inline-block h-[3px] w-4 rounded bg-warning" /> {t('topology.legend.degraded')}
                  </span>
                  {view === '3d' && <span>{t('topology.legend.height')}</span>}
                </div>
              )}
              {!data.nodes.length && view !== 'matrix' && (
                <div className="absolute top-3 left-3 max-w-xs rounded-md border border-line bg-raised/90 p-3 text-[13px] backdrop-blur">
                  <p className="text-muted">{t('topology.noNodes')}</p>
                  <Link to="/nodes" className="mt-2 inline-block">
                    <Button size="sm" variant="primary">
                      <Plus className="size-4" /> {t('nodes.add.button')}
                    </Button>
                  </Link>
                </div>
              )}
              {view === '3d' && <p className="pointer-events-none absolute top-3 right-3 hidden text-[11px] text-muted md:block">{t('topology.hint')}</p>}
            </div>
          </div>
          {showPanel && (
            <Card className="relative flex w-full shrink-0 flex-col gap-3.5 p-5 xl:w-[330px]">
              {view !== '3d' && (
                <button type="button" className="absolute top-3 right-3 grid size-8 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink" title={t('common.close')} onClick={() => setSelected(null)}>
                  <X className="size-4" />
                </button>
              )}
              {selStudio ? (
                <StudioPanel studio={selStudio} target={studioTarget(selStudio)} />
              ) : ownSel?.local ? (
                <LocalPanel node={ownSel} />
              ) : ownSel ? (
                <NodePanel key={ownSel.id} node={ownSel} open={data.view === 'admin' || ownSel.own || admin} />
              ) : (
                <MainPanel data={data} />
              )}
            </Card>
          )}
        </div>
      )}
    </>
  );
}
