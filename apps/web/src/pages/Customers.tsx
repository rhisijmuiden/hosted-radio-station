import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Search } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Segmented, Spinner, Switch, Table } from '../components/ui';
import { api, ApiError, type Plan, type Tenant, type TenantLimits } from '../lib/api';
import { isAdmin, useMailConfigured, useMe } from '../lib/auth';
import { formatDate } from '../lib/format';
import { PlanBadge } from './Dashboard';

export const defaultLimits: TenantLimits = { maxStations: 1, maxListeners: 100, maxBitrateKbps: 192, storageQuotaMb: 10240 };

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

export function LimitsFields({ value, onChange, disabled }: { value: TenantLimits; onChange: (v: TenantLimits) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const num = (key: keyof TenantLimits) => ({
    type: 'number',
    min: 0,
    disabled,
    value: value[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [key]: Number(e.target.value) }),
  });
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={t('limits.maxStations')}>
        <Input {...num('maxStations')} />
      </Field>
      <Field label={t('limits.maxListeners')}>
        <Input {...num('maxListeners')} />
      </Field>
      <Field label={t('limits.maxBitrate')}>
        <Input {...num('maxBitrateKbps')} min={32} max={512} />
      </Field>
      <Field label={t('limits.storage')}>
        <Input {...num('storageQuotaMb')} />
      </Field>
    </div>
  );
}

export function PlanPicker({ value, onChange }: { value: Plan; onChange: (p: Plan) => void }) {
  const { t } = useTranslation();
  return (
    <Segmented
      value={value}
      onChange={onChange}
      options={[
        { value: 'distribution', label: t('plans.distribution'), description: t('plans.distributionHint') },
        { value: 'station', label: t('plans.station'), description: t('plans.stationHint') },
      ]}
    />
  );
}

function NewCustomerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [plan, setPlan] = useState<Plan>('distribution');
  const [limits, setLimits] = useState(defaultLimits);
  const [withOwner, setWithOwner] = useState(true);
  const mail = useMailConfigured();
  const [owner, setOwner] = useState({ name: '', email: '', password: '', sendInvite: false });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSlug('');
    setSlugTouched(false);
    setPlan('distribution');
    setLimits(defaultLimits);
    setOwner({ name: '', email: '', password: '', sendInvite: mail });
    setError(null);
  }, [open, mail]);

  const create = useMutation({
    mutationFn: () =>
      api<Tenant>('/tenants', {
        method: 'POST',
        body: {
          name,
          slug,
          plan,
          limits,
          owner: withOwner ? { name: owner.name, email: owner.email, password: owner.password || undefined, sendInvite: owner.sendInvite } : undefined,
        },
      }),
    onSuccess: (tenant) => {
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      toast.success(t('customers.created', { name: tenant.name }));
      onClose();
      navigate(`/customers/${tenant.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={t('customers.new')}
      description={t('customers.newHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="new-customer" loading={create.isPending}>
            {t('customers.create')}
          </Button>
        </>
      }
    >
      <form id="new-customer" onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fields.name')}>
            <Input
              required
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="Harder.fm"
            />
          </Field>
          <Field label={t('fields.slug')} hint={t('customers.slugHint')}>
            <Input
              required
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              placeholder="harder-fm"
            />
          </Field>
        </div>
        <Field label={t('fields.plan')}>
          <PlanPicker value={plan} onChange={setPlan} />
        </Field>
        <div>
          <div className="mb-2 text-[13px] font-semibold">{t('customers.limits')}</div>
          <LimitsFields value={limits} onChange={setLimits} />
        </div>
        <div className="rounded-md border border-line p-4">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={withOwner} onChange={(e) => setWithOwner(e.target.checked)} className="size-4 accent-[var(--koraal)]" />
            {t('customers.withOwner')}
          </label>
          {withOwner && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label={t('fields.name')}>
                <Input required value={owner.name} onChange={(e) => setOwner({ ...owner, name: e.target.value })} />
              </Field>
              <Field label={t('fields.email')}>
                <Input required type="email" value={owner.email} onChange={(e) => setOwner({ ...owner, email: e.target.value })} />
              </Field>
              <div className="sm:col-span-2">
                <Switch
                  checked={owner.sendInvite}
                  disabled={!mail}
                  onChange={(sendInvite) => setOwner({ ...owner, sendInvite })}
                  label={t('invite.send')}
                  description={mail ? t('invite.sendHint') : t('invite.needsMail')}
                />
              </div>
              {!owner.sendInvite && (
                <Field label={t('fields.password')} hint={t('customers.ownerPasswordHint')} className="sm:col-span-2">
                  <Input type="password" autoComplete="new-password" minLength={10} value={owner.password} onChange={(e) => setOwner({ ...owner, password: e.target.value })} />
                </Field>
              )}
            </div>
          )}
        </div>
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

export function CustomersPage() {
  const { t } = useTranslation();
  const admin = isAdmin(useMe().data);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants') });
  const open = params.get('new') === '1';
  const setOpen = (v: boolean) => setParams(v ? { new: '1' } : {}, { replace: true });

  const list = (tenants.data ?? []).filter((c) => !query || `${c.name} ${c.slug} ${c.externalRef ?? ''}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <>
      <PageHeader
        title={admin ? t('nav.customers') : t('nav.myCustomers')}
        description={admin ? t('customers.subtitle') : t('customers.memberSubtitle')}
        actions={
          admin && (
            <Button variant="primary" onClick={() => setOpen(true)}>
              + {t('customers.new')}
            </Button>
          )
        }
      />
      <Card>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Search className="size-4 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('customers.search')}
            className="h-8 flex-1 bg-transparent text-sm placeholder:text-muted focus:outline-none"
          />
        </div>
        {tenants.isPending ? (
          <div className="grid place-items-center py-12">
            <Spinner />
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Building2 className="size-6" />}
            title={query ? t('common.noResults') : t('dashboard.noCustomers')}
            description={!query && admin ? t('dashboard.noCustomersText') : undefined}
            action={!query && admin ? <Button variant="primary" onClick={() => setOpen(true)}>+ {t('customers.new')}</Button> : undefined}
          />
        ) : (
          <Table head={[t('fields.customer'), t('fields.plan'), t('fields.users'), t('fields.listeners'), t('fields.created'), t('fields.status')]}>
            {list.map((c) => (
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
                <td className="text-muted">≤ {c.limits.maxListeners.toLocaleString()}</td>
                <td className="whitespace-nowrap text-muted">{formatDate(c.createdAt, false)}</td>
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
      {admin && <NewCustomerDialog open={open} onClose={() => setOpen(false)} />}
    </>
  );
}
