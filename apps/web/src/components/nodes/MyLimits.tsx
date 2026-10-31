import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, type NodeItem, type StationListItem, type Tenant } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { allowedRoles, ROLES } from '../../pages/Nodes';
import { Card, CardHeader } from '../ui';

function Bar({ label, used, max, text }: { label: string; used: number; max: number; text?: string }) {
  const { t } = useTranslation();
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : used > 0 ? 100 : 0;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-semibold">{label}</span>
        <span className="text-muted tabular-nums">{text ?? t('myNodes.ofMax', { used, max })}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-hover">
        <div className={clsx('h-full rounded-full', pct >= 100 ? 'bg-warning' : 'bg-koraal')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * What a customer may use (customer navigation step 3): own nodes, stations and storage used against the limits of
 * the package, and which roles its own nodes may have. One block per customer the user manages.
 */
export function MyLimitsCard({ nodes }: { nodes: NodeItem[] }) {
  const { t } = useTranslation();
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants') });
  const stations = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations') });
  const list = tenants.data ?? [];
  if (!list.length) return null;
  return (
    <Card className="mb-4">
      <CardHeader title={t('myNodes.limitsTitle')} description={t('myNodes.limitsHint')} />
      <div className="flex flex-col divide-y divide-line">
        {list.map((tenant) => {
          const own = nodes.filter((n) => n.tenantId === tenant.id).length;
          const st = (stations.data ?? []).filter((s) => s.tenantId === tenant.id);
          const storage = st.reduce((sum, s) => sum + (s.storageBytes ?? 0), 0);
          const quota = tenant.limits.storageQuotaMb * 1024 * 1024;
          const allowed = allowedRoles(tenant.limits);
          return (
            <div key={tenant.id} className="flex flex-col gap-4 p-5">
              {list.length > 1 && <div className="text-sm font-bold">{tenant.name}</div>}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Bar label={t('myNodes.ownNodes')} used={own} max={tenant.limits.maxNodes} />
                <Bar label={t('myNodes.stations')} used={st.length} max={tenant.limits.maxStations} />
                <Bar label={t('myNodes.radioStations')} used={st.filter((s) => s.edition === 'station').length} max={tenant.limits.maxRadioStations} />
                <Bar label={t('myNodes.storage')} used={storage} max={quota} text={`${formatBytes(storage)} / ${formatBytes(quota)}`} />
              </div>
              <div>
                <div className="mb-2 text-[13px] font-semibold">{t('myNodes.rolesTitle')}</div>
                {tenant.limits.maxNodes === 0 ? (
                  <p className="text-[13px] text-muted">{t('myNodes.noOwnNodes')}</p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {ROLES.map((r) => {
                        const on = allowed.includes(r);
                        return (
                          <span
                            key={r}
                            title={on ? undefined : t('myNodes.notInPackage')}
                            className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-semibold', on ? 'border-koraal/40 bg-[var(--top-active-bg)] text-accent-text' : 'border-line text-muted')}
                          >
                            {on ? <Check className="size-3.5" /> : <Lock className="size-3.5" />}
                            {t(`nodes.roles.${r}`)}
                          </span>
                        );
                      })}
                    </div>
                    {allowed.length < ROLES.length && <p className="mt-2 text-xs text-muted">{t('myNodes.askMore')}</p>}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
