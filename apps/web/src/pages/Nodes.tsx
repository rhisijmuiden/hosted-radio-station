import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpCircle, Network, Plus, Server, Settings2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { formatBps, formatMs, HealthBadge, nodeHealth, PairingPanel, RoleBadges } from '../components/nodes/common';
import { ScopeBadge } from '../components/nodes/Dedication';
import { NodeHierarchy } from '../components/nodes/Hierarchy';
import { RolloutCard, UpdateBadge } from '../components/nodes/updates';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Switch, Table } from '../components/ui';
import { api, ApiError, type NodeItem, type NodePairing, type NodeRole, type NodesSettings, type StationListItem, type Tenant } from '../lib/api';
import { isAdmin, useMe } from '../lib/auth';
import { OrchestratorOnlyCard } from '../components/nodes/OrchestratorOnly';

export const ROLES: NodeRole[] = ['relay', 'source', 'station', 'fm'];

/** Role toggles with a line on what each role does. */
export function RolePicker({ value, onChange }: { value: NodeRole[]; onChange: (v: NodeRole[]) => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {ROLES.map((r) => {
        const on = value.includes(r);
        return (
          <button
            key={r}
            type="button"
            aria-pressed={on}
            // A station node does nothing else: its streams go to relay nodes.
            onClick={() => onChange(on ? value.filter((x) => x !== r) : r === 'station' ? ['station'] : [...value.filter((x) => x !== 'station'), r])}
            className={clsx('rounded-md border p-3 text-left transition-colors', on ? 'border-koraal bg-koraal/8 ring-1 ring-koraal' : 'border-line hover:bg-hover')}
          >
            <div className="text-sm font-semibold">{t(`nodes.roles.${r}`)}</div>
            <div className="mt-0.5 text-xs text-muted">{t(`nodes.roleHints.${r}`)}</div>
          </button>
        );
      })}
    </div>
  );
}

function AddNodeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe().data!;
  const admin = isAdmin(me);
  const ownerTenants = me.memberships.filter((m) => m.role === 'owner');
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants'), enabled: open && admin });
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [roles, setRoles] = useState<NodeRole[]>(['relay']);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ node: NodeItem; pairing: NodePairing } | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setLocation('');
    setTenantId(admin ? '' : (ownerTenants[0]?.tenantId ?? ''));
    setRoles(['relay']);
    setError(null);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = useMutation({
    mutationFn: () => api<{ node: NodeItem; pairing: NodePairing }>('/nodes', { method: 'POST', body: { name, location, tenantId: tenantId || null, roles } }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      setResult(res);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate();
  };

  if (result) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        wide
        title={t('nodes.add.readyTitle', { name: result.node.name })}
        description={t('nodes.add.readyHint')}
        footer={
          <>
            <Button onClick={onClose}>{t('common.close')}</Button>
            <Button variant="primary" onClick={() => navigate(`/nodes/${result.node.id}`)}>
              {t('nodes.add.openNode')}
            </Button>
          </>
        }
      >
        <PairingPanel pairing={result.pairing} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={t('nodes.add.title')}
      description={t('nodes.add.subtitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="add-node" loading={create.isPending}>
            {t('nodes.add.submit')}
          </Button>
        </>
      }
    >
      <form id="add-node" className="flex flex-col gap-4" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('nodes.fields.name')} hint={t('nodes.fields.nameHint')}>
            <Input required autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="ams-relay-01" />
          </Field>
          <Field label={t('nodes.fields.location')} hint={t('nodes.fields.locationHint')}>
            <Input maxLength={80} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Amsterdam" />
          </Field>
        </div>
        {(admin || ownerTenants.length > 1) && (
          <Field label={t('nodes.fields.owner')} hint={admin ? t('nodes.fields.ownerHint') : undefined}>
            <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              {admin && <option value="">{t('nodes.platform')}</option>}
              {(admin ? (tenants.data ?? []).map((x) => ({ tenantId: x.id, tenantName: x.name })) : ownerTenants).map((x) => (
                <option key={x.tenantId} value={x.tenantId}>
                  {x.tenantName}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('nodes.fields.roles')} hint={t('nodes.fields.rolesHint')}>
          <RolePicker value={roles} onChange={setRoles} />
        </Field>
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['nodes', 'settings'], queryFn: () => api<NodesSettings>('/nodes/settings'), enabled: open });
  const [draft, setDraft] = useState<NodesSettings | null>(null);
  useEffect(() => {
    if (open && settings.data) setDraft(settings.data);
  }, [open, settings.data]);
  const save = useMutation({
    mutationFn: (body: NodesSettings) => api<NodesSettings>('/nodes/settings', { method: 'PUT', body }),
    onSuccess: (res) => {
      qc.setQueryData(['nodes', 'settings'], res);
      toast.success(t('nodes.settings.saved'));
      onClose();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const set = (patch: Partial<NodesSettings>) => draft && setDraft({ ...draft, ...patch });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('nodes.settings.title')}
      description={t('nodes.settings.subtitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!draft} loading={save.isPending} onClick={() => draft && save.mutate(draft)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {!draft ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Switch checked={draft.routeListeners} onChange={(routeListeners) => set({ routeListeners })} label={t('nodes.settings.routeListeners')} description={t('nodes.settings.routeListenersHint')} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('nodes.settings.probeInterval')} hint={t('nodes.settings.probeIntervalHint')}>
              <Input type="number" min={30} max={3600} value={draft.probeIntervalSeconds} onChange={(e) => set({ probeIntervalSeconds: Number(e.target.value) })} />
            </Field>
            <Field label={t('nodes.settings.latencyWarn')} hint={t('nodes.settings.latencyWarnHint')}>
              <Input type="number" min={5} max={5000} value={draft.latencyWarnMs} onChange={(e) => set({ latencyWarnMs: Number(e.target.value) })} />
            </Field>
            <Field label={t('nodes.settings.retention')} hint={t('nodes.settings.retentionHint')}>
              <Input type="number" min={1} max={365} value={draft.metricsRetentionDays} onChange={(e) => set({ metricsRetentionDays: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label={t('nodes.settings.ingestAddress')} hint={t('nodes.settings.ingestAddressHint')}>
            <Input value={draft.ingestAddress} placeholder="10.10.4.240" onChange={(e) => set({ ingestAddress: e.target.value })} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

export function NodesPage() {
  const { t } = useTranslation();
  const me = useMe().data!;
  const admin = isAdmin(me);
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<NodeItem[]>('/nodes'), refetchInterval: 5000 });
  const settings = useQuery({ queryKey: ['nodes', 'settings'], queryFn: () => api<NodesSettings>('/nodes/settings'), enabled: admin });
  const stationList = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations'), enabled: admin });
  const warnMs = settings.data?.latencyWarnMs ?? 150;
  const canAdd = admin || me.memberships.some((m) => m.role === 'owner');
  const list = nodes.data ?? [];
  const online = list.filter((n) => n.status.online);

  return (
    <>
      <PageHeader
        title={admin ? t('nodes.title') : t('nodes.myTitle')}
        description={admin ? t('nodes.subtitle') : t('nodes.mySubtitle')}
        actions={
          <>
            <Link to="/topology">
              <Button>
                <Network className="size-4" /> {admin ? t('nav.topology') : t('nav.mySetup')}
              </Button>
            </Link>
            {admin && (
              <Button onClick={() => setSettingsOpen(true)}>
                <Settings2 className="size-4" /> {t('nodes.settings.button')}
              </Button>
            )}
            {canAdd && (
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus className="size-4" /> {t('nodes.add.button')}
              </Button>
            )}
          </>
        }
      />

      {admin && <OrchestratorOnlyCard />}
      {admin && <RolloutCard />}

      {!!list.length && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: t('nodes.kpi.online'), value: `${online.length} / ${list.filter((n) => n.paired).length}` },
            { label: t('nodes.kpi.listeners'), value: online.reduce((s, n) => s + (n.status.listeners ?? 0), 0).toLocaleString() },
            { label: t('nodes.kpi.outgoing'), value: formatBps(online.reduce((s, n) => s + (n.status.txBps ?? 0), 0)) },
            { label: t('nodes.kpi.encoders'), value: String(online.reduce((s, n) => s + (n.status.encoders ?? 0), 0)) },
          ].map((k) => (
            <Card key={k.label} className="px-4 py-3">
              <div className="text-[11.5px] text-muted">{k.label}</div>
              <div className="display text-xl tabular-nums">{k.value}</div>
            </Card>
          ))}
        </div>
      )}

      {!!list.length && <NodeHierarchy nodes={list} warnMs={warnMs} />}

      <Card>
        {nodes.isPending ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : !list.length ? (
          <EmptyState
            icon={<Server className="size-5" />}
            title={admin ? t('nodes.empty') : t('nodes.myEmpty')}
            description={admin ? t('nodes.emptyText') : t('nodes.myEmptyText')}
            action={
              canAdd && (
                <Button variant="primary" onClick={() => setAdding(true)}>
                  <Plus className="size-4" /> {t('nodes.add.button')}
                </Button>
              )
            }
          />
        ) : (
          <Table
            head={[
              t('nodes.cols.node'),
              ...(admin ? [t('nodes.cols.owner')] : []),
              t('nodes.cols.roles'),
              t('nodes.cols.status'),
              t('nodes.cols.version'),
              t('nodes.cols.latency'),
              t('nodes.cols.listeners'),
              t('nodes.cols.load'),
              t('nodes.cols.bandwidth'),
            ]}
          >
            {list.map((n) => {
              const s = n.status;
              const health = nodeHealth(n, warnMs);
              return (
                <tr key={n.id} className="cursor-pointer hover:bg-hover" onClick={() => navigate(`/nodes/${n.id}`)}>
                  <td>
                    <Link to={`/nodes/${n.id}`} className="font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>
                      {n.name}
                    </Link>
                    {/* The name is the node's own; host name and address stay visible underneath (phase 18). */}
                    {(s.hostname || s.ip) && <div className="font-mono text-[11.5px] text-muted">{[s.hostname, s.ip].filter(Boolean).join(' · ')}</div>}
                    <div className="text-xs text-muted">{[n.location, s.city && s.country ? `${s.city}, ${s.country}` : s.country].filter(Boolean).join(' · ') || '—'}</div>
                  </td>
                  {admin && (
                    <td className="text-[13px]">
                      <div>{n.tenantName ?? <span className="text-muted">{t('nodes.platform')}</span>}</div>
                      {!n.tenantId && <ScopeBadge scope={n.scope} stations={stationList.data} />}
                    </td>
                  )}
                  <td>
                    <RoleBadges roles={n.roles} />
                  </td>
                  <td title={s.problems?.join('\n')}>
                    <HealthBadge health={health} />
                  </td>
                  <td className="text-[13px] whitespace-nowrap">
                    {s.version ? <span className="font-mono">v{s.version}</span> : '—'}
                    {n.updateAvailable && n.update.state === 'upToDate' && (
                      <span className="ml-1.5 inline-flex align-middle" title={t('nodes.updateAvailable')}>
                        <ArrowUpCircle className="size-4 text-koraal" />
                      </span>
                    )}
                    {n.paired && (
                      <div className="mt-0.5">
                        <UpdateBadge update={n.update} available={n.updateAvailable} />
                      </div>
                    )}
                  </td>
                  <td className={clsx('text-[13px] tabular-nums whitespace-nowrap', s.online && (s.rttMs ?? 0) > warnMs && 'font-semibold text-warning')}>
                    {s.online ? formatMs(s.rttMs) : '—'}
                    {s.online && (s.loss ?? 0) > 0 && <span className="ml-1 text-xs text-warning">({Math.round((s.loss ?? 0) * 100)}%)</span>}
                  </td>
                  <td className="text-[13px] tabular-nums">{s.online ? (s.listeners ?? 0).toLocaleString() : '—'}</td>
                  <td className="text-[13px] tabular-nums">{s.online && s.cpu != null ? `${Math.round(s.cpu * 100)}%` : '—'}</td>
                  <td className="text-[13px] tabular-nums whitespace-nowrap">{s.online ? formatBps(s.txBps) : '—'}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
      {!admin && !canAdd && <p className="mt-3 text-xs text-muted">{t('nodes.ownerOnly')}</p>}
      {list.some((n) => !n.paired) && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Badge>{t('nodes.health.unpaired')}</Badge> {t('nodes.unpairedHint')}
        </p>
      )}
      <AddNodeDialog open={adding} onClose={() => setAdding(false)} />
      {admin && <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
