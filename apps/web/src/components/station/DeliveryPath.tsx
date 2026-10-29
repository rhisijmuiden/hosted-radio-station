import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Bot, Headphones, Mic, Radio, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api, type StationDetail, type Topology, type TopologyCell, type TopologyNode } from '../../lib/api';
import { Badge, Card, CardHeader, Spinner } from '../ui';

type Health = 'online' | 'warning' | 'offline' | 'neutral';

const cellHealth: Record<TopologyCell, Health> = { onAir: 'online', standby: 'neutral', degraded: 'warning', down: 'offline', idle: 'neutral' };
const dot: Record<Health, string> = { online: 'bg-online', warning: 'bg-warning', offline: 'bg-offline', neutral: 'bg-muted' };

interface Hop {
  id: string;
  kind: string;
  name: string;
  meta: ReactNode[];
  health: Health;
  /** Carries the stream now (drawn with a coral border). */
  live: boolean;
  icon: ReactNode;
  to?: string;
  listeners?: number;
}

export function useStationTopology(station: Pick<StationDetail, 'tenantId'>) {
  return useQuery({ queryKey: ['topology', station.tenantId], queryFn: () => api<Topology>(`/nodes/topology?tenantId=${station.tenantId}`), refetchInterval: 5000 });
}

/**
 * How the stream of one station reaches its listeners (phase 19): the source (a DJ, an encoder or the AutoDJ), the
 * station node or the ingest that takes it, every relay that carries it, and the listeners, each with its state.
 * Built from the same picture as the topology view, so both always agree.
 */
