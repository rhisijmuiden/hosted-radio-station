import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Mic, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Header, Label } from './common';
import { Badge, Button, Card, CopyField, Dialog, Field, Input, Select, Spinner, Switch, Table } from '../ui';
import { api, ApiError, type Account, type Member, type StationDetail, type StationListItem } from '../../lib/api';
import { useScheduler } from '../../lib/clocks';
import { ask } from '../../lib/native';
import { useAccounts, useStationDetail, useStatus } from '../../lib/queries';

type AccountForm = Pick<Account, 'username' | 'displayName' | 'userId' | 'canBroadcast' | 'mountIds' | 'enabled'> & { canUpload: boolean; password: string };
const emptyAccount: AccountForm = { username: '', displayName: '', userId: null, canBroadcast: true, canUpload: false, mountIds: [], enabled: true, password: '' };
const since = (iso: string) => new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const day = (iso: string | null | undefined, lang: string) => (iso ? new Date(iso).toLocaleDateString(lang === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** Shows a generated password once, with what to enter in the encoder or upload program. */
function PasswordDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={!!account?.password}
      onClose={onClose}
      title={t('people.passwordTitle')}
      description={t('people.passwordHint')}
      footer={
        <Button variant="dark" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      {account?.password && (
        <div className="flex flex-col gap-2">
          <CopyField label={t('people.username')} value={account.username} />
          <CopyField label={t('people.password')} value={account.password} />
          {account.canUpload && account.uploadLogin && <CopyField label={t('people.uploadLogin')} value={account.uploadLogin} />}
        </div>
      )}
    </Dialog>
  );
}

function AccountDialog({ station, detail, account, open, onClose, onCreated }: { station: StationListItem; detail: StationDetail | undefined; account: Account | null; open: boolean; onClose: () => void; onCreated: (a: Account) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<AccountForm>(emptyAccount);
  const [error, setError] = useState<string | null>(null);
  const tenantId = detail?.tenantId;
  const members = useQuery({ queryKey: ['members', tenantId], queryFn: () => api<Member[]>(`/tenants/${tenantId}/members`), enabled: open && !!tenantId });
  useEffect(() => {
    if (open) {
      setForm(
        account
          ? { username: account.username, displayName: account.displayName, userId: account.userId, canBroadcast: account.canBroadcast, canUpload: !!account.canUpload, mountIds: account.mountIds, enabled: account.enabled, password: '' }
          : emptyAccount,
      );
      setError(null);
    }
  }, [open, account]);
  const sources = (detail?.mounts ?? []).filter((m) => m.kind === 'source');

  const save = useMutation({
    mutationFn: () => {
      const { username, password, ...rest } = form;
      return account
        ? api<Account>(`/stations/${station.id}/accounts/${account.id}`, { method: 'PATCH', body: { ...rest, password: password || undefined } })
        : api<Account>(`/stations/${station.id}/accounts`, { method: 'POST', body: { ...rest, username, password: password || undefined } });
    },
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ['accounts', station.id] });
      onClose();
      if (a.password) onCreated(a);
      else toast.success(t('people.saved'));
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const toggleMount = (id: string) => setForm({ ...form, mountIds: form.mountIds.includes(id) ? form.mountIds.filter((x) => x !== id) : [...form.mountIds, id] });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={account ? t('people.edit', { name: account.username }) : t('people.add')}
      description={t('people.dialogHint')}
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
          <Field label={t('people.username')} hint={t('people.usernameHint')}>
            <Input required autoFocus={!account} disabled={!!account} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="dj-reinder" className="font-mono" />
          </Field>
          <Field label={t('people.displayName')} hint={t('people.displayNameHint')}>
            <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="DJ Reinder" />
          </Field>
        </div>
        <Field label={t('people.password')} hint={account ? t('people.passwordKeep') : t('people.passwordGenerate')}>
          <Input type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label={t('people.linkedUser')} hint={t('people.linkedUserHint')}>
          <Select value={form.userId ?? ''} onChange={(e) => setForm({ ...form, userId: e.target.value || null })}>
            <option value="">{t('people.noUser')}</option>
            {(members.data ?? []).map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.name} ({m.user.email})
              </option>
            ))}
          </Select>
        </Field>
        <Switch checked={form.canBroadcast} onChange={(canBroadcast) => setForm({ ...form, canBroadcast })} label={t('people.canBroadcast')} description={t('people.canBroadcastHint')} />
        {form.canBroadcast && sources.length > 1 && (
          <Field label={t('people.mounts')} hint={t('people.mountsHint')}>
            <div className="flex flex-wrap gap-2">
              {sources.map((m) => (
                <label key={m.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-[13px]">
                  <input type="checkbox" checked={form.mountIds.includes(m.id)} onChange={() => toggleMount(m.id)} className="accent-koraal" />
                  <span className="font-mono">{m.path}</span>
                </label>
              ))}
            </div>
          </Field>
        )}
        <Switch checked={form.canUpload} onChange={(canUpload) => setForm({ ...form, canUpload })} label={t('people.canUpload')} description={t('people.canUploadHint')} />
        <Switch checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} label={t('people.enabled')} />
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

