import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownCircle, ArrowLeft, ArrowUpCircle, ExternalLink, Headphones, Mic, PlugZap, Radio, Trash2, Upload } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { AccountsCard } from '../components/station/Accounts';
import { AutodjTab } from '../components/station/AutoDj';
import { StationCartsTab } from '../components/station/Carts';
import { ClocksTab } from '../components/station/Clocks';
import { LibraryTab } from '../components/station/Library';
import { NewsTab } from '../components/station/News';
import { PlaylistsTab } from '../components/station/Playlists';
import { OnDemandTab } from '../components/station/OnDemand';
import { PublicPageTab } from '../components/station/PublicPage';
import { RequestsTab, usePendingRequests } from '../components/station/Requests';
import { RoutingCard } from '../components/station/Routing';
import { ScheduleTab } from '../components/station/Schedule';
import { StatisticsView } from '../components/stats/StatisticsView';
import { formatLabel, MountsCard } from '../components/station/Mounts';
import { OutputsCard, OutputStateBadge } from '../components/station/Outputs';
import { NodeOfflineBanner, PlacementCard } from '../components/station/Placement';
import { Badge, Button, Card, CardHeader, CopyField, Fact, Field, Input, PageHeader, Select, Spinner, Switch, Table, Textarea } from '../components/ui';
import { api, type LiveSession, type StationDetail, type StationStatus, type Tenant } from '../lib/api';
import { formatBytes, formatDate, formatDuration } from '../lib/format';
import { EditionBadge } from './Stations';
import { ConnectionTab } from '../components/connection/Connection';
import { DeliveryPathCard, DeliveryPathSummary } from '../components/station/DeliveryPath';
import { stationMenu, stationTabHref, stationTabs, type StationTab } from '../components/station/menu';

type Tab = StationTab;
const rank = { dj: 1, manager: 2, owner: 3, superadmin: 4 } as const;

function useStationStatus(id: string) {
  return useQuery({ queryKey: ['station-status', id], queryFn: () => api<StationStatus>(`/stations/${id}/status`), refetchInterval: 5000 });
}

