import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Send, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Avatar, Badge, Button, Card, CardHeader, Dialog, Field, Input, PageHeader, Select, Spinner, Switch, Table, Tabs } from '../components/ui';
import { CustomerPermissions } from '../components/CustomerPermissions';
import { AuditLogView } from '../components/AuditLog';
import { SsoCard } from '../components/SsoCard';
import { SubscriptionPanel, TenantInvoicesCard } from '../components/billing';
import { DomainsCard, UsageCard } from '../components/DomainsCard';
import { CustomerStationNodeCard } from '../components/station/CustomerNode';
import { api, ApiError, type Member, type Role, type StationListItem, type Tenant } from '../lib/api';
import { isAdmin, useMailConfigured, useMe } from '../lib/auth';
import { formatDate } from '../lib/format';
import { LimitsFields } from './Customers';
import { LimitsBadge } from './Dashboard';
import { CreateStationDialog, StationsTable } from './Stations';

const ROLES: Role[] = ['owner', 'manager', 'dj'];
const rank: Record<Role | 'superadmin', number> = { dj: 1, manager: 2, owner: 3, superadmin: 4 };

function DetailsCard({ tenant, admin, canEdit }: { tenant: Tenant; admin: boolean; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(tenant);
  useEffect(() => setDraft(tenant), [tenant]);

  const save = useMutation({
    mutationFn: () =>
      api<Tenant>(`/tenants/${tenant.id}`, {
        method: 'PATCH',
        body: admin
          ? { name: draft.name, slug: draft.slug, limits: draft.limits, active: draft.active, externalRef: draft.externalRef || null }
          : { name: draft.name },
      }),
    onSuccess: (res) => {
      qc.setQueryData(['tenant', tenant.id], res);
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Card>
      <CardHeader title={t('customers.details')} />
      <form onSubmit={submit} className="flex flex-col gap-5 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fields.name')}>
            <Input required disabled={!canEdit} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label={t('fields.slug')}>
            <Input required disabled={!admin} value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
          </Field>
        </div>
        <div>
          <div className="mb-2 text-[13px] font-semibold">{t('customers.limits')}</div>
          <LimitsFields value={draft.limits} onChange={(limits) => setDraft({ ...draft, limits })} disabled={!admin} />
        </div>
        {admin && (
          <>
            <Field label={t('fields.externalRef')} hint={t('customers.externalRefHint')}>
              <Input value={draft.externalRef ?? ''} onChange={(e) => setDraft({ ...draft, externalRef: e.target.value })} />
            </Field>
            <Switch checked={draft.active} onChange={(active) => setDraft({ ...draft, active })} label={t('customers.active')} description={t('customers.activeHint')} />
          </>
        )}
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

function AddMemberDialog({ tenantId, open, onClose, grantable }: { tenantId: string; open: boolean; onClose: () => void; grantable: Role[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const mail = useMailConfigured();
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'dj' as Role, sendInvite: false });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm({ email: '', name: '', password: '', role: 'dj', sendInvite: mail });
      setError(null);
    }
  }, [open, mail]);

  const add = useMutation({
    mutationFn: () =>
      api<Member>(`/tenants/${tenantId}/members`, {
        method: 'POST',
        body: { email: form.email, name: form.name || undefined, password: form.password || undefined, role: form.role, sendInvite: form.sendInvite },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['members', tenantId] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      toast.success(form.sendInvite ? t('invite.sent', { email: form.email }) : t('members.added'));
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('members.add')}
      description={t('members.addHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="add-member" loading={add.isPending}>
            {t('members.add')}
          </Button>
        </>
      }
    >
      <form
        id="add-member"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label={t('fields.email')}>
          <Input required type="email" autoFocus value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label={t('fields.name')} hint={t('members.nameHint')}>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Switch
          checked={form.sendInvite}
          disabled={!mail}
          onChange={(v) => setForm({ ...form, sendInvite: v })}
          label={t('invite.send')}
          description={mail ? t('invite.sendHint') : t('invite.needsMail')}
        />
        {!form.sendInvite && (
          <Field label={t('fields.password')} hint={t('members.passwordHint')}>
            <Input type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        )}
        <Field label={t('fields.role')} hint={t(`roles.${form.role}Hint`)}>
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {grantable.map((r) => (
              <option key={r} value={r}>
                {t(`roles.${r}`)}
              </option>
            ))}
          </Select>
        </Field>
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

function MembersCard({ tenantId, myRole }: { tenantId: string; myRole: Role | 'superadmin' }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe().data!;
  const [adding, setAdding] = useState(false);
  const members = useQuery({ queryKey: ['members', tenantId], queryFn: () => api<Member[]>(`/tenants/${tenantId}/members`) });
  const grantable = ROLES.filter((r) => rank[r] <= rank[myRole]);

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) => api(`/tenants/${tenantId}/members/${userId}`, { method: 'PUT', body: { role } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members', tenantId] }),
    onError: (err) => toast.error((err as Error).message),
  });
  const mail = useMailConfigured();
  const invite = useMutation({
    mutationFn: (m: Member) => api(`/tenants/${tenantId}/members/${m.user.id}/invite`, { method: 'POST' }),
    onSuccess: (_res, m) => toast.success(t('invite.sent', { email: m.user.email })),
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api(`/tenants/${tenantId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['members', tenantId] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Card>
      <CardHeader
        title={t('members.title')}
        description={t('members.subtitle')}
        actions={
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            <UserPlus className="size-4" /> {t('members.add')}
          </Button>
        }
      />
      {members.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <Table head={[t('fields.user'), t('fields.role'), t('fields.lastLogin'), '']}>
          {(members.data ?? []).map((m) => {
            const editable = rank[m.role] <= rank[myRole] && m.user.id !== me.user.id;
            return (
              <tr key={m.user.id}>
                <td>
                  <div className="flex items-center gap-3">
                    <Avatar name={m.user.name} className="size-8 text-xs" />
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{m.user.name}</div>
                      <div className="truncate text-xs text-muted">{m.user.email}</div>
                    </div>
                    {!m.user.active && <Badge tone="offline">{t('common.disabled')}</Badge>}
                  </div>
                </td>
                <td>
                  {editable ? (
                    <Select className="h-8 w-36 text-[13px]" value={m.role} onChange={(e) => changeRole.mutate({ userId: m.user.id, role: e.target.value as Role })}>
                      {grantable.map((r) => (
                        <option key={r} value={r}>
                          {t(`roles.${r}`)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Badge>{t(`roles.${m.role}`)}</Badge>
                  )}
                </td>
                <td className="whitespace-nowrap text-muted">{formatDate(m.user.lastLoginAt)}</td>
                <td className="text-right whitespace-nowrap">
                  {editable && mail && !m.user.isSuperadmin && (
                    <Button size="sm" variant="ghost" title={t('invite.resend')} onClick={() => invite.mutate(m)}>
                      <Send className="size-4 text-muted" />
                    </Button>
                  )}
                  {editable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      title={t('members.remove')}
                      onClick={() => confirm(t('members.removeConfirm', { name: m.user.name })) && remove.mutate(m.user.id)}
                    >
                      <Trash2 className="size-4 text-offline" />
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <AddMemberDialog tenantId={tenantId} open={adding} onClose={() => setAdding(false)} grantable={grantable} />
    </Card>
  );
}

function StationsCard({ tenantId, canCreate }: { tenantId: string; canCreate: boolean }) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const stations = useQuery({ queryKey: ['stations', tenantId], queryFn: () => api<StationListItem[]>(`/stations?tenantId=${tenantId}`), refetchInterval: 15_000 });
  return (
    <Card>
      <CardHeader
        title={t('nav.stations')}
        description={t('stations.customerSubtitle')}
        actions={
          canCreate && (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" /> {t('stations.create')}
            </Button>
          )
        }
      />
      {stations.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : stations.data?.length ? (
        <StationsTable stations={stations.data} showCustomer={false} />
      ) : (
        <p className="px-5 py-8 text-center text-[13px] text-muted">{t('stations.empty')}</p>
      )}
      <CreateStationDialog open={creating} onClose={() => setCreating(false)} tenantId={tenantId} />
    </Card>
  );
}

export function CustomerDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe().data!;
  const admin = isAdmin(me);
  const tenant = useQuery({ queryKey: ['tenant', id], queryFn: () => api<Tenant>(`/tenants/${id}`) });
  const myRole: Role | 'superadmin' = admin ? 'superadmin' : (me.memberships.find((m) => m.tenantId === id)?.role ?? 'dj');
  // Administrators get a second tab with what this customer may do (customer permissions).
  const [params, setParams] = useSearchParams();
  const tab = admin && params.get('tab') === 'permissions' ? 'permissions' : 'overview';

  const del = useMutation({
    mutationFn: () => api(`/tenants/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      toast.success(t('customers.deleted'));
      navigate('/customers');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (tenant.isPending) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  if (!tenant.data) return <Card className="p-8 text-center text-muted">{(tenant.error as Error)?.message}</Card>;
  const c = tenant.data;

  return (
    <>
      <Link to="/customers" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> {admin ? t('nav.customers') : t('nav.myCustomers')}
      </Link>
      <PageHeader
        title={c.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <LimitsBadge limits={c.limits} />
            <Badge tone={c.active ? 'online' : 'offline'} dot>
              {c.active ? t('common.active') : t('common.suspended')}
            </Badge>
            <span className="text-xs">{t('customers.since', { date: formatDate(c.createdAt, false) })}</span>
          </span>
        }
      />
      {admin && (
        <Tabs
          value={tab}
          onChange={(v) => setParams(v === 'overview' ? {} : { tab: v }, { replace: true })}
          tabs={[
            { value: 'overview', label: t('permissions.tabOverview') },
            { value: 'permissions', label: t('permissions.tab') },
          ]}
        />
      )}
      {tab === 'permissions' && <CustomerPermissions tenant={c} />}
      {tab === 'overview' && (
      <>
      <div className="mb-4">
        <StationsCard tenantId={c.id} canCreate={c.active && rank[myRole] >= rank.owner} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
        <div className="flex flex-col gap-4">
          {(admin || me.memberships.find((m) => m.tenantId === c.id)?.billed) && rank[myRole] >= rank.manager && (
            <SubscriptionPanel tenantId={c.id} admin={admin} canEdit={rank[myRole] >= rank.owner} compact />
          )}
          <DetailsCard tenant={c} admin={admin} canEdit={rank[myRole] >= rank.owner} />
          <UsageCard tenantId={c.id} />
          {admin && <TenantInvoicesCard tenantId={c.id} admin />}
        </div>
        <div className="flex flex-col gap-4">
          {rank[myRole] >= rank.manager && <DomainsCard tenantId={c.id} canEdit={rank[myRole] >= rank.owner} admin={admin} />}
          {rank[myRole] >= rank.manager && <MembersCard tenantId={c.id} myRole={myRole} />}
          {rank[myRole] >= rank.owner && <CustomerStationNodeCard tenant={c} canEdit={rank[myRole] >= rank.owner} />}
          {rank[myRole] >= rank.owner && <SsoCard tenantId={c.id} admin={admin} />}
          {admin && (
            <Card className="border-offline/30 p-5">
              <h2 className="display text-base text-offline">{t('customers.dangerZone')}</h2>
              <p className="mt-1 mb-4 text-[13px] text-muted">{t('customers.deleteHint')}</p>
              <Button variant="danger" loading={del.isPending} onClick={() => prompt(t('customers.deleteConfirm', { slug: c.slug })) === c.slug && del.mutate()}>
                <Trash2 className="size-4" /> {t('customers.delete')}
              </Button>
            </Card>
          )}
        </div>
      </div>
      {rank[myRole] >= rank.manager && (
        <Card className="mt-4">
          <CardHeader title={t('nav.auditLog')} description={t('audit.customerSubtitle')} />
          <AuditLogView tenantId={c.id} compact />
        </Card>
      )}
      </>
      )}
    </>
  );
}
