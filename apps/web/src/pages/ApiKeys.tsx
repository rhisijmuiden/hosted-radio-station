import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Switch, Table } from '../components/ui';
import { api, ApiError, type ApiKey, type Tenant } from '../lib/api';
import { formatDate } from '../lib/format';
import { isAdmin, useMe } from '../lib/auth';

function NewKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants'), enabled: open });
  const admin = isAdmin(useMe().data!);
  const [form, setForm] = useState({ name: '', tenantId: '', readOnly: false, expiresInDays: '', provisioning: false });
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm({ name: '', tenantId: '', readOnly: false, expiresInDays: '', provisioning: false });
      setSecret(null);
      setCopied(false);
      setError(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api<ApiKey & { secret: string }>('/api-keys', {
        method: 'POST',
        body: {
          name: form.name,
          tenantId: form.provisioning ? null : form.tenantId || null,
          readOnly: form.readOnly,
          scope: form.provisioning ? 'provisioning' : 'full',
          expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : null,
        },
      }),
    onSuccess: (res) => {
      setSecret(res.secret);
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const copy = async () => {
    await navigator.clipboard.writeText(secret!);
    setCopied(true);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={secret ? t('apiKeys.createdTitle') : t('apiKeys.new')}
      description={secret ? t('apiKeys.createdHint') : t('apiKeys.newHint')}
      footer={
        secret ? (
          <Button variant="dark" onClick={onClose}>
            {t('common.done')}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="key-form" loading={create.isPending}>
              {t('apiKeys.create')}
            </Button>
          </>
        )
      }
    >
      {secret ? (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 rounded-md bg-nacht px-3 py-2.5 font-mono text-xs break-all text-white">{secret}</code>
          <Button onClick={() => void copy()} title={t('common.copy')}>
            {copied ? <Check className="size-4 text-online" /> : <Copy className="size-4" />}
          </Button>
        </div>
      ) : (
        <form
          id="key-form"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label={t('fields.name')} hint={t('apiKeys.nameHint')}>
            <Input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="RHIS website" />
          </Field>
          <Field label={t('apiKeys.scope')} hint={t('apiKeys.scopeHint')}>
            <Select value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })}>
              <option value="">{t('apiKeys.allCustomers')}</option>
              {(tenants.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('apiKeys.expires')}>
            <Select value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })}>
              <option value="">{t('apiKeys.never')}</option>
              <option value="30">{t('apiKeys.days', { count: 30 })}</option>
              <option value="90">{t('apiKeys.days', { count: 90 })}</option>
              <option value="365">{t('apiKeys.days', { count: 365 })}</option>
            </Select>
          </Field>
          <Switch checked={form.readOnly} onChange={(readOnly) => setForm({ ...form, readOnly })} label={t('apiKeys.readOnly')} description={t('apiKeys.readOnlyHint')} />
          {admin && (
            <Switch
              checked={form.provisioning}
              onChange={(provisioning) => setForm({ ...form, provisioning, tenantId: provisioning ? '' : form.tenantId })}
              label={t('apiKeys.provisioning')}
              description={t('apiKeys.provisioningHint')}
            />
          )}
          {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
        </form>
      )}
    </Dialog>
  );
}

export function ApiKeysPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api<ApiKey[]>('/api-keys') });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success(t('apiKeys.revoked'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <>
      <PageHeader
        title={t('nav.apiKeys')}
        description={t('apiKeys.subtitle')}
        actions={
          <>
            <a href="/api/docs" target="_blank" rel="noreferrer">
              <Button>{t('nav.apiDocs')}</Button>
            </a>
            <Button variant="primary" onClick={() => setOpen(true)}>
              + {t('apiKeys.new')}
            </Button>
          </>
        }
      />
      <Card>
        {keys.isPending ? (
          <div className="grid place-items-center py-12">
            <Spinner />
          </div>
        ) : (keys.data ?? []).length === 0 ? (
          <EmptyState
            icon={<KeyRound className="size-6" />}
            title={t('apiKeys.empty')}
            description={t('apiKeys.emptyText')}
            action={<Button variant="primary" onClick={() => setOpen(true)}>+ {t('apiKeys.new')}</Button>}
          />
        ) : (
          <Table head={[t('fields.name'), t('apiKeys.key'), t('apiKeys.scope'), t('apiKeys.lastUsed'), t('apiKeys.expires'), '']}>
            {keys.data!.map((k) => (
              <tr key={k.id}>
                <td className="font-semibold">
                  {k.name} {k.readOnly && <Badge>{t('apiKeys.readOnlyShort')}</Badge>} {k.scope === 'provisioning' && <Badge tone="accent">{t('apiKeys.provisioningShort')}</Badge>}
                </td>
                <td>
                  <code className="text-xs text-muted">{k.prefix}…</code>
                </td>
                <td>{k.tenantName ?? <span className="text-muted">{t('apiKeys.allCustomers')}</span>}</td>
                <td className="whitespace-nowrap text-muted">{k.lastUsedAt ? formatDate(k.lastUsedAt) : t('apiKeys.neverUsed')}</td>
                <td className="whitespace-nowrap text-muted">{k.expiresAt ? formatDate(k.expiresAt, false) : t('apiKeys.never')}</td>
                <td className="text-right">
                  <Button size="sm" variant="ghost" title={t('apiKeys.revoke')} onClick={() => confirm(t('apiKeys.revokeConfirm', { name: k.name })) && revoke.mutate(k.id)}>
                    <Trash2 className="size-4 text-offline" />
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card className="mt-4 p-5">
        <h2 className="display mb-2 text-base">{t('apiKeys.usage')}</h2>
        <p className="mb-3 text-[13px] text-muted">{t('apiKeys.usageText')}</p>
        <pre className="overflow-x-auto rounded-md bg-nacht p-3 font-mono text-xs text-white/90">
          {`curl -H "Authorization: Bearer hrs_…" ${window.location.origin}/api/tenants`}
        </pre>
      </Card>
      <NewKeyDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
