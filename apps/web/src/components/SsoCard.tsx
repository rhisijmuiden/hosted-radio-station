import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, PlugZap, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type SsoConfig, type SsoProvider } from '../lib/api';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Segmented, Select, Spinner, Switch, Textarea } from './ui';

const emptyProvider = (type: SsoProvider['type']): SsoProvider => ({
  type,
  enabled: false,
  displayName: '',
  emailDomains: [],
  allowPasswordLogin: true,
  autoCreateUsers: false,
  defaultRole: 'dj',
  oidc: { issuer: '', clientId: '', clientSecret: '', scopes: 'openid email profile' },
  saml: { entryPoint: '', idpCert: '', idpIssuer: '', emailAttribute: '', nameAttribute: '' },
});

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted">{label}</div>
        <div className="truncate font-mono text-xs">{value}</div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        title={t('common.copy')}
        onClick={() => void navigator.clipboard.writeText(value).then(() => toast.success(t('sso.copied')))}
      >
        <Copy className="size-4" />
      </Button>
    </div>
  );
}

/** Single sign-on settings of one customer. Owners edit them; only administrators change the allowed domains. */
export function SsoCard({ tenantId, admin }: { tenantId: string; admin: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['sso', tenantId], queryFn: () => api<SsoConfig>(`/tenants/${tenantId}/sso`) });
  const [form, setForm] = useState<SsoProvider | null>(null);
  const [domains, setDomains] = useState('');

  useEffect(() => {
    if (!config.data?.provider) return setForm(null);
    const p = config.data.provider;
    setForm({ ...emptyProvider(p.type), ...p, oidc: p.oidc ?? emptyProvider('oidc').oidc, saml: p.saml ?? emptyProvider('saml').saml });
    setDomains(p.emailDomains.join('\n'));
  }, [config.data]);

  const onSaved = (res: SsoConfig) => {
    qc.setQueryData(['sso', tenantId], res);
    void qc.invalidateQueries({ queryKey: ['audit'] });
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form!,
        emailDomains: domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean),
        oidc: form!.type === 'oidc' ? form!.oidc : undefined,
        saml: form!.type === 'saml' ? form!.saml : undefined,
        updatedAt: undefined,
      };
      return api<SsoConfig>(`/tenants/${tenantId}/sso`, { method: 'PUT', body });
    },
    onSuccess: (res) => {
      onSaved(res);
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const test = useMutation({
    mutationFn: () => api<{ message: string }>(`/tenants/${tenantId}/sso/test`, { method: 'POST' }),
    onSuccess: (res) => toast.success(res.message),
    onError: (err) => toast.error((err as Error).message, { duration: 10_000 }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/tenants/${tenantId}/sso`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sso', tenantId] });
      toast.success(t('sso.removed'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const ep = config.data?.endpoints;
  const saved = config.data?.provider;
  const set = <K extends keyof SsoProvider>(k: K, v: SsoProvider[K]) => setForm({ ...form!, [k]: v });

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {t('sso.title')}
            {saved && (
              <Badge tone={saved.enabled ? 'online' : 'neutral'} dot>
                {saved.enabled ? t('common.active') : t('common.disabled')}
              </Badge>
            )}
          </span>
        }
        description={t('sso.subtitle')}
      />
      {config.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : !form ? (
        <EmptyState
          icon={<KeyRound className="size-6" />}
          title={t('sso.none')}
          description={t('sso.noneText')}
          action={
            <Button variant="primary" onClick={() => setForm(emptyProvider('oidc'))}>
              {t('sso.setUp')}
            </Button>
          }
        />
      ) : (
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Switch checked={form.enabled} onChange={(v) => set('enabled', v)} label={t('sso.enabled')} description={t('sso.enabledHint')} />
          <Field label={t('sso.protocol')}>
            <Segmented
              value={form.type}
              onChange={(v) => set('type', v)}
              options={[
                { value: 'oidc', label: 'OpenID Connect', description: t('sso.oidcHint') },
                { value: 'saml', label: 'SAML 2.0', description: t('sso.samlHint') },
              ]}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('sso.displayName')} hint={t('sso.displayNameHint')}>
              <Input value={form.displayName} maxLength={60} onChange={(e) => set('displayName', e.target.value)} placeholder="Microsoft" />
            </Field>
            <Field label={t('sso.domains')} hint={admin ? t('sso.domainsHint') : t('sso.domainsAdminOnly')}>
              <Textarea className="min-h-10 font-sans text-sm" rows={2} disabled={!admin} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="harder.fm" />
            </Field>
          </div>

          {form.type === 'oidc' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('sso.issuer')} hint={t('sso.issuerHint')} className="sm:col-span-2">
                <Input required type="url" value={form.oidc!.issuer} onChange={(e) => set('oidc', { ...form.oidc!, issuer: e.target.value })} placeholder="https://login.microsoftonline.com/…/v2.0" />
              </Field>
              <Field label={t('sso.clientId')}>
                <Input required value={form.oidc!.clientId} onChange={(e) => set('oidc', { ...form.oidc!, clientId: e.target.value })} />
              </Field>
              <Field label={t('sso.clientSecret')}>
                <Input type="password" autoComplete="new-password" value={form.oidc!.clientSecret} onChange={(e) => set('oidc', { ...form.oidc!, clientSecret: e.target.value })} />
              </Field>
              <Field label={t('sso.scopes')} className="sm:col-span-2">
                <Input value={form.oidc!.scopes} onChange={(e) => set('oidc', { ...form.oidc!, scopes: e.target.value })} />
              </Field>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('sso.entryPoint')} className="sm:col-span-2">
                <Input required type="url" value={form.saml!.entryPoint} onChange={(e) => set('saml', { ...form.saml!, entryPoint: e.target.value })} />
              </Field>
              <Field label={t('sso.idpCert')} hint={t('sso.idpCertHint')} className="sm:col-span-2">
                <Textarea required value={form.saml!.idpCert} onChange={(e) => set('saml', { ...form.saml!, idpCert: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" />
              </Field>
              <Field label={t('sso.idpIssuer')} className="sm:col-span-2">
                <Input value={form.saml!.idpIssuer} onChange={(e) => set('saml', { ...form.saml!, idpIssuer: e.target.value })} />
              </Field>
              <Field label={t('sso.emailAttribute')} hint={t('sso.attributeHint')}>
                <Input value={form.saml!.emailAttribute} onChange={(e) => set('saml', { ...form.saml!, emailAttribute: e.target.value })} />
              </Field>
              <Field label={t('sso.nameAttribute')} hint={t('sso.attributeHint')}>
                <Input value={form.saml!.nameAttribute} onChange={(e) => set('saml', { ...form.saml!, nameAttribute: e.target.value })} />
              </Field>
            </div>
          )}

          <Switch checked={form.allowPasswordLogin} onChange={(v) => set('allowPasswordLogin', v)} label={t('sso.allowPassword')} description={t('sso.allowPasswordHint')} />
          <Switch checked={form.autoCreateUsers} onChange={(v) => set('autoCreateUsers', v)} label={t('sso.autoCreate')} description={t('sso.autoCreateHint')} />
          {form.autoCreateUsers && (
            <Field label={t('sso.defaultRole')}>
              <Select value={form.defaultRole} onChange={(e) => set('defaultRole', e.target.value as SsoProvider['defaultRole'])}>
                <option value="dj">{t('roles.dj')}</option>
                <option value="manager">{t('roles.manager')}</option>
              </Select>
            </Field>
          )}

          {ep && (
            <div className="flex flex-col gap-2.5 rounded-md border border-line bg-chip/40 p-3.5">
              <div className="text-[13px] font-semibold">{t('sso.forProvider')}</div>
              {form.type === 'oidc' ? (
                <CopyRow label={t('sso.redirectUri')} value={ep.oidcRedirectUri} />
              ) : (
                <>
                  <CopyRow label={t('sso.entityId')} value={ep.samlEntityId} />
                  <CopyRow label={t('sso.acsUrl')} value={ep.samlAcsUrl} />
                  <CopyRow label={t('sso.metadataUrl')} value={ep.samlMetadataUrl} />
                </>
              )}
              <CopyRow label={t('sso.loginUrl')} value={ep.loginUrl} />
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {saved && (
              <>
                <Button type="button" variant="danger" onClick={() => confirm(t('sso.removeConfirm')) && remove.mutate()} loading={remove.isPending}>
                  <Trash2 className="size-4" /> {t('sso.remove')}
                </Button>
                <Button type="button" onClick={() => test.mutate()} loading={test.isPending}>
                  <PlugZap className="size-4" /> {t('sso.test')}
                </Button>
              </>
            )}
            {!saved && (
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>
                {t('common.cancel')}
              </Button>
            )}
            <Button type="submit" variant="dark" loading={save.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
