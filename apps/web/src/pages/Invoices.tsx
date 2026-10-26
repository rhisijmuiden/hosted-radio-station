import { useQuery } from '@tanstack/react-query';
import { FilePlus2, Receipt } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InvoicesTable, NewInvoiceDialog } from '../components/billing';
import { Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Tabs } from '../components/ui';
import { api, type InvoicePage, type Tenant } from '../lib/api';

const PAGE = 50;

export function InvoicesPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'all' | 'open' | 'overdue' | 'paid' | 'void'>('all');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [picking, setPicking] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants'), enabled: picking });
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(status !== 'all' ? { status } : {}), ...(q ? { q } : {}) });
  const invoices = useQuery({ queryKey: ['invoices', 'all', status, q, offset], queryFn: () => api<InvoicePage>(`/billing/invoices?${params}`) });
  const total = invoices.data?.total ?? 0;

  return (
    <>
      <PageHeader
        title={t('billing.invoices.title')}
        description={t('billing.invoices.subtitle')}
        actions={
          <Button variant="primary" onClick={() => setPicking(true)}>
            <FilePlus2 className="size-4" /> {t('billing.invoices.new')}
          </Button>
        }
      />
      <Tabs
        value={status}
        onChange={(v) => {
          setStatus(v);
          setOffset(0);
        }}
        tabs={(['all', 'open', 'overdue', 'paid', 'void'] as const).map((s) => ({ value: s, label: t(`billing.invoices.filter.${s}`) }))}
      />
      <Card>
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <Input
            className="h-8 max-w-xs text-[13px]"
            placeholder={t('billing.invoices.search')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
          <span className="ml-auto text-xs text-muted">{t('billing.invoices.count', { count: total })}</span>
        </div>
        {invoices.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : invoices.data?.items.length ? (
          <InvoicesTable invoices={invoices.data.items} admin showCustomer />
        ) : (
          <EmptyState icon={<Receipt className="size-5" />} title={t('billing.invoices.empty')} />
        )}
        {total > PAGE && (
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              {t('billing.invoices.newer')}
            </Button>
            <Button size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
              {t('billing.invoices.older')}
            </Button>
          </div>
        )}
      </Card>
      <Dialog
        open={picking}
        onClose={() => setPicking(false)}
        title={t('billing.invoices.new')}
        footer={
          <>
            <Button onClick={() => setPicking(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!tenantId}
              onClick={() => {
                setPicking(false);
                setCreatingFor(tenantId);
              }}
            >
              {t('billing.invoices.next')}
            </Button>
          </>
        }
      >
        <Field label={t('fields.customer')}>
          <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="">—</option>
            {tenants.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </Dialog>
      {creatingFor && <NewInvoiceDialog tenantId={creatingFor} open onClose={() => setCreatingFor(null)} />}
    </>
  );
}
