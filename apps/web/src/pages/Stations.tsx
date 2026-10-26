import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Radio } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Segmented, Select, Spinner, Table } from '../components/ui';
import { api, ApiError, type Edition, type StationDetail, type StationListItem, type Tenant } from '../lib/api';
import { isAdmin, useMe } from '../lib/auth';
import { slugify } from './Customers';

export function EditionBadge({ edition }: { edition: Edition }) {
  const { t } = useTranslation();
  return <Badge tone={edition === 'station' ? 'accent' : 'neutral'}>{t(`stations.edition.${edition}`)}</Badge>;
}

export function OnAirBadge({ station }: { station: Pick<StationListItem, 'enabled' | 'onAir'> }) {
  const { t } = useTranslation();
  if (!station.enabled) return <Badge tone="offline">{t('common.disabled')}</Badge>;
  return (
    <Badge tone={station.onAir ? 'online' : 'neutral'} dot>
      {station.onAir ? t('stations.onAir') : t('stations.offAir')}
    </Badge>
  );
}

/** Customers in which the current user may create stations: all for administrators, otherwise the ones they own. */
export function useCreatableTenants() {
  const me = useMe().data!;
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants') });
  const owned = new Set(me.memberships.filter((m) => m.role === 'owner').map((m) => m.tenantId));
  return (tenants.data ?? []).filter((t) => t.active && (isAdmin(me) || owned.has(t.id)));
}

export function CreateStationDialog({ open, onClose, tenantId }: { open: boolean; onClose: () => void; tenantId?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const tenants = useCreatableTenants();
  const [form, setForm] = useState({ tenantId: '', name: '', slug: '', edition: 'distribution' as Edition, bitrateKbps: 128 });
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm({ tenantId: tenantId ?? '', name: '', slug: '', edition: 'distribution', bitrateKbps: 128 });
      setSlugTouched(false);
      setError(null);
    }
  }, [open, tenantId]);
  const selected = tenants.find((x) => x.id === (form.tenantId || tenants[0]?.id));
  const maxBitrate = selected?.limits.maxBitrateKbps ?? 320;

  const create = useMutation({
    mutationFn: () =>
      api<StationDetail>('/stations', {
        method: 'POST',
        body: { tenantId: selected?.id, name: form.name, slug: form.slug, edition: form.edition, bitrateKbps: Math.min(form.bitrateKbps, maxBitrate) },
      }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['stations'] });
      onClose();
      navigate(`/stations/${s.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('stations.create')}
      description={t('stations.createHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="create-station" loading={create.isPending} disabled={!selected}>
            {t('stations.create')}
          </Button>
        </>
      }
    >
      <form
        id="create-station"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {!tenantId && (
          <Field label={t('fields.customer')}>
            <Select value={selected?.id ?? ''} onChange={(e) => setForm({ ...form, tenantId: e.target.value, edition: 'distribution' })}>
              {tenants.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fields.name')}>
            <Input
              required
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value, slug: slugTouched ? form.slug : slugify(e.target.value) })}
              placeholder="Harder.fm"
            />
          </Field>
          <Field label={t('fields.slug')} hint={t('stations.slugHint')}>
            <Input
              required
              value={form.slug}
              onChange={(e) => {
                setSlugTouched(true);
                setForm({ ...form, slug: e.target.value });
              }}
            />
          </Field>
        </div>
        <Field label={t('stations.editionLabel')} hint={selected?.plan !== 'station' ? t('stations.editionNeedsPlan') : undefined}>
          <Segmented
            value={form.edition}
            onChange={(edition) => selected?.plan === 'station' && setForm({ ...form, edition })}
            options={[
              { value: 'distribution', label: t('stations.edition.distribution'), description: t('stations.edition.distributionHint') },
              { value: 'station', label: t('stations.edition.station'), description: t('stations.edition.stationHint') },
            ]}
          />
        </Field>
        <Field label={t('stations.liveBitrate')} hint={t('stations.liveBitrateHint', { max: maxBitrate })}>
          <Select value={Math.min(form.bitrateKbps, maxBitrate)} onChange={(e) => setForm({ ...form, bitrateKbps: Number(e.target.value) })}>
            {[64, 96, 128, 192, 256, 320].filter((b) => b <= maxBitrate).map((b) => (
              <option key={b} value={b}>
                {b} kbps
              </option>
            ))}
          </Select>
        </Field>
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

export function StationsTable({ stations, showCustomer }: { stations: StationListItem[]; showCustomer: boolean }) {
  const { t } = useTranslation();
  return (
    <Table
      head={[t('fields.name'), ...(showCustomer ? [t('fields.customer')] : []), t('stations.editionLabel'), t('fields.status'), t('stations.listeners'), t('stations.mounts')]}
    >
      {stations.map((s) => (
        <tr key={s.id} className="hover:bg-hover/50">
          <td>
            <Link to={`/stations/${s.id}`} className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-chip text-accent-text">
                <Radio className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-semibold">{s.name}</span>
                <span className="block truncate font-mono text-xs text-muted">{s.slug}</span>
              </span>
            </Link>
          </td>
          {showCustomer && (
            <td>
              <Link to={`/customers/${s.tenantId}`} className="text-muted hover:text-ink">
                {s.tenantName}
              </Link>
            </td>
          )}
          <td>
            <EditionBadge edition={s.edition} />
          </td>
          <td>
            <OnAirBadge station={s} />
          </td>
          <td className="tabular-nums">
            {s.listeners ?? '—'} <span className="text-xs text-muted">/ {s.maxListeners}</span>
          </td>
          <td className="tabular-nums">{s.mountCount}</td>
        </tr>
      ))}
    </Table>
  );
}

export function StationsPage() {
  const { t } = useTranslation();
  const me = useMe().data!;
  const admin = isAdmin(me);
  const [params] = useSearchParams();
  const tenantId = params.get('tenantId') ?? undefined;
  const [creating, setCreating] = useState(false);
  const stations = useQuery({
    queryKey: ['stations', tenantId ?? 'all'],
    queryFn: () => api<StationListItem[]>(`/stations${tenantId ? `?tenantId=${tenantId}` : ''}`),
    refetchInterval: 15_000,
  });
  const canCreate = useCreatableTenants().length > 0;
  const showCustomer = admin || me.memberships.length > 1;

  return (
    <>
      <PageHeader
        title={t('stations.title')}
        description={t('stations.subtitle')}
        actions={
          canCreate && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" /> {t('stations.create')}
            </Button>
          )
        }
      />
      <Card>
        {stations.isPending ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : stations.data?.length ? (
          <StationsTable stations={stations.data} showCustomer={showCustomer} />
        ) : (
          <EmptyState
            icon={<Radio className="size-5" />}
            title={t('stations.empty')}
            description={t('stations.emptyHint')}
            action={
              canCreate && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus className="size-4" /> {t('stations.create')}
                </Button>
              )
            }
          />
        )}
      </Card>
      <CreateStationDialog open={creating} onClose={() => setCreating(false)} tenantId={tenantId} />
    </>
  );
}
