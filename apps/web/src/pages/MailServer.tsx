import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button, Card, CardHeader, Field, Input, PageHeader, Select, Spinner, Switch, Textarea } from '../components/ui';
import { api, type SmtpSettings } from '../lib/api';
import { useMe } from '../lib/auth';

const defaultPorts = { starttls: 587, tls: 465, none: 25 } as const;

export function MailServerPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe().data!;
  const smtp = useQuery({ queryKey: ['settings', 'smtp'], queryFn: () => api<SmtpSettings>('/settings/smtp') });
  const [form, setForm] = useState<SmtpSettings | null>(null);
  const [testTo, setTestTo] = useState(me.user.email);
  useEffect(() => {
    if (smtp.data) setForm(smtp.data);
  }, [smtp.data]);

  const save = useMutation({
    mutationFn: (body: SmtpSettings) => api<SmtpSettings>('/settings/smtp', { method: 'PUT', body }),
    onSuccess: (res) => {
      qc.setQueryData(['settings', 'smtp'], res);
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const test = useMutation({
    mutationFn: () => api<{ messageId: string }>('/settings/smtp/test', { method: 'POST', body: { to: testTo, smtp: form } }),
    onSuccess: () => toast.success(t('mail.testSent', { to: testTo })),
    onError: (err) => toast.error((err as Error).message, { duration: 10_000 }),
  });

  if (!form) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  const set = <K extends keyof SmtpSettings>(key: K, value: SmtpSettings[K]) => setForm({ ...form, [key]: value });

  return (
    <>
      <PageHeader title={t('nav.mail')} description={t('mail.subtitle')} />
      <form
        className="grid gap-4 xl:grid-cols-[1.4fr_1fr]"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(form);
        }}
      >
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('mail.server')} description={t('mail.serverHint')} />
            <div className="flex flex-col gap-4 p-5">
              <Switch checked={form.enabled} onChange={(v) => set('enabled', v)} label={t('mail.enabled')} description={t('mail.enabledHint')} />
              <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                <Field label={t('mail.host')}>
                  <Input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.example.com" />
                </Field>
                <Field label={t('mail.port')}>
                  <Input type="number" min={1} max={65535} value={form.port} onChange={(e) => set('port', Number(e.target.value))} />
                </Field>
              </div>
              <Field label={t('mail.security')} hint={t(`mail.security_${form.security}`)}>
                <Select
                  value={form.security}
                  onChange={(e) => {
                    const security = e.target.value as SmtpSettings['security'];
                    setForm({ ...form, security, port: defaultPorts[security] });
                  }}
                >
                  <option value="starttls">STARTTLS (587)</option>
                  <option value="tls">SSL/TLS (465)</option>
                  <option value="none">{t('mail.securityNone')}</option>
                </Select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('mail.username')}>
                  <Input autoComplete="off" value={form.username} onChange={(e) => set('username', e.target.value)} />
                </Field>
                <Field label={t('fields.password')}>
                  <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} />
                </Field>
              </div>
              <Switch checked={form.verifyCertificate} onChange={(v) => set('verifyCertificate', v)} label={t('mail.verify')} description={t('mail.verifyHint')} />
            </div>
          </Card>

          <Card>
            <CardHeader title="DKIM" description={t('mail.dkimHint')} />
            <div className="flex flex-col gap-4 p-5">
              <Switch checked={form.dkim.enabled} onChange={(v) => set('dkim', { ...form.dkim, enabled: v })} label={t('mail.dkimEnabled')} />
              {form.dkim.enabled && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('mail.dkimDomain')}>
                      <Input value={form.dkim.domain} onChange={(e) => set('dkim', { ...form.dkim, domain: e.target.value })} placeholder="example.com" />
                    </Field>
                    <Field label={t('mail.dkimSelector')}>
                      <Input value={form.dkim.selector} onChange={(e) => set('dkim', { ...form.dkim, selector: e.target.value })} placeholder="radio" />
                    </Field>
                  </div>
                  <Field label={t('mail.dkimKey')} hint={t('mail.dkimKeyHint')}>
                    <Textarea
                      value={form.dkim.privateKey}
                      onChange={(e) => set('dkim', { ...form.dkim, privateKey: e.target.value })}
                      placeholder="-----BEGIN PRIVATE KEY-----"
                    />
                  </Field>
                </>
              )}
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('mail.sender')} />
            <div className="flex flex-col gap-4 p-5">
              <Field label={t('mail.fromName')}>
                <Input value={form.fromName} onChange={(e) => set('fromName', e.target.value)} />
              </Field>
              <Field label={t('mail.fromAddress')}>
                <Input type="email" value={form.fromAddress} onChange={(e) => set('fromAddress', e.target.value)} placeholder="radio@example.com" />
              </Field>
              <Field label={t('mail.replyTo')}>
                <Input type="email" value={form.replyTo} onChange={(e) => set('replyTo', e.target.value)} />
              </Field>
              <Button type="submit" variant="dark" loading={save.isPending}>
                {t('common.save')}
              </Button>
            </div>
          </Card>
          <Card>
            <CardHeader title={t('mail.test')} description={t('mail.testHint')} />
            <div className="flex flex-col gap-3 p-5">
              <Field label={t('mail.testTo')}>
                <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              </Field>
              <Button type="button" variant="primary" onClick={() => test.mutate()} loading={test.isPending} disabled={!form.host || !form.fromAddress}>
                <Send className="size-4" /> {t('mail.sendTest')}
              </Button>
            </div>
          </Card>
        </div>
      </form>
    </>
  );
}