function LiveCard({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useStationStatus(station.id);
  const canKick = rank[station.role] >= rank.manager;
  const disconnect = useMutation({
    mutationFn: (mountId: string) => api(`/stations/${station.id}/mounts/${mountId}/disconnect`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('live.disconnected'));
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['station-status', station.id] }), 1000);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const s = status.data;
  const sessions = new Map((s?.live ?? []).map((l) => [l.mountPath, l]));

  return (
    <Card>
      <CardHeader
        title={t('live.title')}
        description={t('live.subtitle')}
        actions={
          s && (
            <Badge tone={!station.enabled ? 'offline' : s.running ? 'online' : 'warning'} dot>
              {!station.enabled ? t('common.disabled') : s.running ? t('live.serverRunning') : t('live.serverStarting')}
            </Badge>
          )
        }
      />
      <div className="grid grid-cols-2 gap-4 border-b border-line px-5 py-4 sm:grid-cols-4">
        <Fact label={t('fields.listeners')}>
          {s?.listeners ?? '—'} <span className="text-xs font-normal text-muted">/ {station.maxListeners}</span>
        </Fact>
        <Fact label={t('live.encoders')}>{s?.live.length ?? '—'}</Fact>
        <Fact label={t('live.mountsOnAir')}>{s ? `${s.mounts.filter((m) => m.live).length} / ${s.mounts.length}` : '—'}</Fact>
        <Fact label={t('live.storage')}>{formatBytes(station.storageBytes)}</Fact>
      </div>
      {status.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <Table head={[t('mounts.path'), t('fields.status'), t('live.nowPlaying'), t('fields.listeners'), '']}>
          {(s?.mounts ?? []).map((m) => {
            const session = sessions.get(m.path);
            return (
              <tr key={m.path}>
                <td className="font-mono font-semibold">{m.path}</td>
                <td>
                  <Badge tone={m.live ? 'online' : 'neutral'} dot>
                    {m.live ? t('stations.onAir') : t('stations.offAir')}
                  </Badge>
                  {m.live && m.bitrateKbps && <div className="mt-1 text-[11px] text-muted">{m.bitrateKbps} kbps</div>}
                </td>
                <td className="max-w-72">
                  <div className="truncate text-[13px]">{m.title ?? '—'}</div>
                  {session && (
                    <div className="truncate text-[11px] text-muted">
                      <Mic className="mr-1 inline size-3" />
                      {session.accountName} · {formatDuration(session.startedAt)}
                    </div>
                  )}
                </td>
                <td className="tabular-nums">{m.listeners}</td>
                <td className="text-right">
                  {canKick && m.live && m.id && session && (
                    <Button size="sm" variant="ghost" title={t('live.disconnect')} onClick={() => confirm(t('live.disconnectConfirm', { mount: m.path })) && disconnect.mutate(m.id!)}>
                      <PlugZap className="size-4 text-offline" />
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      {!!s?.outputs.filter((o) => o.type !== 'local').length && (
        <div className="flex flex-wrap gap-3 border-t border-line px-5 py-3">
          {s.outputs
            .filter((o) => o.type !== 'local')
            .map((o) => (
              <div key={o.id} className="flex items-center gap-2 text-[13px]">
                <span className="font-semibold">{o.name}</span>
                <OutputStateBadge status={o.status} enabled={o.enabled} />
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}

function ConnectionCard({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const c = station.connection;
  const sources = c.mounts.filter((m) => station.mounts.find((x) => x.id === m.id)?.kind === 'source');
  const [mountId, setMountId] = useState(sources[0]?.id ?? '');
  const mount = sources.find((m) => m.id === mountId) ?? sources[0];
  return (
    <Card>
      <CardHeader title={t('connection.title')} description={t('connection.subtitle')} />
      <div className="flex flex-col gap-4 p-5">
        {sources.length > 1 && (
          <Field label={t('mounts.path')}>
            <Select value={mount?.id} onChange={(e) => setMountId(e.target.value)}>
              {sources.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.path}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div>
          <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
            {t('connection.icecast')}
            {c.tls.available ? <Badge tone="online">TLS</Badge> : <Badge tone="warning">{t('connection.selfSigned')}</Badge>}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <CopyField label={t('connection.server')} value={c.ingestHost} />
            <CopyField label={t('connection.tlsPort')} value={String(c.tls.port)} />
            {c.plain && <CopyField label={t('connection.plainPort')} value={String(c.plain.port)} />}
            {mount && <CopyField label={t('connection.mount')} value={mount.encoderMount} />}
          </div>
          {c.node && <p className="mt-2 text-xs text-muted">{t('connection.viaNode', { name: c.node.name })}</p>}
          <p className="mt-2 text-xs text-muted">{t('connection.credentials')}</p>
        </div>
        {c.backup && (
          <div>
            <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
              {t('connection.backup')}
              {c.backup.tls.available ? <Badge tone="online">TLS</Badge> : <Badge tone="warning">{t('connection.selfSigned')}</Badge>}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <CopyField label={t('connection.server')} value={c.backup.host} />
              <CopyField label={t('connection.tlsPort')} value={String(c.backup.tls.port)} />
              {c.backup.plain && <CopyField label={t('connection.plainPort')} value={String(c.backup.plain.port)} />}
            </div>
            <p className="mt-2 text-xs text-muted">{t('connection.backupHint')}</p>
          </div>
        )}
        {c.legacy && (
          <div>
            <div className="mb-2 text-[13px] font-semibold">{t('connection.legacy')}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <CopyField label={t('connection.server')} value={c.ingestHost} />
              <CopyField label={t('connection.legacyPort')} value={String(c.legacy.port)} />
            </div>
            <p className="mt-2 text-xs text-muted">{t('connection.legacyHint', { mount: c.legacy.mount ?? '/live', sourcePort: c.legacy.sourcePort })}</p>
          </div>
        )}
        <div>
          <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
            <Headphones className="size-4 text-muted" /> {t('connection.listen')}
          </div>
          <div className="flex flex-col gap-2">
            {c.mounts
              .filter((m) => m.listenUrl)
              .map((m) => {
                const full = station.mounts.find((x) => x.id === m.id);
                return <CopyField key={m.id} label={full ? `${m.path} · ${formatLabel(full)}` : m.path} value={m.listenUrl!} />;
              })}
          </div>
        </div>
      </div>
    </Card>
  );
}

function UploadCard({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const u = station.connection.upload;
  if (!u.sftpPort && !u.ftpPort) return null;
  return (
    <Card>
      <CardHeader title={t('upload.title')} description={t('upload.subtitle')} />
      <div className="flex flex-col gap-2 p-5">
        <CopyField label={t('connection.server')} value={u.host} />
        <div className="grid gap-2 sm:grid-cols-2">
          {u.sftpPort && <CopyField label={t('upload.sftp')} value={String(u.sftpPort)} />}
          {u.ftpPort && <CopyField label={u.ftpRequireTls ? t('upload.ftps') : t('upload.ftp')} value={String(u.ftpPort)} />}
        </div>
        <p className="mt-1 flex gap-2 text-xs text-muted">
          <Upload className="size-4 shrink-0" />
          {t('upload.login', { slug: station.slug })}
        </p>
      </div>
    </Card>
  );
}

function HistoryCard({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const history = useInfiniteQuery({
    queryKey: ['station-live', station.id],
    queryFn: ({ pageParam }) =>
      api<{ items: LiveSession[]; nextBefore: string | null }>(`/stations/${station.id}/live?limit=50${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 30_000,
  });
  const items = history.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader title={t('history.title')} description={t('history.subtitle')} />
      {history.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <Table
          head={[t('history.who'), t('mounts.path'), t('history.started'), t('history.duration'), t('history.via'), t('history.ended')]}
          empty={!items.length && <p className="px-5 py-8 text-center text-[13px] text-muted">{t('history.empty')}</p>}
        >
          {items.map((l) => (
            <tr key={l.id}>
              <td>
                <div className="font-semibold">{l.accountName}</div>
                {l.ip && <div className="font-mono text-[11px] text-muted">{l.ip}</div>}
              </td>
              <td className="font-mono text-[13px]">{l.mountPath}</td>
              <td className="text-[13px] whitespace-nowrap">{formatDate(l.startedAt)}</td>
              <td className="tabular-nums">{formatDuration(l.startedAt, l.endedAt)}</td>
              <td className="text-[13px]">
                {t(`history.viaKinds.${l.via}`, { defaultValue: l.via })}
                {l.bitrateKbps && <span className="text-muted"> · {l.bitrateKbps} kbps</span>}
                {l.userAgent && <div className="max-w-48 truncate text-[11px] text-muted" title={l.userAgent}>{l.userAgent}</div>}
              </td>
              <td>
                {l.endedAt ? (
                  <span className="text-[13px] text-muted">{t(`history.reasons.${l.endReason ?? 'disconnected'}`, { defaultValue: l.endReason ?? '' })}</span>
                ) : (
                  <Badge tone="online" dot>
                    {t('stations.onAir')}
                  </Badge>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {history.hasNextPage && (
        <div className="flex justify-center border-t border-line p-3">
          <Button size="sm" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
            {t('history.more')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function SettingsTab({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const owner = rank[station.role] >= rank.owner;
  const [draft, setDraft] = useState(station);
  useEffect(() => setDraft(station), [station]);
  const sources = station.mounts.filter((m) => m.kind === 'source');

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<StationDetail>(`/stations/${station.id}`, { method: 'PATCH', body }),
    onSuccess: (res) => {
      qc.setQueryData(['station', station.id], res);
      void qc.invalidateQueries({ queryKey: ['stations'] });
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['station', station.id] });
    void qc.invalidateQueries({ queryKey: ['stations'] });
    void qc.invalidateQueries({ queryKey: ['autodj', station.id] });
    void qc.invalidateQueries({ queryKey: ['tenant', station.tenantId] });
  };
  const upgrade = useMutation({
    mutationFn: (upgradeCustomer: boolean) => api(`/stations/${station.id}/upgrade`, { method: 'POST', body: { upgradeCustomer } }),
    onSuccess: () => {
      refresh();
      toast.success(t('stations.upgraded'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const downgrade = useMutation({
    mutationFn: () => api(`/stations/${station.id}/downgrade`, { method: 'POST' }),
    onSuccess: () => {
      refresh();
      toast.success(t('stations.downgraded'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/stations/${station.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stations'] });
      toast.success(t('stations.deleted'));
      navigate('/stations');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    patch.mutate({
      name: draft.name,
      description: draft.description,
      genre: draft.genre,
      website: draft.website,
      enabled: draft.enabled,
      maxListeners: draft.maxListeners,
      ...(owner && draft.slug !== station.slug ? { slug: draft.slug } : {}),
    });
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
      <Card>
        <CardHeader title={t('stations.details')} />
        <form onSubmit={submit} className="flex flex-col gap-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('fields.name')}>
              <Input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label={t('fields.slug')} hint={owner ? t('stations.slugChangeHint') : undefined}>
              <Input required disabled={!owner} value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} className="font-mono" />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('stations.genre')}>
              <Input value={draft.genre} onChange={(e) => setDraft({ ...draft, genre: e.target.value })} placeholder="Hardstyle" />
            </Field>
            <Field label={t('stations.website')}>
              <Input value={draft.website} onChange={(e) => setDraft({ ...draft, website: e.target.value })} placeholder="https://harder.fm" />
            </Field>
          </div>
          <Field label={t('stations.description')}>
            <Textarea className="font-sans text-sm" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
          <Field label={t('limits.maxListeners')} hint={t('stations.maxListenersHint')}>
            <Input type="number" min={1} value={draft.maxListeners} onChange={(e) => setDraft({ ...draft, maxListeners: Number(e.target.value) })} />
          </Field>
          <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('stations.enabled')} description={t('stations.enabledHint')} />
          <div className="flex justify-end">
            <Button type="submit" variant="dark" loading={patch.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </Card>
      <div className="flex flex-col gap-4">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="display text-base">{t('stations.editionLabel')}</h2>
              <p className="mt-1 text-[13px] text-muted">{t(`stations.edition.${station.edition}Hint`)}</p>
            </div>
            <EditionBadge edition={station.edition} />
          </div>
          {owner && station.edition === 'distribution' && (
            <div className="mt-4">
              {station.tenantPlan === 'station' || station.role === 'superadmin' ? (
                <Button
                  variant="primary"
                  loading={upgrade.isPending}
                  onClick={() => {
                    const withPlan = station.tenantPlan !== 'station';
                    if (confirm(withPlan ? t('stations.upgradeWithPlanConfirm') : t('stations.upgradeConfirm'))) upgrade.mutate(withPlan);
                  }}
                >
                  <ArrowUpCircle className="size-4" /> {t('stations.upgrade')}
                </Button>
              ) : (
                <p className="text-xs text-muted">{t('stations.upgradeNeedsPlan')}</p>
              )}
              {station.tenantPlan !== 'station' && station.role === 'superadmin' && <p className="mt-2 text-xs text-muted">{t('stations.upgradeWithPlan')}</p>}
            </div>
          )}
          {owner && station.edition === 'station' && (
            <div className="mt-4">
              <Button loading={downgrade.isPending} onClick={() => confirm(t('stations.downgradeConfirm')) && downgrade.mutate()}>
                <ArrowDownCircle className="size-4" /> {t('stations.downgrade')}
              </Button>
            </div>
          )}
        </Card>
        {owner && (
          <Card className="p-5">
            <Switch
              checked={station.legacyPort !== null}
              disabled={patch.isPending}
              onChange={(enabled) => patch.mutate({ legacy: { enabled, mountId: station.legacyMountId ?? sources[0]?.id } })}
              label={t('stations.legacy')}
              description={station.legacyPort ? t('stations.legacyOn', { port: station.legacyPort, sourcePort: station.legacyPort + 1 }) : t('stations.legacyHint')}
            />
            {station.legacyPort !== null && sources.length > 1 && (
              <Field label={t('stations.legacyMount')} className="mt-3">
                <Select value={station.legacyMountId ?? sources[0]?.id} onChange={(e) => patch.mutate({ legacy: { enabled: true, mountId: e.target.value } })}>
                  {sources.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.path}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </Card>
        )}
        {/* Distribution only never runs in a studio (unless it already does, so it can move back). */}
        {owner && (station.edition !== 'distribution' || station.nodeId) && <PlacementCard station={station} />}
        {owner && (
          <Card className="border-offline/30 p-5">
            <h2 className="display text-base text-offline">{t('stations.delete')}</h2>
            <p className="mt-1 mb-4 text-[13px] text-muted">{t('stations.deleteHint')}</p>
            <Button variant="danger" loading={del.isPending} onClick={() => prompt(t('stations.deleteConfirm', { slug: station.slug })) === station.slug && del.mutate()}>
              <Trash2 className="size-4" /> {t('stations.delete')}
            </Button>
          </Card>
        )}
      </div>
    </div>
  );
}

export function StationDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const station = useQuery({ queryKey: ['station', id], queryFn: () => api<StationDetail>(`/stations/${id}`) });
  const tenant = useQuery({
    queryKey: ['tenant', station.data?.tenantId],
    queryFn: () => api<Tenant>(`/tenants/${station.data!.tenantId}`),
    enabled: !!station.data,
  });
  const status = useStationStatus(id!);
  const requests = usePendingRequests(id!);

  if (station.isPending) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  if (!station.data) return <Card className="p-8 text-center text-muted">{(station.error as Error)?.message}</Card>;
  const s = station.data;
  const manager = rank[s.role] >= rank.manager;
  // Phase 19: the station's sections live in the sidebar menu; on a phone they are a picker above the page.
  const groups = stationMenu(s, t, requests.data?.pending ?? 0);
  const items = stationTabs(groups);
  const requested = params.get('tab') as Tab | null;
  const tab: Tab = items.some((x) => x.value === requested) ? requested! : 'overview';
  const group = groups.find((g) => g.items.some((i) => i.value === tab));
  const current = items.find((i) => i.value === tab)!;
  const onAir = !!status.data?.mounts.some((m) => m.live);

  return (
    <>
      <Link to="/stations" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink lg:hidden">
        <ArrowLeft className="size-4" /> {t('nav.stations')}
      </Link>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-md bg-chip text-accent-text">
              <Radio className="size-5" />
            </span>
            {s.name}
          </span>
        }
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <EditionBadge edition={s.edition} />
            {!s.enabled ? (
              <Badge tone="offline">{t('common.disabled')}</Badge>
            ) : (
              <Badge tone={onAir ? 'online' : 'neutral'} dot>
                {onAir ? t('stations.onAir') : t('stations.offAir')}
              </Badge>
            )}
            <Link to={`/customers/${s.tenantId}`} className="text-xs hover:text-ink">
              {s.tenantName}
            </Link>
          </span>
        }
        actions={
          <a href={`/public/${s.slug}`} target="_blank" rel="noreferrer">
            <Button>
              <ExternalLink className="size-4" /> {t('stations.publicPage')}
            </Button>
          </a>
        }
      />
      <NodeOfflineBanner station={s} />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <h2 className="display flex items-center gap-2 text-lg">
          <current.icon className="size-5 text-koraal" />
          {group?.title && <span className="font-sans text-sm font-medium text-muted">{group.title} ›</span>}
          {current.label}
        </h2>
        <Select className="w-auto lg:hidden" aria-label={t('stations.menu.section')} value={tab} onChange={(e) => setParams(e.target.value === 'overview' ? {} : { tab: e.target.value }, { replace: true })}>
          {groups.map((g) => (
            <optgroup key={g.key} label={g.title ?? s.name}>
              {g.items.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                  {i.badge ? ` (${i.badge})` : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>
      {tab === 'overview' && (
        <div className="grid items-start gap-4 xl:grid-cols-[1.3fr_1fr]">
          {manager && (
            <div className="xl:col-span-2">
              <DeliveryPathSummary station={s} to={stationTabHref(s.id, 'routing')} />
            </div>
          )}
          <LiveCard station={s} />
          <div className="flex flex-col gap-4">
            <ConnectionCard station={s} />
            <UploadCard station={s} />
          </div>
        </div>
      )}
      {tab === 'connection' && <ConnectionTab station={s} />}
      {tab === 'autodj' && <AutodjTab station={s} canEdit={manager} />}
      {tab === 'library' && <LibraryTab station={s} canEdit={manager} />}
      {tab === 'playlists' && <PlaylistsTab station={s} canEdit={manager} />}
      {tab === 'clocks' && <ClocksTab station={s} canEdit={manager} />}
      {tab === 'schedule' && <ScheduleTab station={s} canEdit={manager} />}
      {tab === 'carts' && <StationCartsTab station={s} canEdit={manager} />}
      {tab === 'news' && <NewsTab station={s} canEdit={manager} />}
      {tab === 'statistics' && (
        <StatisticsView scope={{ stationId: s.id }} mounts={s.mounts.map((m) => m.path)} outputs={s.outputs.filter((o) => o.type !== 'local').map((o) => ({ id: o.id, name: o.name }))} showStation={false} />
      )}
      {tab === 'mounts' && <MountsCard station={s} canEdit={manager} maxBitrate={tenant.data?.limits.maxBitrateKbps ?? 320} />}
      {tab === 'outputs' && <OutputsCard station={s} canEdit={manager} />}
      {tab === 'routing' && (
        <div className="flex flex-col gap-4">
          <DeliveryPathCard station={s} />
          <RoutingCard station={s} />
        </div>
      )}
      {tab === 'accounts' && <AccountsCard station={s} />}
      {tab === 'history' && <HistoryCard station={s} />}
      {tab === 'public' && <PublicPageTab station={s} canEdit={manager} />}
      {tab === 'requests' && <RequestsTab station={s} canEdit={manager} />}
      {tab === 'ondemand' && <OnDemandTab station={s} canEdit={manager} />}
      {tab === 'settings' && <SettingsTab station={s} />}
    </>
  );
}
