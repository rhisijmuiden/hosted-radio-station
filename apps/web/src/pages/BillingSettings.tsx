import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button, Card, CardHeader, Field, Input, PageHeader, Spinner, Switch, Textarea } from '../components/ui';
import { api, type BillingSettings } from '../lib/api';

export function BillingSettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings', 'billing'], queryFn: () => api<BillingSettings>('/billing/settings') });
  const [form, setForm] = useState<BillingSettings | null>(null);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (body: BillingSettings) => api<BillingSettings>('/billing/settings', { method: 'PUT', body }),
    onSuccess: (res) => {
      qc.setQueryData(['settings', 'billing'], res);
      void qc.invalidateQueries({ queryKey: ['billing'] });
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const mollieTest = useMutation({
    mutationFn: () => api<{ testMode: boolean; methods: string[] }>('/billing/settings/mollie-test', { method: 'POST', body: { apiKey: form!.mollie.apiKey } }),
    onError: (err) => toast.error((err as Error).message, { duration: 10_000 }),
  });

  if (!form) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  const c = form.company;
  const setC = (k: keyof BillingSettings['company']) => (e: { target: { value: string } }) => setForm({ ...form, company: { ...c, [k]: e.target.value } });
  const num = (k: 'vatRate' | 'paymentTermDays' | 'reminderAfterDays' | 'suspendAfterDays') => (e: { target: { value: string } }) => setForm({ ...form, [k]: Number(e.target.value) });

  return (
    <>
      <PageHeader title={t('billing.settings.title')} description={t('billing.settings.subtitle')} />
      <form
        className="grid gap-4 xl:grid-cols-[1.4fr_1fr]"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(form);
        }}
      >
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('billing.settings.company')} description={t('billing.settings.companyHint')} />
            <div className="grid gap-3 p-5 sm:grid-cols-2">
              <Field label={t('billing.contact.company')}>
                <Input value={c.company} onChange={setC('company')} placeholder="RHIS" />
              </Field>
              <Field label={t('billing.contact.name')}>
                <Input value={c.name} onChange={setC('name')} />
              </Field>
              <Field label={t('billing.contact.address')} className="sm:col-span-2">
                <Input value={c.address} onChange={setC('address')} />
              </Field>
              <Field label={t('billing.contact.postcode')}>
                <Input value={c.postcode} onChange={setC('postcode')} />
              </Field>
              <Field label={t('billing.contact.city')}>
                <Input value={c.city} onChange={setC('city')} />
              </Field>
              <Field label={t('billing.contact.country')} hint={t('billing.contact.countryHint')}>
                <Input maxLength={2} value={c.country} onChange={(e) => setForm({ ...form, company: { ...c, country: e.target.value.toUpperCase() } })} />
              </Field>
              <Field label={t('billing.settings.phone')}>
                <Input value={c.phone} onChange={setC('phone')} />
              </Field>
              <Field label={t('billing.contact.email')}>
                <Input type="email" value={c.email} onChange={setC('email')} />
              </Field>
              <Field label={t('billing.settings.website')}>
                <Input value={c.website} onChange={setC('website')} placeholder="rhis.nl" />
              </Field>
              <Field label={t('billing.contact.vatNumber')}>
                <Input value={c.vatNumber} onChange={setC('vatNumber')} placeholder="NL001234567B01" />
              </Field>
              <Field label={t('billing.settings.coc')}>
                <Input value={c.cocNumber} onChange={setC('cocNumber')} />
              </Field>
              <Field label="IBAN">
                <Input value={c.iban} onChange={setC('iban')} />
              </Field>
              <Field label="BIC">
                <Input value={c.bic} onChange={setC('bic')} />
              </Field>
            </div>
          </Card>
          <Card>
            <CardHeader title={t('billing.settings.invoices')} />
            <div className="flex flex-col gap-4 p-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('billing.settings.prefix')} hint={t('billing.settings.prefixHint', { example: `${form.invoicePrefix}${new Date().getFullYear()}-0001` })}>
                  <Input value={form.invoicePrefix} onChange={(e) => setForm({ ...form, invoicePrefix: e.target.value })} />
                </Field>
                <Field label={t('billing.settings.vatRate')}>
                  <Input type="number" min={0} max={50} step="0.1" value={form.vatRate} onChange={num('vatRate')} />
                </Field>
                <Field label={t('billing.settings.term')}>
                  <Input type="number" min={0} max={90} value={form.paymentTermDays} onChange={num('paymentTermDays')} />
                </Field>
              </div>
              <Switch checked={form.reverseCharge} onChange={(v) => setForm({ ...form, reverseCharge: v })} label={t('billing.settings.reverseCharge')} description={t('billing.settings.reverseChargeHint')} />
              <Switch checked={form.emailInvoices} onChange={(v) => setForm({ ...form, emailInvoices: v })} label={t('billing.settings.email')} description={t('billing.settings.emailHint')} />
              <Field label={t('billing.settings.bcc')} hint={t('billing.settings.bccHint')}>
                <Input type="email" value={form.bccEmail} onChange={(e) => setForm({ ...form, bccEmail: e.target.value })} />
              </Field>
              <Field label={t('billing.settings.footer')} hint={t('billing.settings.footerHint')}>
                <Textarea className="font-sans text-sm" value={form.footer} onChange={(e) => setForm({ ...form, footer: e.target.value })} />
              </Field>
            </div>
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('billing.settings.status')} />
            <div className="flex flex-col gap-4 p-5">
              <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={t('billing.settings.enabled')} description={t('billing.settings.enabledHint')} />
              <Button type="submit" variant="dark" loading={save.isPending}>
                {t('common.save')}
              </Button>
            </div>
          </Card>
          <Card>
            <CardHeader title={t('billing.settings.dunning')} description={t('billing.settings.dunningHint')} />
            <div className="grid gap-3 p-5 sm:grid-cols-2">
              <Field label={t('billing.settings.reminder')} hint={t('billing.settings.daysAfterDue')}>
                <Input type="number" min={1} max={60} value={form.reminderAfterDays} onChange={num('reminderAfterDays')} />
              </Field>
              <Field label={t('billing.settings.suspend')} hint={t('billing.settings.suspendHint')}>
                <Input type="number" min={0} max={180} value={form.suspendAfterDays} onChange={num('suspendAfterDays')} />
              </Field>
            </div>
          </Card>
          <Card>
            <CardHeader title={t('billing.settings.mollie')} description={t('billing.settings.mollieHint')} />
            <div className="flex flex-col gap-4 p-5">
              <Switch checked={form.mollie.enabled} onChange={(v) => setForm({ ...form, mollie: { ...form.mollie, enabled: v } })} label={t('billing.settings.mollieEnabled')} />
              <Field label={t('billing.settings.mollieKey')} hint={t('billing.settings.mollieKeyHint')}>
                <Input type="password" autoComplete="off" value={form.mollie.apiKey} onChange={(e) => setForm({ ...form, mollie: { ...form.mollie, apiKey: e.target.value } })} placeholder="test_…" />
              </Field>
              <Button type="button" onClick={() => mollieTest.mutate()} loading={mollieTest.isPending} disabled={!form.mollie.apiKey}>
                {t('billing.settings.mollieTest')}
              </Button>
              {mollieTest.data && (
                <p className="flex items-start gap-2 rounded-md bg-online/10 px-3 py-2 text-[13px] text-online">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                  {t(mollieTest.data.testMode ? 'billing.settings.mollieOkTest' : 'billing.settings.mollieOkLive', { methods: mollieTest.data.methods.join(', ') || '—' })}
                </p>
              )}
              <p className="text-xs text-muted">{t('billing.settings.mollieWebhook')}</p>
            </div>
          </Card>
        </div>
      </form>
    </>
  );
}
