import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Download, ScrollText, Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type AuditEntry, type AuditPage, type Tenant } from '../lib/api';
import { formatDate } from '../lib/format';
import { Badge, Button, Dialog, EmptyState, Input, Select, Spinner, Table } from './ui';

export function useAuditLabels() {
  const { t } = useTranslation();
  const actions = t('audit.actions', { returnObjects: true }) as Record<string, string>;
  const groups = t('audit.groups', { returnObjects: true }) as Record<string, string>;
  return {
    action: (a: string) => actions[a] ?? a,
    group: (g: string) => groups[g] ?? g,
    via: (v: string) => t(`audit.via.${v}`, { defaultValue: v }),
  };
}

function Actor({ e }: { e: AuditEntry }) {
  const { t } = useTranslation();
  if (!e.actorEmail && !e.actorName) return <span className="text-muted">{e.via === 'system' ? t('audit.system') : t('audit.anonymous')}</span>;
  return (
    <div className="min-w-0">
      <div className="truncate font-semibold">{e.actorName ?? e.actorEmail}</div>
      {e.actorName && <div className="truncate text-xs text-muted">{e.actorEmail}</div>}
    </div>
  );
}

function DetailDialog({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  const { t } = useTranslation();
  const labels = useAuditLabels();
  if (!entry) return null;
  const rows: [string, React.ReactNode][] = [
    [t('audit.time'), formatDate(entry.at)],
    [t('audit.action'), `${labels.action(entry.action)} (${entry.action})`],
    [t('fields.status'), entry.success ? <Badge tone="online">OK</Badge> : <Badge tone="offline">{t('audit.failed')}</Badge>],
    [t('audit.actor'), <Actor e={entry} />],
    ['Via', labels.via(entry.via)],
    [t('audit.target'), entry.tenantName ?? '—'],
    ['Id', entry.targetId ? `${entry.targetType ?? ''} ${entry.targetId}` : '—'],
    [t('audit.ip'), entry.ip ?? '—'],
    [t('audit.userAgent'), entry.userAgent ?? '—'],
  ];
  return (
    <Dialog open onClose={onClose} title={labels.action(entry.action)} wide>
      <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2.5 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {entry.details && (
        <>
          <div className="mt-4 mb-1.5 text-[13px] font-semibold">{t('audit.details')}</div>
          <pre className="overflow-x-auto rounded-md bg-chip p-3 font-mono text-xs">{JSON.stringify(entry.details, null, 2)}</pre>
        </>
      )}
    </Dialog>
  );
}

/** Filterable audit log. With `tenantId` it shows one customer (for owners and managers). */
export function AuditLogView({ tenantId, compact }: { tenantId?: string; compact?: boolean }) {
  const { t } = useTranslation();
  const labels = useAuditLabels();
  const [tenant, setTenant] = useState(tenantId ?? '');
  const [action, setAction] = useState('');
  const [success, setSuccess] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<AuditEntry | null>(null);

  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants'), enabled: !tenantId });
  const filters = new URLSearchParams();
  if (tenant) filters.set('tenantId', tenant);
  if (action) filters.set('action', action);
  if (success) filters.set('success', success);
  if (q.trim()) filters.set('q', q.trim());
  if (from) filters.set('from', new Date(from).toISOString());
  if (to) filters.set('to', new Date(`${to}T23:59:59`).toISOString());
  const key = filters.toString();
  const actions = useQuery({
    queryKey: ['audit-actions', tenant],
    queryFn: () => api<string[]>(`/audit/actions${tenant ? `?tenantId=${tenant}` : ''}`),
  });

  const log = useInfiniteQuery({
    queryKey: ['audit', key],
    queryFn: ({ pageParam }) => api<AuditPage>(`/audit?${key}&limit=${compact ? 10 : 50}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  const groupsInUse = [...new Set((actions.data ?? []).map((a) => a.split('.')[0]!))];

  return (
    <div>
      <div className={clsx('flex flex-wrap items-end gap-2 border-b border-line px-5 py-3', compact && 'hidden sm:flex')}>
        {!tenantId && (
          <Select className="h-9 w-44 text-[13px]" value={tenant} onChange={(e) => setTenant(e.target.value)} aria-label={t('audit.target')}>
            <option value="">{t('audit.allCustomers')}</option>
            {(tenants.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        )}
        <Select className="h-9 w-48 text-[13px]" value={action} onChange={(e) => setAction(e.target.value)} aria-label={t('audit.action')}>
          <option value="">{t('audit.allActions')}</option>
          {groupsInUse.map((g) => (
            <optgroup key={g} label={labels.group(g)}>
              <option value={g}>
                {labels.group(g)} · {t('audit.all')}
              </option>
              {(actions.data ?? [])
                .filter((a) => a.startsWith(`${g}.`))
                .map((a) => (
                  <option key={a} value={a}>
                    {labels.action(a)}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
        <Select className="h-9 w-40 text-[13px]" value={success} onChange={(e) => setSuccess(e.target.value)} aria-label={t('fields.status')}>
          <option value="">{t('audit.allResults')}</option>
          <option value="false">{t('audit.onlyFailed')}</option>
          <option value="true">{t('audit.onlySucceeded')}</option>
        </Select>
        {!compact && (
          <>
            <Input type="date" className="h-9 w-40 text-[13px]" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t('audit.from')} title={t('audit.from')} />
            <Input type="date" className="h-9 w-40 text-[13px]" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('audit.to')} title={t('audit.to')} />
          </>
        )}
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input className="h-9 pl-9 text-[13px]" placeholder={t('audit.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <a href={`/api/audit/export.csv?${key}`} download>
          <Button size="sm" type="button">
            <Download className="size-4" /> {t('audit.export')}
          </Button>
        </a>
      </div>

      {log.isPending ? (
        <div className="grid place-items-center py-12">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<ScrollText className="size-6" />} title={t('audit.empty')} description={t('audit.emptyText')} />
      ) : (
        <Table head={[t('audit.time'), t('audit.action'), t('audit.actor'), ...(tenantId ? [] : [t('audit.target')]), t('audit.ip')]}>
          {items.map((e) => (
            <tr key={e.id} className="cursor-pointer hover:bg-hover/60" onClick={() => setOpen(e)}>
              <td className="text-[13px] whitespace-nowrap text-muted">{formatDate(e.at)}</td>
              <td>
                <div className="flex items-center gap-2">
                  <span className={clsx('size-2 shrink-0 rounded-full', e.success ? 'bg-online' : 'bg-offline')} />
                  <span className="font-semibold">{labels.action(e.action)}</span>
                  {e.via === 'api_key' || e.via === 'sso' ? <Badge>{labels.via(e.via)}</Badge> : null}
                </div>
              </td>
              <td className="max-w-56">
                <Actor e={e} />
              </td>
              {!tenantId && <td className="text-[13px]">{e.tenantName ?? <span className="text-muted">—</span>}</td>}
              <td className="font-mono text-xs whitespace-nowrap text-muted">{e.ip ?? '—'}</td>
            </tr>
          ))}
        </Table>
      )}
      {log.hasNextPage && (
        <div className="flex justify-center border-t border-line py-3">
          <Button size="sm" variant="ghost" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
            {t('audit.loadMore')}
          </Button>
        </div>
      )}
      <DetailDialog entry={open} onClose={() => setOpen(null)} />
    </div>
  );
}
