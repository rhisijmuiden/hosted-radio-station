import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Receipt } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { InvoicesTable, SubscriptionStatusBadge } from '../components/billing';
import { Button, Card, CardHeader, EmptyState, Input, PageHeader, Select, Spinner, Table } from '../components/ui';
import { api, type BillingOverview, type InvoicePage, type Subscription, type SubscriptionStatus } from '../lib/api';
import { formatDate, formatMoney } from '../lib/format';
import { PlanBadge, Stat } from './Dashboard';

const STATUSES: SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'suspended', 'cancelled'];

/** The hosted service at a glance: recurring revenue, subscriptions and invoices that need attention. */
export function BillingPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [status, setStatus] = useState<SubscriptionStatus | ''>('');
  const [q, setQ] = useState('');
  const overview = useQuery({ queryKey: ['billing', 'overview'], queryFn: () => api<BillingOverview>('/billing/overview'), refetchInterval: 60_000 });
  const subs = useQuery({
    queryKey: ['billing', 'subscriptions', status, q],
    queryFn: () => api<Subscription[]>(`/billing/subscriptions?${new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) })}`),
  });
  const attention = useQuery({ queryKey: ['invoices', 'overdue'], queryFn: () => api<InvoicePage>('/billing/invoices?status=overdue&limit=20') });
  const run = useMutation({
    mutationFn: () => api<{ renewed: number }>('/billing/run', { method: 'POST' }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['billing'] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      toast.success(t('billing.overview.ran', { count: r.renewed }));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const o = overview.data;

  return (
    <>
      <PageHeader
        title={t('billing.overview.title')}
        description={t('billing.overview.subtitle')}
        actions={
          <Button onClick={() => run.mutate()} loading={run.isPending} title={t('billing.overview.runHint')}>
            <Play className="size-4" /> {t('billing.overview.run')}
          </Button>
        }
      />
      {o && !o.enabled && (
        <Card className="mb-4 border-warning/40 p-4 text-[13px]">
          {t('billing.overview.disabled')}{' '}
          <Link to="/settings/billing" className="font-semibold text-accent-text underline">
            {t('billing.overview.openSettings')}
          </Link>
        </Card>
      )}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t('billing.overview.mrr')} value={o ? formatMoney(o.mrrCents) : '—'} note={o ? t('billing.overview.arr', { amount: formatMoney(o.arrCents) }) : undefined} tone="muted" />
        <Stat
          label={t('billing.overview.customers')}
          value={o ? o.subscriptions.active + o.subscriptions.past_due : '—'}
          note={o ? t('billing.overview.trials', { count: o.subscriptions.trialing }) : undefined}
        />
        <Stat
          label={t('billing.overview.open')}
          value={o ? formatMoney(o.openCents) : '—'}
          note={o ? (o.overdueCents > 0 ? t('billing.overview.overdue', { amount: formatMoney(o.overdueCents) }) : t('billing.overview.nothingOverdue')) : undefined}
          tone={o && o.overdueCents > 0 ? 'warning' : 'online'}
        />
        <Stat label={t('billing.overview.paid30')} value={o ? formatMoney(o.paidLast30Cents) : '—'} note={o ? t('billing.overview.suspended', { count: o.subscriptions.suspended }) : undefined} tone={o?.subscriptions.suspended ? 'warning' : 'muted'} />
      </div>

      {!!attention.data?.items.length && (
        <Card className="mb-4">
          <CardHeader title={t('billing.overview.attention')} description={t('billing.overview.attentionHint')} />
          <InvoicesTable invoices={attention.data.items} admin showCustomer />
        </Card>
      )}

      <Card>
        <CardHeader
          title={t('billing.overview.subscriptions')}
          actions={
            <>
              <Input className="h-8 w-44 text-[13px]" placeholder={t('billing.overview.search')} value={q} onChange={(e) => setQ(e.target.value)} />
              <Select className="h-8 w-40 text-[13px]" value={status} onChange={(e) => setStatus(e.target.value as SubscriptionStatus | '')}>
                <option value="">{t('billing.overview.allStatuses')}</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`billing.status.${s}`)}
                  </option>
                ))}
              </Select>
            </>
          }
        />
        {subs.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : subs.data?.length ? (
          <Table head={[t('fields.customer'), t('billing.package'), t('fields.status'), t('billing.price'), t('billing.periodEnds')]}>
            {subs.data.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/customers/${s.tenantId}`} className="font-semibold hover:text-accent-text">
                    {s.tenantName}
                  </Link>
                  <div className="text-xs text-muted">{s.billing.email || s.tenantSlug}</div>
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    {s.package.name} <PlanBadge plan={s.package.edition} />
                  </div>
                  {s.pendingPackage && <div className="text-xs text-muted">→ {s.pendingPackage.name}</div>}
                </td>
                <td>
                  <SubscriptionStatusBadge status={s.status} />
                  {s.cancelAtPeriodEnd && <div className="mt-1 text-xs text-warning">{t('billing.overview.cancels')}</div>}
                </td>
                <td className="whitespace-nowrap tabular-nums">
                  {formatMoney(s.priceCents, s.package.currency)} / {t(`billing.per.${s.interval}`)}
                </td>
                <td className="whitespace-nowrap text-muted">{formatDate(s.status === 'cancelled' ? s.cancelledAt : s.currentPeriodEnd, false)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState icon={<Receipt className="size-5" />} title={t('billing.overview.empty')} description={t('billing.overview.emptyHint')} />
        )}
      </Card>
    </>
  );
}
