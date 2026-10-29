import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Crown, ShieldOff, Tag } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, type OrchestratorHost, type OrchestratorView } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { useServerNames } from '../../lib/server';
import { Badge, Button, Card, Dialog, Table } from '../ui';
import { formatUptime } from './common';

/** The orchestrator's view, shared by the pinned card and the first row of the node list. */
export const useOrchestratorView = (fast = false) =>
  useQuery({ queryKey: ['nodes', 'orchestrator'], queryFn: () => api<OrchestratorView>('/nodes/orchestrator'), refetchInterval: fast ? 5000 : 30_000 });

const share = (x: { used: number; total: number } | null) => (x && x.total ? x.used / x.total : null);

/** Its own audio roles, or "Orchestrator only". */
export function OrchestratorRoles({ host }: { host: OrchestratorHost }) {
  const { t } = useTranslation();
  if (!host.roles.length) return <Badge tone="accent">{t('orchestratorOnly.host.onlyRoles')}</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      {host.roles.map((r) => (
        <Badge key={r} tone="accent">
          {t(`orchestratorOnly.host.${r}`)}
        </Badge>
      ))}
    </span>
  );
}

/** Small gauge for CPU, memory and disk. */
function Meter({ label, value, detail }: { label: string; value: number | null; detail?: string }) {
  const pct = value == null ? null : Math.max(0, Math.min(1, value));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11.5px] text-muted">
        <span>{label}</span>
        <span className="tabular-nums">{pct == null ? '—' : `${Math.round(pct * 100)}%`}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-chip">
        <div className={clsx('h-full rounded-full', pct != null && pct > 0.9 ? 'bg-offline' : pct != null && pct > 0.75 ? 'bg-warning' : 'bg-koraal')} style={{ width: `${(pct ?? 0) * 100}%` }} />
      </div>
      {detail && <div className="mt-0.5 text-[11px] text-muted tabular-nums">{detail}</div>}
    </div>
  );
}

/**
 * The server that hosts the orchestrator, pinned at the top of Nodes, with
 * "Orchestrator only" (phase 18): a switch that turns off this server's own ingest and relay, so it carries no audio
 * at all. Before it goes on, the panel lists the stations that still use this server.
 */
