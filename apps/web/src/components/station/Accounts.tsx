import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError, type Member, type StationAccount, type StationDetail } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { Badge, Button, Card, CardHeader, CopyField, Dialog, Field, Input, Select, Spinner, Switch, Table } from '../ui';

type AccountForm = Pick<StationAccount, 'username' | 'displayName' | 'userId' | 'canBroadcast' | 'canUpload' | 'mountIds' | 'enabled'> & { password: string };
const emptyAccount: AccountForm = { username: '', displayName: '', userId: null, canBroadcast: true, canUpload: false, mountIds: [], enabled: true, password: '' };

/** Shows a generated password once, with what to enter in the encoder or upload program. */
function PasswordDialog({ account, station, onClose }: { account: StationAccount | null; station: StationDetail; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={!!account?.password}
      onClose={onClose}
      title={t('accounts.passwordTitle')}
      description={t('accounts.passwordHint')}
      footer={
        <Button variant="dark" onClick={onClose}>
          {t('common.done')}
        </Button>
      }
    >
      {account?.password && (
        <div className="flex flex-col gap-2">
          <CopyField label={t('accounts.username')} value={account.username} />
          <CopyField label={t('fields.password')} value={account.password} />
          {account.canUpload && <CopyField label={t('accounts.uploadLogin')} value={account.uploadLogin} />}
          {station.connection.legacy && <CopyField label={t('connection.legacyPassword')} value={`${account.username}:${account.password}`} />}
        </div>
      )}
    </Dialog>
  );
}

