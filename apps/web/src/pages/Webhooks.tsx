import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, CopyField, Dialog, EmptyState, Field, Input, PageHeader, Spinner, Switch, Table } from '../components/ui';
import { api, ApiError, WEBHOOK_EVENTS, type Webhook, type WebhookDelivery } from '../lib/api';
import { formatDate, formatRelative } from '../lib/format';

function NewWebhookDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', url: '', all: true, events: [] as string[] });
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm({ name: '', url: '', all: true, events: [] });
      setSecret(null);
      setError(null);
    }
  }, [open]);
  const create = useMutation({
    mutationFn: () => api<Webhook>('/billing/webhooks', { method: 'POST', body: { name: form.name, url: form.url, events: form.all ? ['*'] : form.events } }),
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
      setSecret(w.secret ?? null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('webhooks.new')}
      description={t('webhooks.newHint')}
      footer={
        secret ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={create.isPending} disabled={!form.name || !form.url || (!form.all && !form.events.length)} onClick={() => create.mutate()}>
              {t('webhooks.create')}
            </Button>
          </>
        )
      }
    >
      {secret ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px]">{t('webhooks.secretOnce')}</p>
          <CopyField label={t('webhooks.secret')} value={secret} />
          <p className="text-xs text-muted">{t('webhooks.verifyHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label={t('fields.name')}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="RHIS website" />
          </Field>
          <Field label="URL">
            <Input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://rhis.nl/api/hrs-webhook" />
          </Field>
          <Switch checked={form.all} onChange={(all) => setForm({ ...form, all })} label={t('webhooks.allEvents')} />
          {!form.all && (
            <div className="grid gap-2 sm:grid-cols-2">
              {WEBHOOK_EVENTS.map((e) => (
                <label key={e} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    className="accent-[var(--koraal)]"
                    checked={form.events.includes(e)}
                    onChange={(ev) => setForm({ ...form, events: ev.target.checked ? [...form.events, e] : form.events.filter((x) => x !== e) })}
                  />
                  <span className="font-mono">{e}</span>
                </label>
              ))}
            </div>
          )}
          {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}

function DeliveriesDialog({ hook, onClose }: { hook: Webhook | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const deliveries = useQuery({ queryKey: ['webhooks', hook?.id, 'deliveries'], queryFn: () => api<WebhookDelivery[]>(`/billing/webhooks/${hook!.id}/deliveries`), enabled: !!hook });
  const [open, setOpen] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: (id: string) => api<WebhookDelivery>(`/billing/webhooks/deliveries/${id}/retry`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });
  return (
    <Dialog open={!!hook} onClose={onClose} wide title={t('webhooks.deliveries', { name: hook?.name })}>
      {deliveries.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : deliveries.data?.length ? (
        <div className="-mx-5 -my-4">
          <Table head={[t('webhooks.event'), t('fields.status'), t('webhooks.attempts'), t('fields.created'), '']}>
            {deliveries.data.map((d) => (
              <>
                <tr key={d.id} className="cursor-pointer" onClick={() => setOpen(open === d.id ? null : d.id)}>
                  <td className="font-mono text-[13px]">{d.event}</td>
                  <td>
                    <Badge tone={d.state === 'delivered' ? 'online' : d.state === 'failed' ? 'offline' : 'warning'}>
                      {t(`webhooks.state.${d.state}`)} {d.responseStatus ? `· ${d.responseStatus}` : ''}
                    </Badge>
                    {d.error && <div className="mt-1 max-w-56 truncate text-xs text-offline" title={d.error}>{d.error}</div>}
                    {d.state === 'pending' && d.attempts > 0 && <div className="mt-1 text-xs text-muted">{t('webhooks.nextTry', { when: formatRelative(d.nextAttemptAt) })}</div>}
                  </td>
                  <td>{d.attempts}</td>
                  <td className="whitespace-nowrap text-muted">{formatDate(d.createdAt)}</td>
                  <td className="text-right">
                    {d.state !== 'delivered' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t('webhooks.retry')}
                        onClick={(e) => {
                          e.stopPropagation();
                          retry.mutate(d.id);
                        }}
                      >
                        <RefreshCw className="size-4" />
                      </Button>
                    )}
                  </td>
                </tr>
                {open === d.id && (
                  <tr key={`${d.id}-payload`}>
                    <td colSpan={5}>
                      <pre className="max-h-64 overflow-auto rounded-md bg-chip p-3 text-xs">{JSON.stringify(d.payload, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </Table>
        </div>
      ) : (
        <p className="py-8 text-center text-[13px] text-muted">{t('webhooks.noDeliveries')}</p>
      )}
    </Dialog>
  );
}

export function WebhooksPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api<Webhook[]>('/billing/webhooks') });
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<Webhook | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['webhooks'] });
  const toggle = useMutation({ mutationFn: (w: Webhook) => api(`/billing/webhooks/${w.id}`, { method: 'PATCH', body: { active: !w.active } }), onSuccess: refresh });
  const del = useMutation({ mutationFn: (w: Webhook) => api(`/billing/webhooks/${w.id}`, { method: 'DELETE' }), onSuccess: refresh });
  const test = useMutation({
    mutationFn: (w: Webhook) => api<WebhookDelivery>(`/billing/webhooks/${w.id}/test`, { method: 'POST' }),
    onSuccess: (d) => {
      refresh();
      if (d.state === 'delivered') toast.success(t('webhooks.testOk', { status: d.responseStatus }));
      else toast.error(t('webhooks.testFailed', { error: d.error ?? d.responseStatus }));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <>
      <PageHeader
        title={t('webhooks.title')}
        description={t('webhooks.subtitle')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> {t('webhooks.new')}
          </Button>
        }
      />
      <Card>
        <CardHeader title={t('webhooks.listTitle')} description={t('webhooks.listHint')} />
        {hooks.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : hooks.data?.length ? (
          <Table head={[t('fields.name'), t('webhooks.events'), t('webhooks.last'), t('fields.status'), '']}>
            {hooks.data.map((w) => (
              <tr key={w.id}>
                <td>
                  <button className="font-semibold hover:text-accent-text" onClick={() => setViewing(w)}>
                    {w.name}
                  </button>
                  <div className="max-w-72 truncate font-mono text-xs text-muted">{w.url}</div>
                </td>
                <td className="text-[13px]">{w.events.includes('*') ? t('webhooks.allEvents') : w.events.length}</td>
                <td className="text-[13px]">
                  {w.lastDelivery ? (
                    <span className={w.lastDelivery.state === 'delivered' ? 'text-online' : w.lastDelivery.state === 'failed' ? 'text-offline' : 'text-warning'}>
                      {t(`webhooks.state.${w.lastDelivery.state}`)} · {formatRelative(w.lastDelivery.at)}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td>
                  <button onClick={() => toggle.mutate(w)}>
                    <Badge tone={w.active ? 'online' : 'neutral'} dot>
                      {w.active ? t('common.active') : t('common.disabled')}
                    </Badge>
                  </button>
                </td>
                <td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" title={t('webhooks.test')} loading={test.isPending && test.variables?.id === w.id} onClick={() => test.mutate(w)}>
                    <Send className="size-4" />
                  </Button>
                  <Button size="sm" variant="ghost" title={t('common.delete')} onClick={() => confirm(t('webhooks.deleteConfirm', { name: w.name })) && del.mutate(w)}>
                    <Trash2 className="size-4 text-offline" />
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState icon={<WebhookIcon className="size-5" />} title={t('webhooks.empty')} description={t('webhooks.emptyHint')} />
        )}
      </Card>
      <Card className="mt-4 p-5 text-[13px]">
        <h2 className="display mb-2 text-base">{t('webhooks.howTitle')}</h2>
        <p className="text-muted">{t('webhooks.how')}</p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-chip p-3 text-xs">{`X-HRS-Event: invoice.paid
X-HRS-Signature: t=1793000000,v1=<hex>
// v1 = HMAC-SHA256(secret, t + "." + raw body)`}</pre>
      </Card>
      <NewWebhookDialog open={creating} onClose={() => setCreating(false)} />
      <DeliveriesDialog hook={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
