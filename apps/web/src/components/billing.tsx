import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Ban, Check, CreditCard, FileDown, FilePlus2, Mail, Pause, Play, Plus, Receipt, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  api,
  ApiError,
  type BillingContact,
  type BillingInterval,
  type Invoice,
  type InvoicePage,
  type Package,
  type Subscription,
  type SubscriptionInfo,
  type SubscriptionStatus,
} from '../lib/api';
import { formatBytes, formatDate, formatMoney } from '../lib/format';
import { PlanBadge } from '../pages/Dashboard';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Fact, Field, Input, Segmented, Select, Spinner, Switch, Table, Textarea } from './ui';

export const emptyContact = (): BillingContact => ({ company: '', name: '', email: '', address: '', postcode: '', city: '', country: '', vatNumber: '', reference: '' });

const statusTone: Record<SubscriptionStatus, 'online' | 'warning' | 'offline' | 'neutral' | 'accent'> = {
  trialing: 'accent',
  active: 'online',
  past_due: 'warning',
  suspended: 'offline',
  cancelled: 'neutral',
};

export function SubscriptionStatusBadge({ status }: { status: SubscriptionStatus }) {
  const { t } = useTranslation();
  return (
    <Badge tone={statusTone[status]} dot>
      {t(`billing.status.${status}`)}
    </Badge>
  );
}

export function InvoiceStatusBadge({ invoice }: { invoice: Pick<Invoice, 'status' | 'overdue'> }) {
  const { t } = useTranslation();
  if (invoice.status === 'paid') return <Badge tone="online">{t('billing.invoiceStatus.paid')}</Badge>;
  if (invoice.status === 'void') return <Badge>{t('billing.invoiceStatus.void')}</Badge>;
  return <Badge tone={invoice.overdue ? 'offline' : 'warning'}>{t(invoice.overdue ? 'billing.invoiceStatus.overdue' : 'billing.invoiceStatus.open')}</Badge>;
}

/** Price of a package for one interval, e.g. "€ 25,00 / month". */
export function packagePrice(p: Package, interval: BillingInterval) {
  return interval === 'year' ? (p.priceYearCents ?? p.priceMonthCents * 12) : p.priceMonthCents;
}

export function ContactFields({ value, onChange, disabled }: { value: BillingContact; onChange: (v: BillingContact) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const set = (k: keyof BillingContact) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('billing.contact.company')}>
        <Input disabled={disabled} value={value.company} onChange={set('company')} />
      </Field>
      <Field label={t('billing.contact.name')}>
        <Input disabled={disabled} value={value.name} onChange={set('name')} />
      </Field>
      <Field label={t('billing.contact.email')} hint={t('billing.contact.emailHint')} className="sm:col-span-2">
        <Input disabled={disabled} type="email" value={value.email} onChange={set('email')} />
      </Field>
      <Field label={t('billing.contact.address')} className="sm:col-span-2">
        <Input disabled={disabled} value={value.address} onChange={set('address')} />
      </Field>
      <Field label={t('billing.contact.postcode')}>
        <Input disabled={disabled} value={value.postcode} onChange={set('postcode')} />
      </Field>
      <Field label={t('billing.contact.city')}>
        <Input disabled={disabled} value={value.city} onChange={set('city')} />
      </Field>
      <Field label={t('billing.contact.country')} hint={t('billing.contact.countryHint')}>
        <Input disabled={disabled} maxLength={2} value={value.country} onChange={(e) => onChange({ ...value, country: e.target.value.toUpperCase() })} placeholder="NL" />
      </Field>
      <Field label={t('billing.contact.vatNumber')} hint={t('billing.contact.vatNumberHint')}>
        <Input disabled={disabled} value={value.vatNumber} onChange={set('vatNumber')} />
      </Field>
      <Field label={t('billing.contact.reference')} hint={t('billing.contact.referenceHint')} className="sm:col-span-2">
        <Input disabled={disabled} value={value.reference} onChange={set('reference')} />
      </Field>
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p> : null;
}

const errText = (err: unknown) => (err instanceof ApiError ? err.message : String(err));

// Invoices