function AccountDialog({
  station,
  account,
  open,
  onClose,
  onCreated,
}: {
  station: StationDetail;
  account: StationAccount | null;
  open: boolean;
  onClose: () => void;
  onCreated: (a: StationAccount) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<AccountForm>(emptyAccount);
  const [error, setError] = useState<string | null>(null);
  const members = useQuery({ queryKey: ['members', station.tenantId], queryFn: () => api<Member[]>(`/tenants/${station.tenantId}/members`), enabled: open });
  useEffect(() => {
    if (open) {
      setForm(
        account
          ? { username: account.username, displayName: account.displayName, userId: account.userId, canBroadcast: account.canBroadcast, canUpload: account.canUpload, mountIds: account.mountIds, enabled: account.enabled, password: '' }
          : emptyAccount,
      );
      setError(null);
    }
  }, [open, account]);
  const sources = station.mounts.filter((m) => m.kind === 'source');

  const save = useMutation({
    mutationFn: () => {
      const { username, password, ...rest } = form;
      return account
        ? api<StationAccount>(`/stations/${station.id}/accounts/${account.id}`, { method: 'PATCH', body: { ...rest, password: password || undefined } })
        : api<StationAccount>(`/stations/${station.id}/accounts`, { method: 'POST', body: { ...rest, username, password: password || undefined } });
    },
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ['accounts', station.id] });
      onClose();
      if (a.password) onCreated(a);
      else toast.success(t('common.saved'));
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const toggleMount = (id: string) =>
    setForm({ ...form, mountIds: form.mountIds.includes(id) ? form.mountIds.filter((x) => x !== id) : [...form.mountIds, id] });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={account ? t('accounts.edit', { name: account.username }) : t('accounts.add')}
      description={t('accounts.dialogHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="account-form" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="account-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('accounts.username')} hint={t('accounts.usernameHint')}>
            <Input required disabled={!!account} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="dj-reinder" className="font-mono" />
          </Field>
          <Field label={t('accounts.displayName')} hint={t('accounts.displayNameHint')}>
            <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="DJ Reinder" />
          </Field>
        </div>
        <Field label={t('fields.password')} hint={account ? t('accounts.passwordKeep') : t('accounts.passwordGenerate')}>
          <Input type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label={t('accounts.linkedUser')} hint={t('accounts.linkedUserHint')}>
          <Select value={form.userId ?? ''} onChange={(e) => setForm({ ...form, userId: e.target.value || null })}>
            <option value="">{t('accounts.noUser')}</option>
            {(members.data ?? []).map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.name} ({m.user.email})
              </option>
            ))}
          </Select>
        </Field>
        <Switch checked={form.canBroadcast} onChange={(canBroadcast) => setForm({ ...form, canBroadcast })} label={t('accounts.canBroadcast')} description={t('accounts.canBroadcastHint')} />
        {form.canBroadcast && sources.length > 1 && (
          <Field label={t('accounts.mounts')} hint={t('accounts.mountsHint')}>
            <div className="flex flex-wrap gap-2">
              {sources.map((m) => (
                <label key={m.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-[13px]">
                  <input type="checkbox" checked={form.mountIds.includes(m.id)} onChange={() => toggleMount(m.id)} className="accent-[var(--color-koraal)]" />
                  <span className="font-mono">{m.path}</span>
                </label>
              ))}
            </div>
          </Field>
        )}
        <Switch checked={form.canUpload} onChange={(canUpload) => setForm({ ...form, canUpload })} label={t('accounts.canUpload')} description={t('accounts.canUploadHint')} />
        <Switch checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} label={t('accounts.enabled')} />
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

export function AccountsCard({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canEdit = station.role !== 'dj';
  const [editing, setEditing] = useState<StationAccount | null | 'new'>(null);
  const [shown, setShown] = useState<StationAccount | null>(null);
  const accounts = useQuery({ queryKey: ['accounts', station.id], queryFn: () => api<StationAccount[]>(`/stations/${station.id}/accounts`) });
  const mounts = new Map(station.mounts.map((m) => [m.id, m.path]));

  const reset = useMutation({
    mutationFn: (a: StationAccount) => api<StationAccount>(`/stations/${station.id}/accounts/${a.id}`, { method: 'PATCH', body: { resetPassword: true } }),
    onSuccess: (a) => setShown(a),
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (a: StationAccount) => api(`/stations/${station.id}/accounts/${a.id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['accounts', station.id] }),
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Card>
      <CardHeader
        title={canEdit ? t('accounts.title') : t('accounts.mine')}
        description={canEdit ? t('accounts.subtitle') : t('accounts.mineHint')}
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" /> {t('accounts.add')}
            </Button>
          )
        }
      />
      {accounts.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <Table
          head={[t('accounts.username'), t('accounts.rights'), t('accounts.linkedUser'), t('accounts.lastUsed'), '']}
          empty={!accounts.data?.length && <p className="px-5 py-8 text-center text-[13px] text-muted">{canEdit ? t('accounts.empty') : t('accounts.noneForYou')}</p>}
        >
          {(accounts.data ?? []).map((a) => (
            <tr key={a.id}>
              <td>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold">{a.username}</span>
                  {!a.enabled && <Badge tone="offline">{t('common.disabled')}</Badge>}
                </div>
                {a.displayName && <div className="text-xs text-muted">{a.displayName}</div>}
              </td>
              <td>
                <div className="flex flex-wrap gap-1">
                  {a.canBroadcast && <Badge tone="accent">{a.mountIds.length ? a.mountIds.map((id) => mounts.get(id)).join(', ') : t('accounts.broadcast')}</Badge>}
                  {a.canUpload && <Badge>{t('accounts.upload')}</Badge>}
                </div>
              </td>
              <td className="text-[13px] text-muted">{a.userName ?? '—'}</td>
              <td className="text-[13px] whitespace-nowrap text-muted">{formatDate(a.lastUsedAt)}</td>
              <td className="text-right whitespace-nowrap">
                <Button
                  size="sm"
                  variant="ghost"
                  title={t('accounts.resetPassword')}
                  onClick={() => confirm(t('accounts.resetConfirm', { name: a.username })) && reset.mutate(a)}
                >
                  <KeyRound className="size-4 text-muted" />
                </Button>
                {canEdit && (
                  <>
                    <Button size="sm" variant="ghost" title={t('common.edit')} onClick={() => setEditing(a)}>
                      <Pencil className="size-4 text-muted" />
                    </Button>
                    <Button size="sm" variant="ghost" title={t('common.delete')} onClick={() => confirm(t('accounts.deleteConfirm', { name: a.username })) && remove.mutate(a)}>
                      <Trash2 className="size-4 text-offline" />
                    </Button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {canEdit && (
        <AccountDialog station={station} account={editing === 'new' ? null : editing} open={editing !== null} onClose={() => setEditing(null)} onCreated={setShown} />
      )}
      <PasswordDialog account={shown} station={station} onClose={() => setShown(null)} />
    </Card>
  );
}