/** DJs & live access of the Manage view: who is live now, the DJ accounts with their rights and shows. */
export function PeopleSection({ station }: { station: StationListItem }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const accounts = useAccounts(station.id);
  const detail = useStationDetail(station.id);
  const status = useStatus(station.id);
  const scheduler = useScheduler(station.id);
  const [editing, setEditing] = useState<Account | null | 'new'>(null);
  const [shown, setShown] = useState<Account | null>(null);
  const mounts = new Map((detail.data?.mounts ?? []).map((m) => [m.id, m.path]));
  // The live shows of the weekly schedule each DJ is part of.
  const showsOf = (id: string) => [...new Set((scheduler.data?.entries ?? []).filter((e) => e.live && e.enabled && e.accountIds.includes(id)).map((e) => e.name))];

  const reset = useMutation({
    mutationFn: (a: Account) => api<Account>(`/stations/${station.id}/accounts/${a.id}`, { method: 'PATCH', body: { resetPassword: true } }),
    onSuccess: (a) => setShown(a),
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (a: Account) => api(`/stations/${station.id}/accounts/${a.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('people.deleted'));
      void qc.invalidateQueries({ queryKey: ['accounts', station.id] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const live = status.data?.live ?? [];
  const settings = scheduler.data?.settings;

  return (
    <>
      <Header
        title={t('manage.menu.people')}
        description={t('manage.text.people')}
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus className="size-4" /> {t('people.add')}
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <Card className="p-5">
          <Label>{t('people.liveNow')}</Label>
          <div className="mt-3 flex flex-col gap-2">
            {!live.length && <p className="text-[13px] text-muted">{t('people.nobodyLive')}</p>}
            {live.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-md border border-koraal/40 bg-koraal/8 px-3 py-2 text-[13px]">
                <Mic className="size-4 text-accent-text" />
                <span className="font-semibold">{s.accountName}</span>
                <span className="font-mono text-muted">{s.mountPath}</span>
                <span className="text-muted">{t('people.since', { time: since(s.startedAt) })}</span>
                {s.userAgent && <span className="ml-auto truncate text-xs text-muted">{s.userAgent}</span>}
              </div>
            ))}
          </div>
          {settings && (
            <p className="mt-3 text-[12px] text-muted">
              {settings.liveOnlyInShows ? t('people.rulesShows', { minutes: settings.liveEarlyMinutes }) : t('people.rulesAnytime')}
            </p>
          )}
        </Card>

        <Card>
          {accounts.isPending ? (
            <div className="grid place-items-center py-10">
              <Spinner />
            </div>
          ) : (
            <Table
              head={[t('people.username'), t('people.rights'), t('people.shows'), t('people.linkedUser'), t('people.lastUsed'), '']}
              empty={!accounts.data?.length && <p className="px-5 py-8 text-center text-[13px] text-muted">{t('people.empty')}</p>}
            >
              {(accounts.data ?? []).map((a) => {
                const shows = showsOf(a.id);
                return (
                  <tr key={a.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold">{a.username}</span>
                        {!a.enabled && <Badge tone="offline">{t('people.off')}</Badge>}
                        {live.some((s) => s.accountName === a.username || s.accountName === a.displayName) && <Badge tone="accent">{t('people.live')}</Badge>}
                      </div>
                      {a.displayName && <div className="text-xs text-muted">{a.displayName}</div>}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {a.canBroadcast && <Badge tone="accent">{a.mountIds.length ? a.mountIds.map((id) => mounts.get(id)).join(', ') : t('people.broadcast')}</Badge>}
                        {a.canUpload && <Badge>{t('people.upload')}</Badge>}
                      </div>
                    </td>
                    <td className="max-w-56 truncate text-[13px] text-muted" title={shows.join(', ')}>
                      {shows.join(', ') || '—'}
                    </td>
                    <td className="text-[13px] text-muted">{a.userName ?? '—'}</td>
                    <td className="text-[13px] whitespace-nowrap text-muted">{day(a.lastUsedAt, i18n.language)}</td>
                    <td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" title={t('people.resetPassword')} onClick={() => void ask(t('people.resetConfirm', { name: a.username })).then((yes) => yes && reset.mutate(a))}>
                        <KeyRound className="size-4 text-muted" />
                      </Button>
                      <Button size="sm" variant="ghost" title={t('common.edit')} onClick={() => setEditing(a)}>
                        <Pencil className="size-4 text-muted" />
                      </Button>
                      <Button size="sm" variant="ghost" title={t('people.delete')} onClick={() => void ask(t('people.deleteConfirm', { name: a.username })).then((yes) => yes && remove.mutate(a))}>
                        <Trash2 className="size-4 text-offline" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
        <p className="text-[12px] text-muted">{t('people.hint')}</p>
      </div>
      <AccountDialog station={station} detail={detail.data} account={editing === 'new' ? null : editing} open={editing !== null} onClose={() => setEditing(null)} onCreated={setShown} />
      <PasswordDialog account={shown} onClose={() => setShown(null)} />
    </>
  );
}
