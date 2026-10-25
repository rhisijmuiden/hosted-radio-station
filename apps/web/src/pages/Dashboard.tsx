import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Building2, Check, DatabaseBackup, Globe, KeyRound, Mail, Radio, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useSystemInfo } from '../components/InfoDialog';
import { Badge, Button, Card, CardHeader, PageHeader, Table } from '../components/ui';
import { api, type ApiKey, type BackupTarget, type ProxySettings, type SmtpSettings, type Tenant, type UserDetail } from '../lib/api';
import { isAdmin, useMe } from '../lib/auth';
import { formatRelative, shortCommit } from '../lib/format';

function Stat({ label, value, note, tone = 'online' }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'online' | 'muted' | 'warning' }) {
  return (
    <Card className="p-[18px]">
      <div className="text-xs text-muted">{label}</div>
      <div className="display mt-1.5 text-[30px] leading-none">{value}</div>
      {note && <div className={clsx('mt-2 text-xs', tone === 'online' ? 'text-online' : tone === 'warning' ? 'text-warning' : 'text-muted')}>{note}</div>}
    </Card>
  );
}

function SystemRow({ label, value, tone }: { label: ReactNode; value: ReactNode; tone: 'online' | 'warning' | 'offline' | 'muted' }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0">
      <span>{label}</span>
      <span className={clsx('text-xs font-semibold', tone === 'online' && 'text-online', tone === 'warning' && 'text-warning', tone === 'offline' && 'text-offline', tone === 'muted' && 'text-muted')}>
        {value}
      </span>
    </div>
  );
}

export function PlanBadge({ plan }: { plan: Tenant['plan'] }) {
  const { t } = useTranslation();
  return <Badge tone={plan === 'station' ? 'accent' : 'neutral'}>{t(`plans.${plan}`)}</Badge>;
}

