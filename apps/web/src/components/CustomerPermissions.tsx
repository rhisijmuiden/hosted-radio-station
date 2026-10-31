import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Info, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type NodeItem, type NodeRole, type StationListItem, type Tenant, type TenantLimits } from '../lib/api';
import { formatBytes } from '../lib/format';
import { allowedRoles, ROLES } from '../pages/Nodes';
import { Button, Card, CardHeader, Input, Switch } from './ui';

function Usage({ used, max, text }: { used: number; max: number; text: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : used > 0 ? 100 : 0;
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-muted tabular-nums">{text}</div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
        <div className={clsx('h-full rounded-full', pct >= 100 ? 'bg-warning' : 'bg-koraal')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function LimitRow({ label, hint, value, onChange, min = 0, max, usage }: { label: string; hint?: string; value: number; onChange: (v: number) => void; min?: number; max?: number; usage?: React.ReactNode }) {
  return (
    <div className="grid items-center gap-3 border-b border-line py-3 last:border-0 sm:grid-cols-[1fr_110px_150px]">
      <div>
        <div className="text-sm font-semibold">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      <Input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="text-right tabular-nums" />
      <div>{usage}</div>
    </div>
  );
}

/**
 * The Permissions tab of a customer (customer navigation step 4, administrators): the limits that count for the
 * licence (stations, of which Radio stations), own nodes and the roles they may have, resources, and what the
 * customer may change itself. The API enforces each of them.
 */
export function CustomerPermissions({ tenant }: { tenant: Tenant }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<TenantLimits>(tenant.limits);
  useEffect(() => setDraft(tenant.limits), [tenant.limits]);
  const stations = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations') });
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<NodeItem[]>('/nodes') });
  const mine = (stations.data ?? []).filter((s) => s.tenantId === tenant.id);
  const radio = mine.filter((s) => s.edition === 'station').length;
  const ownNodes = (nodes.data ?? []).filter((n) => n.tenantId === tenant.id);
  const storage = mine.reduce((sum, s) => sum + (s.storageBytes ?? 0), 0);
  const listeners = mine.reduce((sum, s) => sum + (s.listeners ?? 0), 0);
  const roles = allowedRoles(draft);
  const set = (patch: Partial<TenantLimits>) => setDraft((d) => ({ ...d, ...patch }));
  const ownOn = draft.maxNodes > 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(tenant.limits);

  const save = useMutation({
    // The node roles are always written out, so a customer from before gets exactly what is ticked here.
    mutationFn: () => api<Tenant>(`/tenants/${tenant.id}`, { method: 'PATCH', body: { limits: { ...draft, nodeRoles: roles } } }),
    onSuccess: (res) => {
      qc.setQueryData(['tenant', tenant.id], res);
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const toggleRole = (r: NodeRole) => set({ nodeRoles: roles.includes(r) ? roles.filter((x) => x !== r) : ROLES.filter((x) => x === r || roles.includes(x)) });
  // Roles on own nodes that are switched off here while a node still has them: they stay until changed on the node.
  const inUse = (r: NodeRole) => ownNodes.filter((n) => n.roles.includes(r)).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg border border-lucht/60 bg-lucht/15 px-4 py-3 text-[13px]">
          <Info className="mt-0.5 size-4 shrink-0 text-muted" />
          {t('permissions.tip')}
        </div>
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
          {t('permissions.save')}
        </Button>
      </div>
      {!tenant.limits.nodeRoles && <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">{t('permissions.legacyRoles')}</p>}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('permissions.stations')} description={t('permissions.stationsHint')} />
            <div className="px-5 pb-2">
              <LimitRow
                label={t('permissions.maxStations')}
                hint={t('permissions.maxStationsHint')}
                value={draft.maxStations}
                onChange={(v) => set({ maxStations: v, maxRadioStations: Math.min(draft.maxRadioStations, v) })}
                usage={<Usage used={mine.length} max={draft.maxStations} text={t('permissions.inUse', { used: mine.length, max: draft.maxStations })} />}
              />
              <LimitRow
                label={t('permissions.maxRadio')}
                hint={t('permissions.maxRadioHint')}
                value={draft.maxRadioStations}
                max={draft.maxStations}
                onChange={(v) => set({ maxRadioStations: Math.min(v, draft.maxStations) })}
                usage={<Usage used={radio} max={draft.maxRadioStations} text={t('permissions.inUse', { used: radio, max: draft.maxRadioStations })} />}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title={t('permissions.ownNodes')} description={t('permissions.ownNodesHint')} />
            <div className="flex flex-col gap-1 px-5 pb-3">
              <Switch checked={ownOn} onChange={(on) => set({ maxNodes: on ? Math.max(1, ownNodes.length) : 0 })} label={t('permissions.ownNodesOn')} description={t('permissions.ownNodesOnHint')} />
              {ownOn && (
                <LimitRow
                  label={t('permissions.maxNodes')}
                  hint={t('permissions.maxNodesHint')}
                  value={draft.maxNodes}
                  min={1}
                  onChange={(v) => set({ maxNodes: v })}
                  usage={<Usage used={ownNodes.length} max={draft.maxNodes} text={t('permissions.inUse', { used: ownNodes.length, max: draft.maxNodes })} />}
                />
              )}
              {!ownOn && ownNodes.length > 0 && <p className="text-xs text-warning">{t('permissions.nodesLeft', { count: ownNodes.length })}</p>}
            </div>
          </Card>
          <Card>
            <CardHeader title={t('permissions.resources')} />
            <div className="px-5 pb-2">
              <LimitRow
                label={t('permissions.storage')}
                hint="MB"
                value={draft.storageQuotaMb}
                onChange={(v) => set({ storageQuotaMb: v })}
                usage={<Usage used={storage} max={draft.storageQuotaMb * 1024 * 1024} text={t('permissions.usedOf', { used: formatBytes(storage) })} />}
              />
              <LimitRow
                label={t('permissions.listeners')}
                value={draft.maxListeners}
                onChange={(v) => set({ maxListeners: v })}
                usage={<Usage used={listeners} max={draft.maxListeners} text={t('permissions.listenersNow', { count: listeners })} />}
              />
              <LimitRow label={t('permissions.bitrate')} hint="kbps" value={draft.maxBitrateKbps} min={32} max={512} onChange={(v) => set({ maxBitrateKbps: v })} />
            </div>
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('permissions.roles')} description={t('permissions.rolesHint')} />
            <div className="flex flex-col divide-y divide-line px-5 pb-2">
              {(['station', 'relay', 'source', 'recorder', 'fm', 'monitor'] as NodeRole[]).map((r) => (
                <div key={r} className={clsx('flex items-center gap-3 py-3', !ownOn && 'opacity-50')}>
                  <span className="grid size-8 shrink-0 place-items-center rounded-md bg-chip text-accent-text">
                    <Server className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                      {t(`nodes.roles.${r}`)}
                      {r === 'station' && <span className="rounded-full bg-[var(--top-active-bg)] px-2 py-0.5 text-[11px] font-semibold text-accent-text">{t('permissions.default')}</span>}
                    </div>
                    <div className="text-xs text-muted">
                      {t(`permissions.roleHints.${r}`)}
                      {!roles.includes(r) && inUse(r) > 0 && <span className="text-warning"> · {t('permissions.roleInUse', { count: inUse(r) })}</span>}
                    </div>
                  </div>
                  <Switch checked={roles.includes(r)} disabled={!ownOn} onChange={() => toggleRole(r)} label={<span className="sr-only">{t(`nodes.roles.${r}`)}</span>} />
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title={t('permissions.may')} description={t('permissions.mayHint')} />
            <div className="flex flex-col gap-4 px-5 pb-5">
              <Switch checked={draft.mayRoute !== false} onChange={(v) => set({ mayRoute: v })} label={t('permissions.mayRoute')} description={t('permissions.mayRouteHint')} />
              <Switch checked={draft.mayCreateStations !== false} onChange={(v) => set({ mayCreateStations: v })} label={t('permissions.mayCreate')} description={t('permissions.mayCreateHint')} />
              <Switch checked={draft.maySwitchEdition !== false} onChange={(v) => set({ maySwitchEdition: v })} label={t('permissions.mayEdition')} description={t('permissions.mayEditionHint')} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
