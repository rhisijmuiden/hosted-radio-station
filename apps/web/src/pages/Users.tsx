import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Search, Send, Trash2, Users as UsersIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Avatar, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Switch, Table } from '../components/ui';
import { api, ApiError, type UserDetail } from '../lib/api';
import { useMailConfigured, useMe } from '../lib/auth';
import { formatDate } from '../lib/format';

function UserDialog({ user, open, onClose }: { user: UserDetail | null; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const mail = useMailConfigured();
  const [form, setForm] = useState({ name: '', email: '', password: '', isSuperadmin: false, active: true, locale: 'en', sendInvite: false });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      user
        ? { name: user.name, email: user.email, password: '', isSuperadmin: user.isSuperadmin, active: user.active, locale: user.locale, sendInvite: false }
        : { name: '', email: '', password: '', isSuperadmin: false, active: true, locale: 'en', sendInvite: mail },
    );
  }, [open, user, mail]);

  const save = useMutation({
    mutationFn: () => {
      const { sendInvite, ...rest } = form;
      const body = { ...rest, password: form.password || undefined };
      return user ? api(`/users/${user.id}`, { method: 'PATCH', body }) : api('/users', { method: 'POST', body: { ...body, active: undefined, sendInvite } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(user ? t('common.saved') : form.sendInvite ? t('invite.sent', { email: form.email }) : t('users.created'));
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const invite = useMutation({
    mutationFn: () => api(`/users/${user!.id}/invite`, { method: 'POST' }),
    onSuccess: () => toast.success(t('invite.sent', { email: user!.email })),
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={user ? t('users.edit') : t('users.new')}
      footer={
        <>
          {user && mail && (
            <Button className="sm:mr-auto" onClick={() => invite.mutate()} loading={invite.isPending}>
              <Send className="size-4" /> {t('invite.resend')}
            </Button>
          )}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="user-form" loading={save.isPending}>
            {user ? t('common.save') : t('users.create')}
          </Button>
        </>
      }
    >
      <form
        id="user-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fields.name')}>
            <Input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t('fields.email')}>
            <Input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
        </div>
        {!user && (
          <Switch
            checked={form.sendInvite}
            disabled={!mail}
            onChange={(sendInvite) => setForm({ ...form, sendInvite })}
            label={t('invite.send')}
            description={mail ? t('invite.sendHint') : t('invite.needsMail')}
          />
        )}
        {(user || !form.sendInvite) && (
          <Field label={user ? t('users.newPassword') : t('fields.password')} hint={user ? t('users.newPasswordHint') : t('members.passwordHint')}>
            <Input type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        )}
        <Field label={t('fields.language')}>
          <Select value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}>
            <option value="en">English</option>
            <option value="nl">Nederlands</option>
          </Select>
        </Field>
        <Switch checked={form.isSuperadmin} onChange={(isSuperadmin) => setForm({ ...form, isSuperadmin })} label={t('roles.superadmin')} description={t('roles.superadminHint')} />
        {user && <Switch checked={form.active} onChange={(active) => setForm({ ...form, active })} label={t('users.active')} description={t('users.activeHint')} />}
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

export function UsersPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe().data!;
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<UserDetail | null>(null);
  const [open, setOpen] = useState(false);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserDetail[]>('/users') });

  const del = useMutation({
    mutationFn: (id: string) => api(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) => toast.error((err as Error).message),
  });

  const list = (users.data ?? []).filter((u) => !query || `${u.name} ${u.email}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <>
      <PageHeader
        title={t('nav.users')}
        description={t('users.subtitle')}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            + {t('users.new')}
          </Button>
        }
      />
      <Card>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Search className="size-4 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('users.search')} className="h-8 flex-1 bg-transparent text-sm placeholder:text-muted focus:outline-none" />
        </div>
        {users.isPending ? (
          <div className="grid place-items-center py-12">
            <Spinner />
          </div>
        ) : list.length === 0 ? (
          <EmptyState icon={<UsersIcon className="size-6" />} title={t('common.noResults')} />
        ) : (
          <Table head={[t('fields.user'), t('fields.role'), t('nav.customers'), t('fields.lastLogin'), '']}>
            {list.map((u) => (
              <tr key={u.id} className="hover:bg-hover/60">
                <td>
                  <div className="flex items-center gap-3">
                    <Avatar name={u.name} className="size-8 text-xs" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 truncate font-semibold">
                        {u.name}
                        {u.id === me.user.id && <span className="text-xs font-normal text-muted">({t('users.you')})</span>}
                      </div>
                      <div className="truncate text-xs text-muted">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {u.isSuperadmin && <Badge tone="accent">{t('roles.superadmin')}</Badge>}
                    {!u.active && <Badge tone="offline">{t('common.disabled')}</Badge>}
                    {!u.isSuperadmin && u.active && <Badge>{t('roles.user')}</Badge>}
                  </div>
                </td>
                <td className="max-w-64">
                  <div className="flex flex-wrap gap-1">
                    {u.memberships.length === 0 && <span className="text-muted">—</span>}
                    {u.memberships.map((m) => (
                      <Link key={m.tenantId} to={`/customers/${m.tenantId}`} className="rounded-full bg-chip px-2 py-0.5 text-[11px] hover:underline">
                        {m.tenantName} · {t(`roles.${m.role}`)}
                      </Link>
                    ))}
                  </div>
                </td>
                <td className="whitespace-nowrap text-muted">{formatDate(u.lastLoginAt)}</td>
                <td className="text-right whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="ghost"
                    title={t('users.edit')}
                    onClick={() => {
                      setEditing(u);
                      setOpen(true);
                    }}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  {u.id !== me.user.id && (
                    <Button size="sm" variant="ghost" title={t('common.delete')} onClick={() => confirm(t('users.deleteConfirm', { name: u.name })) && del.mutate(u.id)}>
                      <Trash2 className="size-4 text-offline" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <UserDialog user={editing} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
