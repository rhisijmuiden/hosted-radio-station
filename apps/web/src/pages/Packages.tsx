import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Package as PackageIcon, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PackageCard } from '../components/billing';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Spinner, Switch, Tabs } from '../components/ui';
import { api, ApiError, type BillingInterval, type Package, type PackageInput } from '../lib/api';
import { formatMoney } from '../lib/format';
import { LimitsFields, PlanPicker } from './Customers';

const blank = (): PackageInput => ({
  code: '',
  name: '',
  description: { en: '', nl: '' },
  features: [],
  edition: 'distribution',
  limits: { maxStations: 1, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 10240, maxNodes: 0 },
  currency: 'EUR',
  priceMonthCents: 0,
  priceYearCents: null,
  setupFeeCents: 0,
  trialDays: 14,
  public: true,
  active: true,
  sortOrder: 0,
});

const euros = (cents: number | null) => (cents == null ? '' : (cents / 100).toFixed(2).replace('.', ','));
const cents = (v: string) => (v.trim() === '' ? null : Math.round(Number(v.replace(',', '.')) * 100));

function PackageDialog({ pkg, open, onClose }: { pkg: Package | null; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<PackageInput>(blank);
  const [prices, setPrices] = useState({ month: '', year: '', setup: '' });
  const [lang, setLang] = useState<'en' | 'nl'>('nl');
  const [apply, setApply] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const base = pkg ? (({ id: _i, subscriberCount: _s, createdAt: _c, updatedAt: _u, ...rest }) => rest)(pkg) : blank();
    setForm(base);
    setPrices({ month: euros(base.priceMonthCents), year: euros(base.priceYearCents), setup: euros(base.setupFeeCents) });
    setApply(true);
    setError(null);
  }, [open, pkg]);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, priceMonthCents: cents(prices.month) ?? 0, priceYearCents: cents(prices.year), setupFeeCents: cents(prices.setup) ?? 0 };
      return pkg
        ? api<Package>(`/billing/packages/${pkg.id}`, { method: 'PATCH', body: { ...body, applyToSubscribers: apply } })
        : api<Package>('/billing/packages', { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['packages'] });
      toast.success(t('common.saved'));
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const set = <K extends keyof PackageInput>(k: K, v: PackageInput[K]) => setForm({ ...form, [k]: v });
  const monthly = cents(prices.month) ?? 0;
  const yearly = cents(prices.year);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={pkg ? t('billing.packages.edit', { name: pkg.name }) : t('billing.packages.new')}
      description={t('billing.packages.dialogHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="package-form" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="package-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fields.name')}>
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, code: pkg ? form.code : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') })} placeholder="Radio Basic" />
          </Field>
          <Field label={t('billing.packages.code')} hint={t('billing.packages.codeHint')}>
            <Input required className="font-mono" value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="radio-basic" />
          </Field>
        </div>
        <Field label={t('fields.plan')}>
          <PlanPicker value={form.edition} onChange={(edition) => set('edition', edition)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t('billing.packages.priceMonth')} hint={t('billing.exclVat')}>
            <Input required inputMode="decimal" value={prices.month} onChange={(e) => setPrices({ ...prices, month: e.target.value })} placeholder="19,95" />
          </Field>
          <Field label={t('billing.packages.priceYear')} hint={yearly == null ? t('billing.packages.priceYearHint', { amount: formatMoney(monthly * 12) }) : monthly > 0 ? t('billing.packages.saves', { pct: Math.round((1 - yearly / (monthly * 12)) * 100) }) : undefined}>
            <Input inputMode="decimal" value={prices.year} onChange={(e) => setPrices({ ...prices, year: e.target.value })} placeholder="199,50" />
          </Field>
          <Field label={t('billing.packages.setupFee')}>
            <Input inputMode="decimal" value={prices.setup} onChange={(e) => setPrices({ ...prices, setup: e.target.value })} placeholder="0,00" />
          </Field>
          <Field label={t('billing.trialDays')}>
            <Input type="number" min={0} max={365} value={form.trialDays} onChange={(e) => set('trialDays', Number(e.target.value))} />
          </Field>
        </div>
        <div>
          <div className="mb-2 text-[13px] font-semibold">{t('customers.limits')}</div>
          <LimitsFields value={form.limits} onChange={(limits) => set('limits', limits)} />
        </div>
        <div className="rounded-md border border-line p-3">
          <Tabs
            value={lang}
            onChange={setLang}
            tabs={[
              { value: 'nl', label: 'Nederlands' },
              { value: 'en', label: 'English' },
            ]}
          />
          <div className="flex flex-col gap-3">
            <Field label={t('billing.packages.description')} hint={t('billing.packages.descriptionHint')}>
              <Input value={form.description[lang]} onChange={(e) => set('description', { ...form.description, [lang]: e.target.value })} />
            </Field>
            <div className="text-[13px] font-semibold">{t('billing.packages.features')}</div>
            {form.features.map((f, i) => (
              <div key={i} className="flex gap-2">
                <Input value={f[lang]} onChange={(e) => set('features', form.features.map((x, j) => (j === i ? { ...x, [lang]: e.target.value } : x)))} />
                <Button variant="ghost" onClick={() => set('features', form.features.filter((_, j) => j !== i))} title={t('common.remove')}>
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            <div>
              <Button size="sm" onClick={() => set('features', [...form.features, { en: '', nl: '' }])}>
                <Plus className="size-4" /> {t('billing.packages.addFeature')}
              </Button>
            </div>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Switch checked={form.active} onChange={(v) => set('active', v)} label={t('billing.packages.active')} description={t('billing.packages.activeHint')} />
          <Switch checked={form.public} onChange={(v) => set('public', v)} label={t('billing.packages.public')} description={t('billing.packages.publicHint')} />
        </div>
        <Field label={t('billing.packages.sortOrder')} hint={t('billing.packages.sortOrderHint')} className="sm:w-40">
          <Input type="number" min={0} value={form.sortOrder} onChange={(e) => set('sortOrder', Number(e.target.value))} />
        </Field>
        {pkg && pkg.subscriberCount > 0 && (
          <Switch checked={apply} onChange={setApply} label={t('billing.packages.apply', { count: pkg.subscriberCount })} description={t('billing.packages.applyHint')} />
        )}
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

export function PackagesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => api<Package[]>('/billing/packages') });
  const [editing, setEditing] = useState<Package | null>(null);
  const [open, setOpen] = useState(false);
  const [interval, setInterval] = useState<BillingInterval>('month');
  const del = useMutation({
    mutationFn: (p: Package) => api(`/billing/packages/${p.id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['packages'] }),
    onError: (err) => toast.error((err as Error).message),
  });
  const edit = (p: Package | null) => {
    setEditing(p);
    setOpen(true);
  };

  return (
    <>
      <PageHeader
        title={t('billing.packages.title')}
        description={t('billing.packages.subtitle')}
        actions={
          <>
            <div className="flex rounded-full border border-line p-0.5 text-[13px]">
              {(['month', 'year'] as const).map((i) => (
                <button key={i} onClick={() => setInterval(i)} className={`h-7 rounded-full px-3 font-semibold ${interval === i ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'text-muted'}`}>
                  {t(`billing.intervals.${i}`)}
                </button>
              ))}
            </div>
            <Button variant="primary" onClick={() => edit(null)}>
              <Plus className="size-4" /> {t('billing.packages.new')}
            </Button>
          </>
        }
      />
      {packages.isPending ? (
        <div className="grid place-items-center py-20">
          <Spinner />
        </div>
      ) : packages.data?.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {packages.data.map((p) => (
            <PackageCard
              key={p.id}
              pkg={p}
              interval={interval}
              action={
                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <span className="font-mono text-xs text-muted">{p.code}</span>
                  {!p.active && <Badge tone="offline">{t('billing.packages.retired')}</Badge>}
                  {p.active && !p.public && <Badge>{t('billing.packages.hidden')}</Badge>}
                  {p.trialDays > 0 && <Badge tone="accent">{t('billing.packages.trial', { count: p.trialDays })}</Badge>}
                  <span className="text-xs text-muted">{t('billing.packages.subscribers', { count: p.subscriberCount })}</span>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => edit(p)} title={t('common.edit')}>
                    <Pencil className="size-4" />
                  </Button>
                  {p.subscriberCount === 0 && (
                    <Button size="sm" variant="ghost" title={t('common.delete')} onClick={() => confirm(t('billing.packages.deleteConfirm', { name: p.name })) && del.mutate(p)}>
                      <Trash2 className="size-4 text-offline" />
                    </Button>
                  )}
                </div>
              }
            />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<PackageIcon className="size-5" />}
            title={t('billing.packages.empty')}
            description={t('billing.packages.emptyHint')}
            action={
              <Button variant="primary" onClick={() => edit(null)}>
                <Plus className="size-4" /> {t('billing.packages.new')}
              </Button>
            }
          />
        </Card>
      )}
      <PackageDialog pkg={editing} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