function AdminDashboard() {
  const { t } = useTranslation();
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserDetail[]>('/users') });
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api<ApiKey[]>('/api-keys') });
  const smtp = useQuery({ queryKey: ['settings', 'smtp'], queryFn: () => api<SmtpSettings>('/settings/smtp') });
  const proxy = useQuery({ queryKey: ['settings', 'proxy'], queryFn: () => api<ProxySettings>('/settings/proxy') });
  const backups = useQuery({ queryKey: ['backup-targets'], queryFn: () => api<BackupTarget[]>('/backups/targets') });
  const lastBackup = (backups.data ?? [])
    .map((b) => b.lastSuccess?.finishedAt)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1);
  const backupFailing = (backups.data ?? []).some((b) => b.lastRun?.state === 'failed');
  const info = useSystemInfo();

  const list = tenants.data ?? [];
  const stations = list.filter((x) => x.plan === 'station').length;
  const steps = [
    { done: !!smtp.data?.enabled, label: t('dashboard.stepMail'), to: '/settings/mail', icon: Mail },
    { done: !!proxy.data?.domain || proxy.data?.mode === 'external', label: t('dashboard.stepWeb'), to: '/settings/web-server', icon: Globe },
    { done: (backups.data?.length ?? 0) > 0, label: t('dashboard.stepBackup'), to: '/settings/backups', icon: DatabaseBackup },
    { done: list.length > 0, label: t('dashboard.stepCustomer'), to: '/customers', icon: Building2 },
    { done: (keys.data?.length ?? 0) > 0, label: t('dashboard.stepApiKey'), to: '/api-keys', icon: KeyRound },
  ];
  const todo = steps.filter((s) => !s.done).length;
  const update = info.data?.lastCheck;

  return (
    <>
      <PageHeader
        title={t('nav.dashboard')}
        description={t('dashboard.subtitle')}
        actions={
          <Link to="/customers?new=1">
            <Button variant="primary">+ {t('customers.new')}</Button>
          </Link>
        }
      />
      <section className="mb-4 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Stat label={t('dashboard.customers')} value={tenants.data ? list.length : '…'} note={t('dashboard.activeCount', { count: list.filter((x) => x.active).length })} />
        <Stat label={t('dashboard.radioStations')} value={tenants.data ? stations : '…'} note={t('dashboard.distributionCount', { count: list.length - stations })} tone="muted" />
        <Stat label={t('dashboard.users')} value={users.data?.length ?? '…'} note={t('dashboard.adminCount', { count: users.data?.filter((u) => u.isSuperadmin).length ?? 0 })} tone="muted" />
        <Stat label={t('dashboard.apiKeys')} value={keys.data?.length ?? '…'} note={t('dashboard.apiKeysNote')} tone="muted" />
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader
            title={t('nav.customers')}
            actions={
              <Link to="/customers" className="inline-flex items-center gap-1 text-[13px] font-semibold text-accent-text hover:underline">
                {t('common.viewAll')} <ArrowRight className="size-3.5" />
              </Link>
            }
          />
          {list.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <div className="mb-3 grid size-12 place-items-center rounded-full bg-chip text-accent-text">
                <Radio className="size-6" />
              </div>
              <div className="display text-base">{t('dashboard.noCustomers')}</div>
              <p className="mt-1 max-w-sm text-[13px] text-muted">{t('dashboard.noCustomersText')}</p>
            </div>
          ) : (
            <Table head={[t('fields.customer'), t('fields.plan'), t('fields.users'), t('fields.status')]}>
              {list.slice(0, 6).map((c) => (
                <tr key={c.id} className="hover:bg-hover/60">
                  <td>
                    <Link to={`/customers/${c.id}`} className="flex items-center gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-nacht text-[13px] font-bold text-white dark:bg-chip">
                        {c.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{c.name}</span>
                        <span className="block truncate text-xs text-muted">{c.slug}</span>
                      </span>
                    </Link>
                  </td>
                  <td>
                    <PlanBadge plan={c.plan} />
                  </td>
                  <td>{c.memberCount}</td>
                  <td>
                    <Badge tone={c.active ? 'online' : 'offline'} dot>
                      {c.active ? t('common.active') : t('common.suspended')}
                    </Badge>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          {todo > 0 && (
            <Card className="p-5">
              <h2 className="display mb-1 text-base">{t('dashboard.gettingStarted')}</h2>
              <p className="mb-3 text-[13px] text-muted">{t('dashboard.stepsLeft', { count: todo })}</p>
              <ul className="flex flex-col gap-1">
                {steps.map((s) => (
                  <li key={s.to}>
                    <Link to={s.to} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-hover">
                      <span className={clsx('grid size-6 place-items-center rounded-full', s.done ? 'bg-online text-white' : 'border border-line text-muted')}>
                        {s.done ? <Check className="size-3.5" strokeWidth={3} /> : <s.icon className="size-3.5" />}
                      </span>
                      <span className={clsx('flex-1', s.done && 'text-muted line-through')}>{s.label}</span>
                      {!s.done && <ArrowRight className="size-4 text-muted" />}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card className="p-5">
            <h2 className="display mb-2 text-base">{t('dashboard.system')}</h2>
            <SystemRow label={t('dashboard.api')} value={t('dashboard.running')} tone="online" />
            <SystemRow
              label={t('dashboard.version')}
              value={info.data ? `v${info.data.version} · ${shortCommit(info.data.commit)}` : '…'}
              tone="muted"
            />
            <SystemRow
              label={t('dashboard.updates')}
              value={update?.error ? t('dashboard.checkFailed') : update?.updateAvailable ? t('dashboard.updateAvailable') : update ? t('dashboard.upToDate') : '…'}
              tone={update?.error ? 'offline' : update?.updateAvailable ? 'warning' : 'online'}
            />
            <SystemRow
              label={t('nav.webServer')}
              value={proxy.data ? (proxy.data.mode === 'external' ? t('webServer.external') : proxy.data.domain || t('webServer.noDomain')) : '…'}
              tone={proxy.data?.mode === 'builtin' && !proxy.data.domain ? 'warning' : 'online'}
            />
            <SystemRow
              label={t('nav.mail')}
              value={smtp.data ? (smtp.data.enabled ? smtp.data.host : t('dashboard.notConfigured')) : '…'}
              tone={smtp.data?.enabled ? 'online' : 'warning'}
            />
            <SystemRow
              label={t('dashboard.lastBackup')}
              value={backups.data ? (backupFailing ? t('dashboard.backupFailing') : lastBackup ? formatRelative(lastBackup) : t('dashboard.never')) : '…'}
              tone={backupFailing ? 'offline' : lastBackup ? 'online' : 'warning'}
            />
          </Card>
        </div>
      </div>
    </>
  );
}

function MemberDashboard() {
  const { t } = useTranslation();
  const me = useMe().data!;
  return (
    <>
      <PageHeader title={t('dashboard.welcome', { name: me.user.name.split(' ')[0] })} description={t('dashboard.memberSubtitle')} />
      {me.memberships.length === 0 ? (
        <Card className="p-8 text-center text-muted">{t('dashboard.noMemberships')}</Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {me.memberships.map((m) => (
            <Link key={m.tenantId} to={`/customers/${m.tenantId}`}>
              <Card className="p-5 transition-colors hover:bg-hover/60">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-[10px] bg-nacht font-bold text-white dark:bg-chip">{m.tenantName.slice(0, 1)}</span>
                  <div className="min-w-0">
                    <div className="display truncate text-base">{m.tenantName}</div>
                    <div className="text-xs text-muted">{t(`roles.${m.role}`)}</div>
                  </div>
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <PlanBadge plan={m.plan} />
                  <span className="inline-flex items-center gap-1 text-xs text-muted">
                    <Users className="size-3.5" /> {t('common.open')}
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function DashboardPage() {
  const me = useMe().data;
  return isAdmin(me) ? <AdminDashboard /> : <MemberDashboard />;
}
