import { useQuery } from '@tanstack/react-query';
import { BarChart3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { StatisticsView, type StatsScope } from '../components/stats/StatisticsView';
import { Card, EmptyState, PageHeader, Select, Spinner } from '../components/ui';
import { api, type StatsStation } from '../lib/api';

/** Statistics over all stations you may see, one customer or one station. */
export function StatisticsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const stations = useQuery({ queryKey: ['stats', 'stations'], queryFn: () => api<StatsStation[]>('/stats/stations') });
  const list = stations.data ?? [];
  const tenants = [...new Map(list.map((s) => [s.tenantId, s.tenantName])).entries()];
  const raw = params.get('scope') ?? '';
  const station = raw.startsWith('s:') ? list.find((s) => s.id === raw.slice(2)) : undefined;
  const tenantId = raw.startsWith('t:') && tenants.some(([id]) => id === raw.slice(2)) ? raw.slice(2) : undefined;
  const scope: StatsScope = station ? { stationId: station.id } : tenantId ? { tenantId } : {};
  const choose = (v: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v) next.set('scope', v);
        else next.delete('scope');
        next.delete('mount');
        return next;
      },
      { replace: true },
    );

  const selector = (
    <div className="w-full sm:w-64">
    <Select className="h-9" value={station ? `s:${station.id}` : tenantId ? `t:${tenantId}` : ''} onChange={(e) => choose(e.target.value)} aria-label={t('stats.scope')}>
      <option value="">{t('stats.allStations', { count: list.length })}</option>
      {tenants.map(([id, name]) => (
        <optgroup key={id} label={name}>
          {tenants.length > 1 && <option value={`t:${id}`}>{t('stats.allOfCustomer', { name })}</option>}
          {list
            .filter((s) => s.tenantId === id)
            .map((s) => (
              <option key={s.id} value={`s:${s.id}`}>
                {s.name}
              </option>
            ))}
        </optgroup>
      ))}
    </Select>
    </div>
  );

  return (
    <>
      <PageHeader title={t('nav.statistics')} description={t('stats.subtitle')} />
      {stations.isPending ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : !list.length ? (
        <Card>
          <EmptyState icon={<BarChart3 className="size-6" />} title={t('stats.noStations')} description={t('stats.noStationsText')} />
        </Card>
      ) : (
        <StatisticsView key={raw} scope={scope} mounts={station?.mounts ?? []} outputs={station?.outputs ?? []} showStation={!station} toolbar={selector} />
      )}
    </>
  );
}
