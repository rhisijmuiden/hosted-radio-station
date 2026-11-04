import { useQueries, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Info, Route } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { DeliveryPathSummary } from '../components/station/DeliveryPath';
import { PlacementCard } from '../components/station/Placement';
import { RoutingCard } from '../components/station/Routing';
import { stationTabHref } from '../components/station/menu';
import { Button, Card, EmptyState, PageHeader, Spinner } from '../components/ui';
import { api, type NodeItem, type StationDetail, type StationListItem, type StationRoutingView } from '../lib/api';
import { isAdmin, useMe } from '../lib/auth';
import { useServerNames } from '../lib/server';
import { EditionBadge } from './Stations';

const rank = { dj: 1, manager: 2, owner: 3 } as const;

function Chip({ tone, children }: { tone: 'own' | 'shared' | 'muted'; children: React.ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap',
        tone === 'own' && 'bg-[var(--top-active-bg)] text-accent-text',
        tone === 'shared' && 'bg-chip text-ink',
        tone === 'muted' && 'text-muted',
      )}
    >
      {children}
    </span>
  );
}

/**
 * Routing for customers (navigation step 2): one place that shows, for every station, where it runs, how its audio
 * reaches the relays and which relays carry it, with the editor of one station below the list.
 */
export function RoutingPage() {
  const { t } = useTranslation();
  const me = useMe().data!;
  const admin = isAdmin(me);
  const server = useServerNames();
  const [params, setParams] = useSearchParams();
  const editor = useRef<HTMLDivElement>(null);
  const stations = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations') });
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<NodeItem[]>('/nodes') });
  // The routing is for managers and owners; a DJ of a customer does not see that station here.
  const roleOf = (tenantId: string) => (admin ? 'owner' : me.memberships.find((m) => m.tenantId === tenantId)?.role);
  const list = (stations.data ?? []).filter((s) => admin || rank[roleOf(s.tenantId) ?? 'dj'] >= rank.manager);
  const views = useQueries({
    queries: list.map((s) => ({ queryKey: ['station-routing', s.id], queryFn: () => api<StationRoutingView>(`/stations/${s.id}/routing`), refetchInterval: 15_000 })),
  });
  const selectedId = params.get('station');
  const detail = useQuery({ queryKey: ['station', selectedId], queryFn: () => api<StationDetail>(`/stations/${selectedId}`), enabled: !!selectedId });
  const selected = detail.data && detail.data.id === selectedId ? detail.data : null;

  useEffect(() => {
    if (selected) editor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (stations.isPending)
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );

  const nodeName = (id: string) => nodes.data?.find((n) => n.id === id)?.name;
  const own = (s: StationListItem, id: string | null) => !!id && nodes.data?.some((n) => n.id === id && n.tenantId === s.tenantId);

  const runsOn = (s: StationListItem) => {
    if (s.nodeId) return own(s, s.nodeId) ? <Chip tone="own">{nodeName(s.nodeId)}</Chip> : <Chip tone="shared">{t('custRouting.sharedNode')}</Chip>;
    // A Distribution station has no station node: the customer's own software streams to an ingest.
    if (s.edition === 'distribution') return <Chip tone="muted">{t('custRouting.noNode')}</Chip>;
    return <Chip tone="shared">{t('custRouting.sharedNode')}</Chip>;
  };
  const via = (s: StationListItem, v: StationRoutingView | undefined) => {
    if (!v) return '—';
    const ingest = (ref: string) => (ref === 'local' ? (v.locked ? t('custRouting.ingestAuto') : (server?.ingest || t('custRouting.platformIngest'))) : (v.options.ingests.find((n) => n.id === ref)?.name ?? v.status.ingests.find((i) => i.ref === ref)?.name ?? '?'));
    if (v.locked && v.routing.delivery === 'direct') return t('custRouting.direct');
    if (v.locked && v.studio?.direct && v.studio.direct !== 'chosen') return t('custRouting.directFallback');
    const main = ingest(v.routing.ingest);
    return v.routing.backupIngest ? t('custRouting.ingestWithBackup', { main, backup: ingest(v.routing.backupIngest) }) : main;
  };
  const relays = (v: StationRoutingView | undefined) => {
    if (!v) return <Chip tone="muted">—</Chip>;
    const ownIds = new Set(v.options.relays.filter((r) => r.own).map((r) => r.id));
    const mine = v.status.relays.filter((r) => ownIds.has(r.id));
    const shared = v.status.relays.length - mine.length;
    return (
      <span className="flex flex-wrap gap-1">
        {v.routing.relays === 'auto' && <Chip tone="muted">{t('custRouting.auto')}</Chip>}
        {shared > 0 && <Chip tone="shared">{t('custRouting.sharedRelays', { count: shared })}</Chip>}
        {mine.map((r) => (
          <Chip key={r.id} tone="own">
            {t('custRouting.ownRelay', { name: r.name })}
          </Chip>
        ))}
        {!v.status.relays.length && <Chip tone="muted">{t('custRouting.noRelays')}</Chip>}
      </span>
    );
  };

  return (
    <>
      <PageHeader title={t('custRouting.title')} description={t('custRouting.subtitle')} />
      <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-lucht/60 bg-lucht/15 px-4 py-3 text-[13px]">
        <Info className="mt-0.5 size-4 shrink-0 text-muted" />
        {t('custRouting.tip')}
      </div>
      {!list.length ? (
        <Card>
          <EmptyState icon={<Route className="size-5" />} title={t('custRouting.emptyTitle')} description={t('custRouting.empty')} />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="border-b border-line text-[11px] tracking-[0.08em] text-muted uppercase">
                <th className="px-5 py-3 font-semibold">{t('custRouting.col.station')}</th>
                <th className="px-3 py-3 font-semibold">{t('custRouting.col.runsOn')}</th>
                <th className="px-3 py-3 font-semibold">{t('custRouting.col.via')}</th>
                <th className="px-3 py-3 font-semibold">{t('custRouting.col.relays')}</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {list.map((s, i) => {
                const v = views[i]?.data;
                const on = s.id === selectedId;
                return (
                  <tr key={s.id} className={clsx('border-b border-line last:border-0', on && 'bg-hover')}>
                    <td className="px-5 py-3">
                      <Link to={stationTabHref(s.id, 'overview')} className="block text-sm font-bold hover:underline">
                        {s.name}
                      </Link>
                      <span className="mt-0.5 inline-block">
                        <EditionBadge edition={s.edition} />
                      </span>
                    </td>
                    <td className="px-3 py-3">{runsOn(s)}</td>
                    <td className="px-3 py-3 text-[13.5px]">{views[i]?.isError ? <span className="text-muted">—</span> : via(s, v)}</td>
                    <td className="px-3 py-3">{relays(v)}</td>
                    <td className="px-5 py-3 text-right">
                      <Button size="sm" variant={on ? 'primary' : undefined} onClick={() => setParams(on ? {} : { station: s.id }, { replace: true })}>
                        {v?.canEdit ? t('custRouting.change') : t('custRouting.view')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {selectedId && (
        <div ref={editor} className="mt-6 scroll-mt-4 rounded-2xl border-2 border-koraal/70 p-4 sm:p-5">
          {!selected ? (
            <div className="grid place-items-center py-10">
              <Spinner />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="display text-lg">{t('custRouting.editTitle', { name: selected.name })}</h2>
                <span className="text-[12.5px] text-muted">{t('custRouting.applyNote')}</span>
              </div>
              <DeliveryPathSummary station={selected} to={stationTabHref(selected.id, 'routing')} />
              <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
                <div className="flex flex-col gap-2">
                  <div className="text-[13px] font-semibold text-muted">1 · {t('custRouting.where')}</div>
                  {selected.edition !== 'distribution' || selected.nodeId ? (
                    <PlacementCard station={selected} />
                  ) : (
                    <Card className="p-5 text-[13px] text-muted">{t('custRouting.whereDistribution')}</Card>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <div className="text-[13px] font-semibold text-muted">2 · {t('custRouting.howAndWhich')}</div>
                  <RoutingCard key={selected.id} station={selected} />
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
