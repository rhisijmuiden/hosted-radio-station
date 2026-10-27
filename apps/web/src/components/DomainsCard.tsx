import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Globe, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError, type DomainCheck, type NodeItem, type TenantDomain, type TenantUsage } from '../lib/api';
import { formatBytes, formatRelative } from '../lib/format';
import { Badge, Button, Card, CardHeader, CopyField, Dialog, Field, Input, Select, Spinner, Switch } from './ui';
import { useServerNames } from '../lib/server';

function AddDomainDialog({ tenantId, open, onClose }: { tenantId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [domain, setDomain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api<TenantDomain>(`/tenants/${tenantId}/domains`, { method: 'POST', body: { domain } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['domains', tenantId] });
      setDomain('');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const d = domain.trim().toLowerCase() || 'example.com';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('domains.add')}
      description={t('domains.addHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="add-domain" loading={add.isPending}>
            {t('domains.add')}
          </Button>
        </>
      }
    >
      <form
        id="add-domain"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          add.mutate();
        }}
      >
        <Field label={t('domains.domain')} hint={t('domains.domainHint', { panel: `stream.${d}`, ingest: `src.${d}` })}>
          <Input required autoFocus value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="harder.fm" />
        </Field>
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

const statusTone = { verified: 'online', pending: 'warning', failed: 'offline' } as const;

/** What is wrong with a record, or what could be better, in words. */
function checkText(t: (k: string, o?: Record<string, unknown>) => string, c: DomainCheck | undefined, expected: string) {
  if (!c) return t('domains.notChecked');
  if (c.ok) return c.warning ? t(`domains.warnings.${c.warning}`, { target: expected }) : t('domains.recordOk');
  if (c.error === 'not_found') return t('domains.errors.not_found');
  if (c.error === 'proxied') return t('domains.errors.proxied');
  return t('domains.errors.wrong_target', { found: c.found.join(', '), target: expected });
}

/**
 * Cloudflare DNS (phase 15): the two CNAME records of a domain, each with its own target on the platform domain and a
 * tick, a warning or what is wrong.
 */
function TargetRecords({ domain: d }: { domain: TenantDomain }) {
  const { t } = useTranslation();
  const rows = [
    { host: d.panelHost, target: d.targets!.panel, label: t('domains.panelHost') },
    { host: d.ingestHost, target: d.targets!.ingest, label: t('domains.ingestHost') },
  ];
  return (
    <div className="overflow-hidden rounded-md border border-line">
      {rows.map(({ host, target, label }) => {
        const c = d.checks.find((x) => x.host === host);
        const tone = !c ? 'text-muted' : !c.ok ? 'text-offline' : c.warning ? 'text-warning' : 'text-online';
        const Icon = c?.ok ? (c.warning ? AlertTriangle : CheckCircle2) : XCircle;
        return (
          <div key={host} className="flex flex-col gap-1.5 border-t border-line px-3 py-2.5 first:border-t-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <Icon className={`size-4 shrink-0 ${tone}`} />
              <span className="truncate font-mono text-[13px] font-semibold">{host}</span>
              <span className="rounded bg-chip px-1.5 py-px font-mono text-[11px] text-muted">CNAME</span>
              <span className="text-[11px] text-muted">{label}</span>
            </div>
            <CopyField label={t('domains.recordValue')} value={target} />
            <div className={`text-[11px] ${c?.ok && !c.warning ? 'text-muted' : tone}`}>{checkText(t, c, target)}</div>
          </div>
        );
      })}
    </div>
  );
}

/** A customer's own domains: stream.<domain> for the panel, pages and streams, src.<domain> for encoders. */
export function DomainsCard({ tenantId, canEdit, admin }: { tenantId: string; canEdit: boolean; admin: boolean }) {
  const { t } = useTranslation();
  const server = useServerNames();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const domains = useQuery({ queryKey: ['domains', tenantId], queryFn: () => api<{ items: TenantDomain[]; target: { cname: string; ips: string[] } }>(`/tenants/${tenantId}/domains`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['domains', tenantId] });
  const verify = useMutation({
    mutationFn: (d: TenantDomain) => api<TenantDomain>(`/tenants/${tenantId}/domains/${d.id}/verify`, { method: 'POST' }),
    onSuccess: (d) => {
      refresh();
      if (d.status === 'verified') toast.success(t('domains.verifiedToast', { domain: d.domain }));
      else toast.error(t('domains.notYet'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const manual = useMutation({
    mutationFn: ({ d, value }: { d: TenantDomain; value: boolean }) => api(`/tenants/${tenantId}/domains/${d.id}`, { method: 'PATCH', body: { verifiedManually: value } }),
    onSuccess: refresh,
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (d: TenantDomain) => api(`/tenants/${tenantId}/domains/${d.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (err) => toast.error((err as Error).message),
  });
  const target = domains.data?.target;
  const nodes = useQuery({ queryKey: ['nodes', admin ? 'all' : tenantId], queryFn: () => api<NodeItem[]>(admin ? '/nodes' : `/nodes?tenantId=${tenantId}`) });
  const sourceNodes = (nodes.data ?? []).filter((n) => n.roles.includes('source') && (n.tenantId === tenantId || (admin && !n.tenantId)));
  const ingestNode = useMutation({
    mutationFn: ({ d, nodeId }: { d: TenantDomain; nodeId: string | null }) => api(`/tenants/${tenantId}/domains/${d.id}/ingest-node`, { method: 'PUT', body: { nodeId } }),
    onSuccess: () => {
      refresh();
      toast.success(t('domains.ingestNodeSaved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Card>
      <CardHeader
        title={t('domains.title')}
        description={t('domains.subtitle')}
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> {t('domains.add')}
            </Button>
          )
        }
      />
      {domains.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {!domains.data?.items.length && (
            <div className="flex flex-col items-center px-6 py-8 text-center">
              <Globe className="mb-2 size-6 text-muted" />
              <p className="max-w-sm text-[13px] text-muted">{t('domains.empty')}</p>
            </div>
          )}
          {domains.data?.items.map((d) => (
            <div key={d.id} className="flex flex-col gap-3 px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{d.domain}</span>
                  <Badge tone={statusTone[d.status]} dot>
                    {t(`domains.status.${d.status}`)}
                  </Badge>
                  {d.verifiedManually && <Badge>{t('domains.manual')}</Badge>}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="secondary" title={t('domains.check')} loading={verify.isPending && verify.variables?.id === d.id} onClick={() => verify.mutate(d)}>
                    <RefreshCw className="size-4" /> {t('domains.verify')}
                  </Button>
                  {canEdit && (
                    <Button size="sm" variant="ghost" title={t('common.delete')} onClick={() => confirm(t('domains.deleteConfirm', { domain: d.domain })) && remove.mutate(d)}>
                      <Trash2 className="size-4 text-offline" />
                    </Button>
                  )}
                </div>
              </div>
              {d.targets ? (
                <TargetRecords domain={d} />
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {[
                    { host: d.panelHost, label: t('domains.panelHost') },
                    { host: d.ingestHost, label: t('domains.ingestHost') },
                  ].map(({ host, label }) => {
                    const check = d.checks.find((c) => c.host === host);
                    return (
                      <div key={host} className="rounded-md border border-line px-3 py-2">
                        <div className="flex items-center gap-1.5 text-[11px] text-muted">
                          {check?.ok ? <CheckCircle2 className="size-3.5 text-online" /> : <XCircle className="size-3.5 text-offline" />}
                          {label}
                        </div>
                        <div className="truncate font-mono text-[13px]">{host}</div>
                        {check && !check.ok && (
                          <div className="mt-0.5 text-[11px] text-muted">
                            {check.found.length ? t('domains.pointsTo', { found: check.found.join(', ') }) : t('domains.noRecord')}
                            {check.error === 'no_target' && ` · ${t('domains.noTarget')}`}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {(!!sourceNodes.length || d.ingestNodeId) && (
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="text-muted">{t('domains.ingestVia')}</span>
                  <div className="w-full sm:w-64">
                    <Select
                      className="h-9"
                      value={d.ingestNodeId ?? ''}
                      disabled={!canEdit || ingestNode.isPending}
                      onChange={(e) => ingestNode.mutate({ d, nodeId: e.target.value || null })}
                    >
                      <option value="">{server?.ingest ?? t('domains.ingestMain')}</option>
                      {sourceNodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name}
                          {n.location ? ` (${n.location})` : ''}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {d.ingestNodeId && (() => {
                    const n = sourceNodes.find((x) => x.id === d.ingestNodeId);
                    const to = n?.config.publicHost || n?.config.dnsHost || n?.status.ip;
                    return to ? <span className="text-xs text-muted">{t('domains.ingestPointTo', { host: d.ingestHost, target: to })}</span> : null;
                  })()}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
                <span>{d.checkedAt ? t('domains.checked', { when: formatRelative(d.checkedAt) }) : ''}</span>
                {admin && (
                  <div className="w-full sm:w-auto">
                    <Switch
                      checked={d.verifiedManually}
                      disabled={manual.isPending}
                      onChange={(value) => manual.mutate({ d, value })}
                      label={<span className="text-xs">{t('domains.manualLabel')}</span>}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
          {target && !domains.data?.items.some((d) => d.targets) && (
            <div className="flex flex-col gap-2 bg-chip/40 px-5 py-4">
              <div className="text-[13px] font-semibold">{t('domains.dnsTitle')}</div>
              <p className="text-xs text-muted">{t('domains.dnsHint')}</p>
              {target.cname && <CopyField label={t('domains.cnameTarget')} value={target.cname} />}
              {!!target.ips.length && <CopyField label={t('domains.orIps')} value={target.ips.join(', ')} />}
              {!target.cname && !target.ips.length && <p className="text-xs text-warning">{admin ? t('domains.noTargetAdmin') : t('domains.noTarget')}</p>}
            </div>
          )}
        </div>
      )}
      <AddDomainDialog tenantId={tenantId} open={adding} onClose={() => setAdding(false)} />
    </Card>
  );
}

function Meter({ label, used, limit, format = String }: { label: string; used: number; limit: number; format?: (n: number) => string }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const tone = pct >= 100 ? 'bg-offline' : pct >= 85 ? 'bg-warning' : 'bg-koraal';
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-semibold">{label}</span>
        <span className="tabular-nums text-muted">
          {format(used)} / {format(limit)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-chip">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** How much of its limits a customer uses: stations, listeners handed out to stations, storage. */
export function UsageCard({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const usage = useQuery({ queryKey: ['usage', tenantId], queryFn: () => api<TenantUsage>(`/tenants/${tenantId}/usage`), refetchInterval: 30_000 });
  const u = usage.data;
  return (
    <Card>
      <CardHeader title={t('usage.title')} description={t('usage.subtitle')} />
      {!u ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-5">
          <Meter label={t('limits.maxStations')} used={u.stations.used} limit={u.stations.limit} />
          <Meter label={t('usage.listenersAllocated')} used={u.listeners.allocated} limit={u.listeners.limit} />
          <Meter label={t('usage.storage')} used={u.storage.usedBytes} limit={u.storage.limitBytes} format={formatBytes} />
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
            <span>{t('usage.listenersNow', { count: u.listeners.now })}</span>
            <span>{t('usage.bitrate', { kbps: u.bitrate.limit })}</span>
          </div>
        </div>
      )}
    </Card>
  );
}