function useDeliveryPath(station: StationDetail) {
  const { t } = useTranslation();
  const topo = useStationTopology(station);
  const d = topo.data;
  if (!d) return { loading: !topo.error, error: topo.error as Error | null, path: null };
  const ts = d.stations.find((x) => x.id === station.id);
  if (!ts) return { loading: false, error: null, path: null };

  const node = (id: string | null) => (id ? d.nodes.find((n) => n.id === id) : undefined);
  const link = (n: TopologyNode | undefined) => (n && !n.local ? `/nodes/${n.id}` : undefined);
  const ping = (n: TopologyNode | undefined) =>
    n && n.rttMs != null ? t('delivery.ping', { ms: Math.round(n.rttMs), loss: ((n.loss ?? 0) * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) }) : null;
  const nodeHealth = (n: TopologyNode | undefined, cell?: TopologyCell): Health => {
    if (!n || !n.online) return 'offline';
    if (n.degraded || cell === 'degraded') return 'warning';
    return cell ? cellHealth[cell] : 'online';
  };
  const stateText = (h: Health, live: boolean) => (h === 'offline' ? t('delivery.state.offline') : h === 'warning' ? t('delivery.state.problems') : live ? t('delivery.state.onAir') : t('delivery.state.standby'));

  // 1. Sources: live DJs and encoders, then the AutoDJ of a Radio station.
  const studios = d.studios.filter((s) => s.stationId === station.id);
  const sources: Hop[] = studios.map((s) => ({
    id: s.id,
    kind: t('delivery.source'),
    name: s.account,
    meta: [t('delivery.liveVia', { via: s.via })],
    health: 'online',
    live: true,
    icon: <Mic />,
  }));
  if (station.edition === 'station')
    sources.push({
      id: 'autodj',
      kind: t('delivery.source'),
      name: t('delivery.autodj'),
      meta: [studios.length ? t('delivery.autodjStandby') : ts.active ? t('delivery.state.onAir') : t('delivery.state.standby')],
      health: studios.length ? 'neutral' : ts.active ? 'online' : 'neutral',
      live: !studios.length && !!ts.active,
      icon: <Bot />,
    });
  if (!sources.length) sources.push({ id: 'none', kind: t('delivery.source'), name: t('delivery.noSource'), meta: [t('delivery.noSourceHint')], health: 'neutral', live: false, icon: <Mic /> });

  // 2. The station node (a step of its own), then the main and backup ingest it sends to.
  let studio: Hop | null = null;
  const first: Hop[] = [];
  if (ts.stationNode) {
    const n = node(ts.stationNode);
    const h = nodeHealth(n, ts.cells[ts.stationNode]);
    // By default the station node sends through the ingest(s), which feed the relays (1.3).
    const via = ts.ingest && ts.ingest !== ts.stationNode ? node(ts.ingest) : null;
    const live = via ? ts.cells[ts.stationNode] === 'onAir' : ts.active === ts.stationNode;
    studio = { id: ts.stationNode, kind: t('delivery.stationNode'), name: n?.name ?? '—', meta: [stateText(h, live), n?.location || null, ping(n), via ? t('delivery.viaIngest', { name: via.name }) : t('delivery.feedsRelays')].filter(Boolean) as string[], health: h, live, icon: <Server />, to: link(n) };
    for (const [ref, kind] of [
      [via ? ts.ingest : null, t('delivery.mainIngest')],
      [via ? ts.backup : null, t('delivery.backupIngest')],
    ] as const) {
      if (!ref) continue;
      const x = node(ref);
      const on = ts.active === ref;
      const hx = !x?.online ? 'offline' : x.degraded ? 'warning' : on ? 'online' : 'neutral';
      first.push({ id: ref, kind, name: x?.name ?? '—', meta: [stateText(hx, on), x?.location || null, ping(x)].filter(Boolean) as string[], health: hx, live: on, icon: <Server />, to: link(x) });
    }
  } else {
    for (const [ref, kind] of [
      [ts.ingest, t('delivery.mainIngest')],
      [ts.backup, t('delivery.backupIngest')],
    ] as const) {
      if (!ref) continue;
      const n = node(ref);
      const live = ts.active === ref;
      const h = !n?.online ? 'offline' : n.degraded ? 'warning' : live ? 'online' : 'neutral';
      first.push({ id: ref, kind, name: n?.name ?? d.main.name, meta: [stateText(h, live), n?.location || null, ping(n)].filter(Boolean) as string[], health: h, live, icon: <Server />, to: link(n) });
    }
    if (!first.length) first.push({ id: 'main', kind: t('delivery.mainIngest'), name: d.main.name, meta: [t('delivery.state.standby')], health: 'neutral', live: false, icon: <Server /> });
  }

  // 3. Every relay that carries the station, with its listeners for this station.
  const listenersOn = (id: string) => d.audience.filter((a) => a.nodeId === id && a.stationId === station.id).reduce((x, a) => x + a.listeners, 0);
  const relays: Hop[] = ts.relays.map((id) => {
    const n = node(id);
    const cell = ts.cells[id] ?? 'idle';
    const h = nodeHealth(n, cell);
    const live = cell === 'onAir' || cell === 'degraded';
    const loss = n && n.relaysTotal ? t('delivery.mounts', { up: n.relaysUp, total: n.relaysTotal }) : null;
    return { id, kind: t('delivery.relay'), name: n?.name ?? '—', meta: [stateText(h, live), loss, n?.location || null, ping(n)].filter(Boolean) as string[], health: h, live, icon: <Radio />, to: link(n), listeners: listenersOn(id) };
  });

  // 4. Listeners, with the three biggest countries.
  const byCountry = new Map<string, number>();
  for (const a of d.audience.filter((x) => x.stationId === station.id && x.country)) byCountry.set(a.country!, (byCountry.get(a.country!) ?? 0) + a.listeners);
  const total = ts.listeners;
  const countries = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${c} ${total ? Math.round((n / total) * 100) : 0}%`);

  // One verdict for the whole route: the worst hop that carries (or should carry) the stream.
  const carrying = [...(studio ? [studio] : []), ...first.filter((h) => h.live || h.id === ts.ingest), ...relays];
  // Without a relay nothing reaches the listeners, whatever the rest says.
  const overall: Health = !relays.length ? 'offline' : carrying.some((h) => h.health === 'offline') ? (relays.some((r) => r.health === 'online') ? 'warning' : 'offline') : carrying.some((h) => h.health === 'warning') ? 'warning' : ts.active ? 'online' : 'neutral';
  const problems = carrying.filter((h) => h.health === 'offline' || h.health === 'warning').length || (relays.length ? 0 : 1);
  const links = d.links.filter((l) => l.kind === 'stream' && (first.some((f) => f.id === l.from) || l.from === studio?.id) && ts.relays.includes(l.to));
  const kbps = links.reduce((x, l) => x + (l.kbps ?? 0), 0);
  return { loading: false, error: null, path: { sources, studio, first, relays, total, countries, overall, problems, kbps, onAir: !!ts.active } };
}

function HopCard({ hop }: { hop: Hop }) {
  const body = (
    <div className={clsx('flex min-w-0 items-start gap-2.5 rounded-lg border bg-surface px-3 py-2.5', hop.live ? 'border-koraal' : 'border-line', !hop.live && hop.health === 'neutral' && 'opacity-70', hop.to && 'transition-colors hover:bg-hover')}>
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-chip text-accent-text [&_svg]:size-4">{hop.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">{hop.kind}</span>
        <span className="flex items-baseline justify-between gap-2">
          <b className="truncate text-[13.5px]">{hop.name}</b>
          {hop.listeners != null && <span className="shrink-0 text-xs text-muted tabular-nums">{hop.listeners}</span>}
        </span>
        {hop.meta.map((m, i) => (
          <small key={i} className="flex items-center truncate text-[12px] text-muted">
            {i === 0 && <span className={clsx('mr-1.5 inline-block size-2 shrink-0 rounded-full', dot[hop.health])} />}
            {m}
          </small>
        ))}
      </span>
    </div>
  );
  return hop.to ? <Link to={hop.to}>{body}</Link> : body;
}

function Arrow({ label }: { label?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-0.5 px-1 py-1 text-[10.5px] text-muted tabular-nums">
      <ArrowRight className="size-4 rotate-90 text-koraal md:rotate-0" />
      {label && <span className="whitespace-nowrap">{label}</span>}
    </div>
  );
}

function Column({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col justify-center gap-2">{children}</div>;
}

function OverallBadge({ overall, problems, onAir }: { overall: Health; problems: number; onAir: boolean }) {
  const { t } = useTranslation();
  const text = overall === 'online' ? t('delivery.overall.ok') : overall === 'offline' ? t('delivery.overall.down') : overall === 'warning' ? t('delivery.overall.problems', { count: problems }) : onAir ? t('delivery.overall.ok') : t('delivery.overall.offAir');
  return (
    <Badge tone={overall} dot>
      {text}
    </Badge>
  );
}

/** The full delivery path, on its own page of the station menu. */
export function DeliveryPathCard({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const { loading, error, path } = useDeliveryPath(station);
  return (
    <Card>
      <CardHeader title={t('delivery.title')} description={t('delivery.subtitle', { station: station.name })} actions={path && <OverallBadge overall={path.overall} problems={path.problems} onAir={path.onAir} />} />
      {loading ? (
        <div className="grid place-items-center p-10">
          <Spinner />
        </div>
      ) : !path ? (
        <p className="p-5 text-[13px] text-muted">{error?.message ?? t('delivery.noRoute')}</p>
      ) : (
        <>
          <div
            className={clsx(
              'grid gap-1 p-5 md:items-center',
              // With a station node and an ingest each gets its own column: source → studio node → ingest → relays → listeners.
              path.studio && path.first.length
                ? 'md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1.25fr)_auto_minmax(0,0.8fr)]'
                : 'md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1.25fr)_auto_minmax(0,0.8fr)]',
            )}
          >
            <Column>
              {path.sources.map((h) => (
                <HopCard key={h.id} hop={h} />
              ))}
            </Column>
            <Arrow />
            {path.studio && (
              <>
                <Column>
                  <HopCard hop={path.studio} />
                </Column>
                {path.first.length > 0 && <Arrow />}
              </>
            )}
            {(path.first.length > 0 || !path.studio) && (
              <Column>
                {path.first.map((h) => (
                  <HopCard key={h.id} hop={h} />
                ))}
              </Column>
            )}
            <Arrow label={path.kbps ? `${path.kbps} kbps` : undefined} />
            <Column>
              {path.relays.length ? path.relays.map((h) => <HopCard key={h.id} hop={h} />) : <p className="rounded-lg border border-dashed border-offline/50 px-3 py-4 text-center text-[13px] text-offline">{t('delivery.noRelays')}</p>}
            </Column>
            <Arrow />
            <Column>
              <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-chip text-accent-text">
                  <Headphones className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">{t('delivery.listeners')}</span>
                  <b className="display block text-[22px] leading-tight tabular-nums">{path.total}</b>
                  {!!path.countries.length && <small className="block truncate text-[12px] text-muted">{path.countries.join(' · ')}</small>}
                </span>
              </div>
            </Column>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-5 py-3 text-xs text-muted">
            {(['online', 'warning', 'offline', 'neutral'] as const).map((h) => (
              <span key={h} className="inline-flex items-center gap-1.5">
                <span className={clsx('size-2 rounded-full', dot[h])} />
                {t(`delivery.legend.${h}`)}
              </span>
            ))}
            <span>{t('delivery.legendPing')}</span>
          </div>
        </>
      )}
    </Card>
  );
}

/** The route in one line, for the station overview. */
export function DeliveryPathSummary({ station, to }: { station: StationDetail; to: string }) {
  const { t } = useTranslation();
  const { path } = useDeliveryPath(station);
  if (!path) return null;
  const pill = (h: Hop) => (
    <span key={h.id} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12.5px] whitespace-nowrap">
      <span className={clsx('size-2 rounded-full', dot[h.health])} />
      {h.name}
    </span>
  );
  const arrow = <ArrowRight className="size-3.5 shrink-0 text-koraal" />;
  const liveSources = path.sources.filter((s) => s.live);
  return (
    <Card>
      <CardHeader
        title={t('delivery.title')}
        actions={
          <span className="flex items-center gap-3">
            <OverallBadge overall={path.overall} problems={path.problems} onAir={path.onAir} />
            <Link to={to} className="text-[13px] font-semibold text-accent-text hover:underline">
              {t('delivery.details')}
            </Link>
          </span>
        }
      />
      <div className="flex flex-wrap items-center gap-1.5 px-5 py-4">
        {(liveSources.length ? liveSources : path.sources.slice(0, 1)).map(pill)}
        {arrow}
        {path.studio && (
          <>
            {pill(path.studio)}
            {path.first.length > 0 && arrow}
          </>
        )}
        {path.first.filter((h) => h.live || path.first.length === 1).map(pill)}
        {!path.first.some((h) => h.live) && path.first.length > 1 && pill(path.first[0]!)}
        {arrow}
        {path.relays.map(pill)}
        {arrow}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12.5px] whitespace-nowrap">
          <Headphones className="size-3.5 text-muted" />
          {t('delivery.listenerCount', { count: path.total })}
        </span>
      </div>
    </Card>
  );
}