function MarkPaidDialog({ invoice, onClose }: { invoice: Invoice | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({ method: 'bank_transfer', reference: '', paidAt: '' });
  useEffect(() => setForm({ method: 'bank_transfer', reference: '', paidAt: new Date().toISOString().slice(0, 10) }), [invoice]);
  const save = useMutation({
    mutationFn: () => api<Invoice>(`/billing/invoices/${invoice!.id}/paid`, { method: 'POST', body: { method: form.method, reference: form.reference || null, paidAt: form.paidAt || undefined } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['subscription'] });
      void qc.invalidateQueries({ queryKey: ['billing'] });
      toast.success(t('billing.invoices.markedPaid'));
      onClose();
    },
    onError: (err) => toast.error(errText(err)),
  });
  return (
    <Dialog
      open={!!invoice}
      onClose={onClose}
      title={t('billing.invoices.markPaidTitle', { number: invoice?.number })}
      description={invoice ? formatMoney(invoice.totalCents, invoice.currency) : undefined}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            <Check className="size-4" /> {t('billing.invoices.markPaid')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('billing.invoices.method')}>
          <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {['bank_transfer', 'cash', 'other'].map((m) => (
              <option key={m} value={m}>
                {t(`billing.methods.${m}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('billing.invoices.paidAt')}>
          <Input type="date" value={form.paidAt} onChange={(e) => setForm({ ...form, paidAt: e.target.value })} />
        </Field>
        <Field label={t('billing.invoices.paymentRef')} hint={t('billing.invoices.paymentRefHint')}>
          <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

export function NewInvoiceDialog({ tenantId, open, onClose }: { tenantId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const blank = { description: '', quantity: '1', price: '' };
  const [lines, setLines] = useState([blank]);
  const [notes, setNotes] = useState('');
  const [send, setSend] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setLines([blank]);
      setNotes('');
      setSend(true);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const toCents = (v: string) => Math.round(Number(v.replace(',', '.')) * 100);
  const total = lines.reduce((n, l) => n + (Number(l.quantity) || 0) * (toCents(l.price) || 0), 0);
  const create = useMutation({
    mutationFn: () =>
      api<Invoice>('/billing/invoices', {
        method: 'POST',
        body: { tenantId, notes, send, lines: lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitCents: toCents(l.price) })) },
      }),
    onSuccess: (inv) => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      toast.success(t('billing.invoices.created', { number: inv.number }));
      onClose();
    },
    onError: (err) => setError(errText(err)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={t('billing.invoices.new')}
      description={t('billing.invoices.newHint')}
      footer={
        <>
          <span className="mr-auto self-center text-sm text-muted">
            {t('billing.invoices.exclVat')}: <b className="text-ink">{formatMoney(total)}</b>
          </span>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()} disabled={lines.some((l) => !l.description || !l.price)}>
            <FilePlus2 className="size-4" /> {t('billing.invoices.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_70px_110px_auto] items-end gap-2">
            <Field label={i === 0 ? t('billing.invoices.description') : ''}>
              <Input value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            </Field>
            <Field label={i === 0 ? t('billing.invoices.qty') : ''}>
              <Input type="number" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
            </Field>
            <Field label={i === 0 ? t('billing.invoices.unitPrice') : ''}>
              <Input inputMode="decimal" placeholder="0,00" value={l.price} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
            </Field>
            <Button variant="ghost" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} title={t('common.remove')}>
              <X className="size-4" />
            </Button>
          </div>
        ))}
        <div>
          <Button size="sm" onClick={() => setLines([...lines, blank])}>
            <Plus className="size-4" /> {t('billing.invoices.addLine')}
          </Button>
        </div>
        <p className="text-xs text-muted">{t('billing.invoices.creditHint')}</p>
        <Field label={t('billing.invoices.notes')}>
          <Textarea className="font-sans text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Switch checked={send} onChange={setSend} label={t('billing.invoices.sendNow')} description={t('billing.invoices.sendNowHint')} />
        <ErrorLine error={error} />
      </div>
    </Dialog>
  );
}

export function InvoicesTable({ invoices, admin, showCustomer }: { invoices: Invoice[]; admin: boolean; showCustomer?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [paying, setPaying] = useState<Invoice | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['invoices'] });
    void qc.invalidateQueries({ queryKey: ['subscription'] });
    void qc.invalidateQueries({ queryKey: ['billing'] });
  };
  const send = useMutation({
    mutationFn: (inv: Invoice) => api(`/billing/invoices/${inv.id}/send`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('billing.invoices.sent'));
      refresh();
    },
    onError: (err) => toast.error(errText(err)),
  });
  const voidIt = useMutation({
    mutationFn: (inv: Invoice) => api(`/billing/invoices/${inv.id}/void`, { method: 'POST' }),
    onSuccess: refresh,
    onError: (err) => toast.error(errText(err)),
  });
  const pay = useMutation({
    mutationFn: (inv: Invoice) => api<{ checkoutUrl: string }>(`/billing/invoices/${inv.id}/pay`, { method: 'POST' }),
    onSuccess: (r) => window.location.assign(r.checkoutUrl),
    onError: (err) => toast.error(errText(err)),
  });
  return (
    <>
      <Table
        head={[
          t('billing.invoices.number'),
          ...(showCustomer ? [t('fields.customer')] : []),
          t('billing.invoices.date'),
          t('billing.invoices.due'),
          t('billing.invoices.amount'),
          t('fields.status'),
          '',
        ]}
      >
        {invoices.map((inv) => (
          <tr key={inv.id}>
            <td className="font-mono text-[13px] font-semibold whitespace-nowrap">{inv.number}</td>
            {showCustomer && <td className="max-w-48 truncate">{inv.tenantName}</td>}
            <td className="whitespace-nowrap text-muted">{formatDate(inv.issuedAt, false)}</td>
            <td className={clsx('whitespace-nowrap', inv.overdue ? 'font-semibold text-offline' : 'text-muted')}>{formatDate(inv.dueAt, false)}</td>
            <td className="text-right font-semibold whitespace-nowrap tabular-nums">{formatMoney(inv.totalCents, inv.currency)}</td>
            <td>
              <InvoiceStatusBadge invoice={inv} />
            </td>
            <td className="text-right whitespace-nowrap">
              {inv.payable && !admin && (
                <Button size="sm" variant="primary" loading={pay.isPending && pay.variables?.id === inv.id} onClick={() => pay.mutate(inv)}>
                  <CreditCard className="size-4" /> {t('billing.invoices.pay')}
                </Button>
              )}
              <a href={`/api/billing/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer" title={t('billing.invoices.pdf')} className="inline-grid size-8 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink">
                <FileDown className="size-4" />
              </a>
              {admin && inv.status === 'open' && (
                <>
                  <Button size="sm" variant="ghost" title={t('billing.invoices.markPaid')} onClick={() => setPaying(inv)}>
                    <Check className="size-4 text-online" />
                  </Button>
                  <Button size="sm" variant="ghost" title={t('billing.invoices.send')} loading={send.isPending && send.variables?.id === inv.id} onClick={() => send.mutate(inv)}>
                    <Mail className="size-4 text-muted" />
                  </Button>
                  <Button size="sm" variant="ghost" title={t('billing.invoices.void')} onClick={() => confirm(t('billing.invoices.voidConfirm', { number: inv.number })) && voidIt.mutate(inv)}>
                    <Ban className="size-4 text-offline" />
                  </Button>
                </>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <MarkPaidDialog invoice={paying} onClose={() => setPaying(null)} />
    </>
  );
}

export function TenantInvoicesCard({ tenantId, admin }: { tenantId: string; admin: boolean }) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const invoices = useQuery({ queryKey: ['invoices', tenantId], queryFn: () => api<InvoicePage>(`/billing/invoices?tenantId=${tenantId}&limit=50`) });
  return (
    <Card>
      <CardHeader
        title={t('billing.invoices.title')}
        description={admin ? t('billing.invoices.customerSubtitle') : t('billing.invoices.mySubtitle')}
        actions={
          admin && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <FilePlus2 className="size-4" /> {t('billing.invoices.new')}
            </Button>
          )
        }
      />
      {invoices.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : invoices.data?.items.length ? (
        <InvoicesTable invoices={invoices.data.items} admin={admin} />
      ) : (
        <EmptyState icon={<Receipt className="size-5" />} title={t('billing.invoices.empty')} />
      )}
      {admin && <NewInvoiceDialog tenantId={tenantId} open={creating} onClose={() => setCreating(false)} />}
    </Card>
  );
}

// Packages to choose from

export function PackageCard({
  pkg,
  interval,
  current,
  action,
}: {
  pkg: Package;
  interval: BillingInterval;
  current?: boolean;
  action?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('nl') ? 'nl' : 'en';
  const price = packagePrice(pkg, interval);
  return (
    <div className={clsx('flex flex-col rounded-lg border p-4', current ? 'border-koraal ring-1 ring-koraal' : 'border-line')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="display text-base">{pkg.name}</div>
          <div className="mt-1">
            <PlanBadge plan={pkg.edition} />
          </div>
        </div>
        {current && <Badge tone="accent">{t('billing.current')}</Badge>}
      </div>
      <div className="mt-3">
        <span className="display text-2xl">{formatMoney(price, pkg.currency)}</span>
        <span className="text-[13px] text-muted"> / {t(`billing.per.${interval}`)}</span>
        <div className="text-[11px] text-muted">{t('billing.exclVat')}</div>
      </div>
      {pkg.description[lang] && <p className="mt-2 text-[13px] text-muted">{pkg.description[lang]}</p>}
      <ul className="mt-3 flex flex-col gap-1 text-[13px]">
        <li>{t('billing.limitStations', { count: pkg.limits.maxStations })}</li>
        <li>{t('billing.limitListeners', { count: pkg.limits.maxListeners })}</li>
        <li>{t('billing.limitBitrate', { n: pkg.limits.maxBitrateKbps })}</li>
        <li>{t('billing.limitStorage', { size: formatBytes(pkg.limits.storageQuotaMb * 1024 * 1024) })}</li>
        {pkg.limits.maxNodes > 0 && <li>{t('billing.limitNodes', { count: pkg.limits.maxNodes })}</li>}
        {pkg.features.map((f, i) => (
          <li key={i} className="flex gap-1.5">
            <Check className="mt-0.5 size-3.5 shrink-0 text-online" /> {f[lang] || f.en}
          </li>
        ))}
      </ul>
      {action && <div className="mt-auto pt-4">{action}</div>}
    </div>
  );
}

// The subscription of one customer: the customer's own page and the card on the customer page for administrators

function StartSubscriptionDialog({ tenantId, open, onClose }: { tenantId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => api<Package[]>('/billing/packages'), enabled: open });
  const [form, setForm] = useState({ packageId: '', interval: 'month' as BillingInterval, trialDays: '', price: '', discountPercent: 0, locale: 'nl', billing: emptyContact() });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  useEffect(() => {
    const first = packages.data?.find((p) => p.active);
    if (first && !form.packageId) setForm((f) => ({ ...f, packageId: first.id, trialDays: String(first.trialDays) }));
  }, [packages.data, form.packageId]);
  const create = useMutation({
    mutationFn: () =>
      api<Subscription>(`/tenants/${tenantId}/subscription`, {
        method: 'POST',
        body: {
          packageId: form.packageId,
          interval: form.interval,
          trialDays: form.trialDays === '' ? undefined : Number(form.trialDays),
          customPriceCents: form.price ? Math.round(Number(form.price.replace(',', '.')) * 100) : null,
          discountPercent: form.discountPercent,
          locale: form.locale,
          billing: form.billing,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['subscription', tenantId] });
      void qc.invalidateQueries({ queryKey: ['tenant', tenantId] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      toast.success(t('billing.sub.started'));
      onClose();
    },
    onError: (err) => setError(errText(err)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={t('billing.sub.start')}
      description={t('billing.sub.startHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={create.isPending} disabled={!form.packageId} onClick={() => create.mutate()}>
            {t('billing.sub.startButton')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('billing.package')}>
            <Select
              value={form.packageId}
              onChange={(e) => setForm({ ...form, packageId: e.target.value, trialDays: String(packages.data?.find((p) => p.id === e.target.value)?.trialDays ?? 0) })}
            >
              {packages.data
                ?.filter((p) => p.active)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatMoney(p.priceMonthCents, p.currency)} / {t('billing.per.month')}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('billing.interval')}>
            <Select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value as BillingInterval })}>
              <option value="month">{t('billing.intervals.month')}</option>
              <option value="year">{t('billing.intervals.year')}</option>
            </Select>
          </Field>
          <Field label={t('billing.trialDays')} hint={t('billing.trialDaysHint')}>
            <Input type="number" min={0} max={365} value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} />
          </Field>
          <Field label={t('billing.language')} hint={t('billing.languageHint')}>
            <Select value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}>
              <option value="nl">Nederlands</option>
              <option value="en">English</option>
            </Select>
          </Field>
          <Field label={t('billing.customPrice')} hint={t('billing.customPriceHint')}>
            <Input inputMode="decimal" placeholder={t('billing.packagePrice')} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          <Field label={t('billing.discount')}>
            <Input type="number" min={0} max={100} value={form.discountPercent} onChange={(e) => setForm({ ...form, discountPercent: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="text-[13px] font-semibold">{t('billing.contact.title')}</div>
        <ContactFields value={form.billing} onChange={(billing) => setForm({ ...form, billing })} />
        <p className="text-xs text-muted">{t('billing.sub.startNote')}</p>
        <ErrorLine error={error} />
      </div>
    </Dialog>
  );
}

function ChangePackageDialog({ sub, admin, open, onClose, initial }: { sub: Subscription; admin: boolean; open: boolean; onClose: () => void; initial?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => api<Package[]>('/billing/packages'), enabled: open });
  const [packageId, setPackageId] = useState(initial ?? sub.package.id);
  const [interval, setInterval] = useState<BillingInterval>(sub.pendingInterval ?? sub.interval);
  const [when, setWhen] = useState<'auto' | 'now' | 'period_end'>('auto');
  const [prorate, setProrate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPackageId(initial ?? sub.package.id);
      setInterval(sub.pendingInterval ?? sub.interval);
      setWhen('auto');
      setProrate(true);
      setError(null);
    }
  }, [open, initial, sub]);
  const list = (packages.data ?? []).filter((p) => (admin ? p.active || p.id === sub.package.id : true));
  const target = list.find((p) => p.id === packageId);
  const current = list.find((p) => p.id === sub.package.id);
  const monthly = (p: Package, i: BillingInterval) => (i === 'year' ? packagePrice(p, 'year') / 12 : p.priceMonthCents);
  const upgrade = target && current ? monthly(target, interval) > monthly(current, sub.interval) || sub.status === 'trialing' : false;
  const change = useMutation({
    mutationFn: () =>
      api<{ applied: 'now' | 'period_end'; invoice: Invoice | null }>(`/tenants/${sub.tenantId}/subscription/change`, {
        method: 'POST',
        body: { packageId, interval, ...(admin ? { when, prorate } : {}) },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['subscription', sub.tenantId] });
      void qc.invalidateQueries({ queryKey: ['tenant', sub.tenantId] });
      void qc.invalidateQueries({ queryKey: ['usage', sub.tenantId] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast.success(r.applied === 'now' ? t('billing.change.doneNow') : t('billing.change.doneLater', { date: formatDate(sub.currentPeriodEnd, false) }));
      onClose();
    },
    onError: (err) => setError(errText(err)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={t('billing.change.title')}
      description={t('billing.change.hint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={change.isPending} disabled={!target || (target.id === sub.package.id && interval === sub.interval && !sub.pendingPackage)} onClick={() => change.mutate()}>
            {t('billing.change.confirm')}
          </Button>
        </>
      }
    >
      {packages.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Segmented
            value={interval}
            onChange={setInterval}
            options={[
              { value: 'month', label: t('billing.intervals.month') },
              { value: 'year', label: t('billing.intervals.year'), description: t('billing.yearHint') },
            ]}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            {list.map((p) => (
              <button key={p.id} type="button" className="text-left" onClick={() => setPackageId(p.id)}>
                <PackageCard pkg={p} interval={interval} current={p.id === packageId} />
              </button>
            ))}
          </div>
          {target && target.id !== sub.package.id && (
            <p className="rounded-md bg-chip px-3 py-2 text-[13px]">
              {admin && when !== 'auto'
                ? when === 'now'
                  ? t('billing.change.explainNow')
                  : t('billing.change.explainLater', { date: formatDate(sub.currentPeriodEnd, false) })
                : upgrade
                  ? sub.status === 'trialing'
                    ? t('billing.change.explainTrial')
                    : t('billing.change.explainUpgrade')
                  : t('billing.change.explainDowngrade', { date: formatDate(sub.currentPeriodEnd, false) })}
            </p>
          )}
          {admin && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('billing.change.when')}>
                <Select value={when} onChange={(e) => setWhen(e.target.value as typeof when)}>
                  <option value="auto">{t('billing.change.whenAuto')}</option>
                  <option value="now">{t('billing.change.whenNow')}</option>
                  <option value="period_end">{t('billing.change.whenLater')}</option>
                </Select>
              </Field>
              <div className="pt-6">
                <Switch checked={prorate} onChange={setProrate} label={t('billing.change.prorate')} description={t('billing.change.prorateHint')} />
              </div>
            </div>
          )}
          <ErrorLine error={error} />
        </div>
      )}
    </Dialog>
  );
}

function EditSubscriptionDialog({ sub, open, onClose }: { sub: Subscription; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toForm = () => ({
    price: sub.customPriceCents != null ? (sub.customPriceCents / 100).toFixed(2) : '',
    discountPercent: sub.discountPercent,
    customLimits: sub.customLimits,
    end: sub.currentPeriodEnd.slice(0, 10),
    notes: sub.notes,
    locale: sub.locale,
  });
  const [form, setForm] = useState(toForm);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm(toForm());
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sub]);
  const save = useMutation({
    mutationFn: () => {
      const end = new Date(`${form.end}T${sub.currentPeriodEnd.slice(11)}`).toISOString();
      const changedEnd = end !== new Date(sub.currentPeriodEnd).toISOString();
      return api<Subscription>(`/tenants/${sub.tenantId}/subscription`, {
        method: 'PATCH',
        body: {
          customPriceCents: form.price ? Math.round(Number(form.price.replace(',', '.')) * 100) : null,
          discountPercent: form.discountPercent,
          customLimits: form.customLimits,
          notes: form.notes,
          locale: form.locale,
          ...(changedEnd ? (sub.status === 'trialing' ? { trialEndsAt: end } : { currentPeriodEnd: end }) : {}),
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['subscription', sub.tenantId] });
      void qc.invalidateQueries({ queryKey: ['tenant', sub.tenantId] });
      toast.success(t('common.saved'));
      onClose();
    },
    onError: (err) => setError(errText(err)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('billing.sub.edit')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('billing.customPrice')} hint={t('billing.customPriceHint')}>
            <Input inputMode="decimal" placeholder={t('billing.packagePrice')} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          <Field label={t('billing.discount')}>
            <Input type="number" min={0} max={100} value={form.discountPercent} onChange={(e) => setForm({ ...form, discountPercent: Number(e.target.value) })} />
          </Field>
          <Field label={sub.status === 'trialing' ? t('billing.trialEnds') : t('billing.periodEnds')} hint={t('billing.periodEndsHint')}>
            <Input type="date" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
          </Field>
          <Field label={t('billing.language')}>
            <Select value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}>
              <option value="nl">Nederlands</option>
              <option value="en">English</option>
            </Select>
          </Field>
        </div>
        <Switch checked={form.customLimits} onChange={(customLimits) => setForm({ ...form, customLimits })} label={t('billing.customLimits')} description={t('billing.customLimitsHint')} />
        <Field label={t('billing.notes')} hint={t('billing.notesHint')}>
          <Textarea className="font-sans text-sm" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        <ErrorLine error={error} />
      </div>
    </Dialog>
  );
}

function BillingDetailsCard({ sub, canEdit }: { sub: Subscription; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(sub.billing);
  useEffect(() => setDraft(sub.billing), [sub.billing]);
  const save = useMutation({
    mutationFn: () => api<Subscription>(`/tenants/${sub.tenantId}/subscription`, { method: 'PATCH', body: { billing: draft } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['subscription', sub.tenantId] });
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error(errText(err)),
  });
  return (
    <Card>
      <CardHeader title={t('billing.contact.title')} description={t('billing.contact.hint')} />
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <ContactFields value={draft} onChange={setDraft} disabled={!canEdit} />
        {canEdit && (
          <div className="flex justify-end">
            <Button type="submit" variant="dark" loading={save.isPending}>
              {t('common.save')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

/**
 * Everything about a customer's subscription. Customers (owners) see their package, the next invoice, can change
 * package, edit billing details and cancel; administrators also start, suspend, end and price subscriptions.
 */
export function SubscriptionPanel({ tenantId, admin, canEdit, compact }: { tenantId: string; admin: boolean; canEdit: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['subscription', tenantId], queryFn: () => api<SubscriptionInfo>(`/tenants/${tenantId}/subscription`) });
  const [starting, setStarting] = useState(false);
  const [changing, setChanging] = useState(false);
  const [editing, setEditing] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['subscription', tenantId] });
    void qc.invalidateQueries({ queryKey: ['tenant', tenantId] });
    void qc.invalidateQueries({ queryKey: ['invoices'] });
    void qc.invalidateQueries({ queryKey: ['billing'] });
  };
  const action = useMutation({
    mutationFn: ({ path, body, method }: { path: string; body?: unknown; method?: string }) => api(`/tenants/${tenantId}/subscription${path}`, { method: method ?? 'POST', body }),
    onSuccess: () => {
      refresh();
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error(errText(err)),
  });

  if (info.isPending) {
    return (
      <Card className="grid place-items-center py-10">
        <Spinner />
      </Card>
    );
  }
  const data = info.data;
  const sub = data?.subscription;
  if (!sub) {
    return (
      <Card>
        <CardHeader title={t('billing.sub.title')} />
        <EmptyState
          icon={<Receipt className="size-5" />}
          title={t('billing.sub.none')}
          description={admin ? t('billing.sub.noneAdmin') : t('billing.sub.noneCustomer')}
          action={
            admin && (
              <Button variant="primary" onClick={() => setStarting(true)}>
                <Plus className="size-4" /> {t('billing.sub.start')}
              </Button>
            )
          }
        />
        {admin && <StartSubscriptionDialog tenantId={tenantId} open={starting} onClose={() => setStarting(false)} />}
      </Card>
    );
  }

  const ended = sub.status === 'cancelled';
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t('billing.sub.title')}
          description={admin ? t('billing.sub.adminHint') : undefined}
          actions={
            <>
              {canEdit && !ended && (
                <Button size="sm" variant="primary" onClick={() => setChanging(true)}>
                  {t('billing.change.button')}
                </Button>
              )}
              {admin && (
                <Button size="sm" onClick={() => setEditing(true)}>
                  {t('common.edit')}
                </Button>
              )}
            </>
          }
        />
        <div className="flex flex-col gap-5 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="display text-xl">{sub.package.name}</span>
            <PlanBadge plan={sub.package.edition} />
            <SubscriptionStatusBadge status={sub.status} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Fact label={t('billing.price')}>
              {formatMoney(sub.priceCents, sub.package.currency)} / {t(`billing.per.${sub.interval}`)}
              {sub.discountPercent > 0 && <span className="ml-1 text-xs font-normal text-muted">(−{sub.discountPercent}%)</span>}
            </Fact>
            <Fact label={sub.status === 'trialing' ? t('billing.trialEnds') : ended ? t('billing.endedOn') : t('billing.periodEnds')}>
              {formatDate(ended ? sub.cancelledAt : sub.currentPeriodEnd, false)}
            </Fact>
            <Fact label={t('billing.nextInvoice')}>
              {data!.next ? `${formatMoney(data!.next.totalCents, sub.package.currency)} · ${formatDate(data!.next.at, false)}` : '—'}
            </Fact>
          </div>
          {data!.next && data!.next.vatRate > 0 && <p className="-mt-3 text-xs text-muted">{t('billing.inclVat', { rate: data!.next.vatRate })}</p>}
          {!data!.billingEnabled && admin && <p className="rounded-md bg-warning/10 px-3 py-2 text-[13px] text-warning">{t('billing.disabledNote')}</p>}
          {sub.pendingPackage && (
            <p className="rounded-md bg-chip px-3 py-2 text-[13px]">
              {t('billing.pendingChange', { name: sub.pendingPackage.name, date: formatDate(sub.currentPeriodEnd, false) })}
            </p>
          )}
          {sub.pendingInterval && !sub.pendingPackage && (
            <p className="rounded-md bg-chip px-3 py-2 text-[13px]">
              {t('billing.pendingInterval', { interval: t(`billing.intervals.${sub.pendingInterval}`), date: formatDate(sub.currentPeriodEnd, false) })}
            </p>
          )}
          {sub.cancelAtPeriodEnd && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-warning/10 px-3 py-2 text-[13px] text-warning">
              {t('billing.cancelPending', { date: formatDate(sub.currentPeriodEnd, false) })}
              {canEdit && (
                <Button size="sm" onClick={() => action.mutate({ path: '/resume' })}>
                  <RotateCcw className="size-4" /> {t('billing.sub.undoCancel')}
                </Button>
              )}
            </div>
          )}
          {sub.status === 'past_due' && <p className="rounded-md bg-warning/10 px-3 py-2 text-[13px] text-warning">{t('billing.pastDueNote')}</p>}
          {sub.status === 'suspended' && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{t('billing.suspendedNote')}</p>}
          {admin && sub.notes && <p className="rounded-md border border-line px-3 py-2 text-[13px] whitespace-pre-wrap text-muted">{sub.notes}</p>}
          {admin && (
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              {sub.status === 'suspended' ? (
                <Button size="sm" onClick={() => action.mutate({ path: '/unsuspend' })}>
                  <Play className="size-4" /> {t('billing.sub.unsuspend')}
                </Button>
              ) : (
                !ended && (
                  <Button size="sm" onClick={() => confirm(t('billing.sub.suspendConfirm')) && action.mutate({ path: '/suspend' })}>
                    <Pause className="size-4" /> {t('billing.sub.suspend')}
                  </Button>
                )
              )}
              {ended ? (
                <Button size="sm" onClick={() => action.mutate({ path: '/resume' })}>
                  <RotateCcw className="size-4" /> {t('billing.sub.restart')}
                </Button>
              ) : (
                <>
                  {!sub.cancelAtPeriodEnd && (
                    <Button size="sm" onClick={() => confirm(t('billing.sub.cancelConfirm', { date: formatDate(sub.currentPeriodEnd, false) })) && action.mutate({ path: '/cancel', body: { immediate: false } })}>
                      {t('billing.sub.cancelAtEnd')}
                    </Button>
                  )}
                  <Button size="sm" variant="danger" onClick={() => confirm(t('billing.sub.endNowConfirm')) && action.mutate({ path: '/cancel', body: { immediate: true } })}>
                    <X className="size-4" /> {t('billing.sub.endNow')}
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => confirm(t('billing.sub.removeConfirm')) && action.mutate({ path: '', method: 'DELETE' })}>
                <Trash2 className="size-4 text-offline" /> {t('billing.sub.remove')}
              </Button>
            </div>
          )}
        </div>
        <ChangePackageDialog sub={sub} admin={admin} open={changing} onClose={() => setChanging(false)} />
        {admin && <EditSubscriptionDialog sub={sub} open={editing} onClose={() => setEditing(false)} />}
      </Card>
      {!compact && <BillingDetailsCard sub={sub} canEdit={canEdit} />}
      {!compact && canEdit && !admin && !ended && !sub.cancelAtPeriodEnd && (
        <Card className="border-offline/30 p-5">
          <h2 className="display text-base text-offline">{t('billing.sub.cancelTitle')}</h2>
          <p className="mt-1 mb-4 text-[13px] text-muted">{t('billing.sub.cancelHint', { date: formatDate(sub.currentPeriodEnd, false) })}</p>
          <Button
            variant="danger"
            loading={action.isPending}
            onClick={() => confirm(t('billing.sub.cancelConfirm', { date: formatDate(sub.currentPeriodEnd, false) })) && action.mutate({ path: '/cancel', body: { immediate: false } })}
          >
            {t('billing.sub.cancelButton')}
          </Button>
        </Card>
      )}
    </div>
  );
}
