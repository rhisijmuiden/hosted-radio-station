import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { SubscriptionPanel, TenantInvoicesCard } from '../components/billing';
import { UsageCard } from '../components/DomainsCard';
import { Card, PageHeader, Select } from '../components/ui';
import { useMe } from '../lib/auth';

/** The customer's own subscription: package, usage, change package, billing details, invoices. */
export function SubscriptionPage() {
  const { t } = useTranslation();
  const me = useMe().data!;
  const [params, setParams] = useSearchParams();
  const mine = me.memberships.filter((m) => m.role !== 'dj');
  const current = mine.find((m) => m.tenantId === params.get('customer')) ?? mine[0];
  if (!current) return <Card className="p-8 text-center text-muted">{t('billing.sub.noAccess')}</Card>;
  const owner = current.role === 'owner';

  return (
    <>
      <PageHeader
        title={t('nav.subscription')}
        description={t('billing.sub.pageSubtitle')}
        actions={
          mine.length > 1 && (
            <Select className="w-56" value={current.tenantId} onChange={(e) => setParams({ customer: e.target.value })}>
              {mine.map((m) => (
                <option key={m.tenantId} value={m.tenantId}>
                  {m.tenantName}
                </option>
              ))}
            </Select>
          )
        }
      />
      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <SubscriptionPanel tenantId={current.tenantId} admin={false} canEdit={owner} />
        <div className="flex flex-col gap-4">
          <UsageCard tenantId={current.tenantId} />
          <TenantInvoicesCard tenantId={current.tenantId} admin={false} />
        </div>
      </div>
    </>
  );
}