export function OrchestratorOnlyCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const server = useServerNames();
  const [open, setOpen] = useState(false);
  const view = useOrchestratorView(open);
  const save = useMutation({
    mutationFn: (only: boolean) => api<OrchestratorView>('/nodes/orchestrator', { method: 'PUT', body: { only } }),
    onSuccess: (res) => {
      qc.setQueryData(['nodes', 'orchestrator'], res);
      void qc.invalidateQueries({ queryKey: ['system-info'] });
      void qc.invalidateQueries({ queryKey: ['topology'] });
      toast.success(res.only ? t('orchestratorOnly.on') : t('orchestratorOnly.off'));
      setOpen(false);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const v = view.data;
  if (!v) return null;
  const blocked = v.stations.length > 0;
  const h = v.host;
  return (
    <>
      <Card className={clsx('mb-4 px-5 py-4', v.only && 'border-lucht/60')}>
        <div className="flex flex-wrap items-center gap-4">
          <span className={clsx('grid size-10 place-items-center rounded-md [&_svg]:size-5', v.only ? 'bg-nacht text-koraal' : 'bg-chip text-accent-text')}>{v.only ? <ShieldOff /> : <Crown />}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-sm">{h.name || server?.name || t('topology.orchestrator')}</b>
              <Badge tone="accent" dot>
                {t('orchestratorOnly.host.badge')}
              </Badge>
              <Badge tone={v.only ? 'accent' : 'neutral'}>{v.only ? t('orchestratorOnly.badgeOn') : t('orchestratorOnly.badgeOff')}</Badge>
            </div>
            <p className="mt-0.5 text-[13px] text-muted">{t('orchestratorOnly.host.hint')}</p>
          </div>
          <Link to="/nodes/names">
            <Button size="sm">
              <Tag className="size-4" /> {t('names.button')}
            </Button>
          </Link>
          <Button size="sm" variant={v.only ? 'secondary' : 'primary'} onClick={() => setOpen(true)}>
            {v.only ? t('orchestratorOnly.switchOff') : t('orchestratorOnly.switchOn')}
          </Button>
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          {[
            [t('orchestratorOnly.host.hostname'), <span className="font-mono">{h.hostname}</span>],
            [t('orchestratorOnly.host.internal'), <span className="font-mono">{h.addresses.join(', ') || '—'}</span>],
            [t('orchestratorOnly.host.public'), <span className="font-mono">{h.publicHost}</span>],
            [
              t('orchestratorOnly.host.version'),
              <span className="font-mono" title={h.commit ?? undefined}>
                v{h.version}
                {h.commit && <span className="text-muted"> · {h.commit.slice(0, 7)}</span>}
              </span>,
            ],
            [t('orchestratorOnly.host.uptime'), <span className="tabular-nums">{formatUptime(h.uptimeSeconds)}</span>],
            [t('orchestratorOnly.host.roles'), <OrchestratorRoles host={h} />],
          ].map(([label, value], i) => (
            <div key={i} className="min-w-0">
              <dt className="text-[11.5px] text-muted">{label}</dt>
              <dd className="mt-0.5 truncate">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Meter label={t('orchestratorOnly.host.cpu')} value={h.cpu} />
          <Meter label={t('orchestratorOnly.host.memory')} value={share(h.memory)} detail={`${formatBytes(h.memory.used)} / ${formatBytes(h.memory.total)}`} />
          <Meter label={t('orchestratorOnly.host.disk')} value={share(h.disk)} detail={h.disk ? `${formatBytes(h.disk.used)} / ${formatBytes(h.disk.total)}` : undefined} />
        </div>
        <p className="mt-3 text-[13px] text-muted">
          {v.only ? t('orchestratorOnly.textOn') : blocked ? t('orchestratorOnly.textBlocked', { count: v.stations.length }) : t('orchestratorOnly.textReady')}
        </p>
      </Card>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        wide
        title={v.only ? t('orchestratorOnly.offTitle') : t('orchestratorOnly.onTitle')}
        description={v.only ? t('orchestratorOnly.offText') : t('orchestratorOnly.onText')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={!v.only && blocked} loading={save.isPending} onClick={() => save.mutate(!v.only)}>
              {v.only ? t('orchestratorOnly.switchOff') : t('orchestratorOnly.switchOn')}
            </Button>
          </>
        }
      >
        {!v.only && (
          <div className="flex flex-col gap-3">
            <ul className="list-disc pl-5 text-[13px] text-muted">
              {(['ports', 'icecast', 'routing', 'fallback', 'listeners', 'uploads', 'web'] as const).map((k) => (
                <li key={k}>{t(`orchestratorOnly.effects.${k}`)}</li>
              ))}
            </ul>
            <div className="grid grid-cols-3 gap-2 text-center text-[12px]">
              {[
                [t('topology.ingestNodes'), v.ingestNodes],
                [t('nodes.tree.groups.station'), v.stationNodes],
                [t('nodes.tree.groups.relay'), v.relayNodes],
              ].map(([label, n]) => (
                <div key={String(label)} className="rounded-md border border-line px-2 py-2">
                  <div className="display text-lg tabular-nums">{n}</div>
                  <div className="text-muted">{label}</div>
                </div>
              ))}
            </div>
            {blocked ? (
              <>
                <p className="text-[13px] font-semibold text-warning">{t('orchestratorOnly.stillUsing', { count: v.stations.length })}</p>
                <Table head={[t('orchestratorOnly.station'), t('fields.customer'), t('orchestratorOnly.uses')]}>
                  {v.stations.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link to={`/stations/${s.id}?tab=routing`} className="font-semibold hover:underline">
                          {s.name}
                        </Link>
                      </td>
                      <td className="text-[13px]">{s.tenantName}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {s.uses.map((u) => (
                            <Badge key={u} tone="warning">
                              {t(`orchestratorOnly.use.${u}`)}
                            </Badge>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </Table>
              </>
            ) : (
              <p className="text-[13px] font-semibold text-online">{t('orchestratorOnly.ready')}</p>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
