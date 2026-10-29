import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Server, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, type NodeItem, type Station, type StationDetail } from '../../lib/api';
import { isAdmin, useMe } from '../../lib/auth';
import { formatBytes, formatRelative } from '../../lib/format';
import { Badge, Button, Card, Field, Select } from '../ui';
import { useServerNames } from '../../lib/server';

const MAIN = 'main';

/** Station nodes a station of this customer can run on: shared ones (administrators) and the customer's own. */
export function useStationNodes(tenantId: string) {
  const me = useMe().data!;
  const admin = isAdmin(me);
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<NodeItem[]>('/nodes') });
  return (nodes.data ?? []).filter((n) => n.roles.includes('station') && n.paired && (n.tenantId === tenantId || (admin && !n.tenantId)));
}

/**
 * Where a new Radio station runs: one of the station nodes the customer may use, or this server (not when it is set
 * to orchestrator only). `value` is a node id, or null for this server.
 */
export function RunsOnPicker({ tenantId, preferred, value, onChange }: { tenantId: string; preferred?: string | null; value: string | null | undefined; onChange: (nodeId: string | null) => void }) {
  const { t } = useTranslation();
  const nodes = useStationNodes(tenantId);
  const server = useServerNames();
  const mainAllowed = !server?.orchestratorOnly;
  // Until a choice is made: the customer's station node, else the first one, else this server.
  const fallback = nodes.find((n) => n.id === preferred)?.id ?? nodes[0]?.id ?? null;
  useEffect(() => {
    if (value === undefined || (value === null && !mainAllowed) || (value && !nodes.some((n) => n.id === value))) {
      const next = fallback ?? null;
      if (next !== value) onChange(next);
    }
  }, [value, fallback, mainAllowed, nodes, onChange]);
  const none = !nodes.length && !mainAllowed;
  return (
    <Field label={t('placement.runsOnNew')} hint={none ? t('placement.noNodesRadio') : t('placement.runsOnNewHint')}>
      <Select value={value ?? MAIN} onChange={(e) => onChange(e.target.value === MAIN ? null : e.target.value)} disabled={none}>
        {mainAllowed && <option value={MAIN}>{server?.name ?? t('placement.mainServer')}</option>}
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.name}
            {n.location ? ` · ${n.location}` : ''}
            {n.tenantId ? '' : ` · ${t('placement.shared')}`}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** A line under the page header while the station node of a station cannot be reached. */
export function NodeOfflineBanner({ station }: { station: Station }) {
  const { t } = useTranslation();
  if (!station.nodeId || station.nodeOnline !== false) return null;
  return (
    <Card className="mb-4 border-warning/50">
      <div className="flex gap-3 px-5 py-3 text-[13px]">
        <WifiOff className="mt-0.5 size-4 shrink-0 text-warning" />
        <div>
          <span className="font-semibold">{t('placement.offlineTitle')}</span> {t('placement.offlineText', { when: station.nodeSeenAt ? formatRelative(station.nodeSeenAt) : '—' })}
        </div>
      </div>
    </Card>
  );
}

/**
 * Where the station runs: on this server or on a station node at the studio (phase 12), and moving it between them,
 * also straight from one station node to another. The music library moves along; the station switches over when the
 * copy is complete.
 */
export function PlacementCard({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const nodes = useStationNodes(station.tenantId);
  const move = station.nodeMove;
  // Follow a move while it runs.
  useQuery({ queryKey: ['station', station.id], queryFn: () => api<StationDetail>(`/stations/${station.id}`), refetchInterval: move?.state === 'copying' ? 3000 : false });
  const [target, setTarget] = useState(station.nodeId ?? MAIN);
  useEffect(() => setTarget(station.nodeId ?? MAIN), [station.nodeId]);
  const current = nodes.find((n) => n.id === station.nodeId);
  const server = useServerNames();
  const here = server?.name ?? t('placement.mainServer');
  // Orchestrator only (phase 18): a station cannot come back to this server.
  const noWayBack = !!server?.orchestratorOnly;
  const moveTo = nodes.find((n) => n.id === move?.nodeId);
  const nodeName = (id: string | null | undefined) => (id === station.nodeId && current ? current.name : nodes.find((n) => n.id === id)?.name) ?? t('placement.stationNode');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['station', station.id] });
    void qc.invalidateQueries({ queryKey: ['stations'] });
  };
  const place = useMutation({
    mutationFn: (body: { nodeId: string | null; force?: boolean }) => api(`/stations/${station.id}/placement`, { method: 'PUT', body }),
    onSuccess: () => {
      refresh();
      toast.success(t('placement.started'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/stations/${station.id}/placement/move`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (err) => toast.error((err as Error).message),
  });

  const start = () => {
    const nodeId = target === MAIN ? null : target;
    const name = nodeId ? nodeName(nodeId) : here;
    const text = nodeId && station.nodeId ? t('placement.confirmFromNode', { name, from: nodeName(station.nodeId) }) : t('placement.confirm', { name });
    if (confirm(text)) place.mutate({ nodeId });
  };
  const pct = move && move.bytes ? Math.min(100, Math.round((move.bytesDone / move.bytes) * 100)) : 0;

  return (
    <Card className="p-5">
      <h2 className="display text-base">{t('placement.title')}</h2>
      <p className="mt-1 mb-4 text-[13px] text-muted">{t('placement.hint')}</p>
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-md bg-chip text-accent-text">{station.nodeId ? <HardDrive className="size-4" /> : <Server className="size-4" />}</span>
        <div className="min-w-0">
          <div className="text-[11.5px] text-muted">{t('placement.runsOn')}</div>
          <div className="text-sm font-semibold">
            {station.nodeId ? (
              <Link to={`/nodes/${station.nodeId}`} className="hover:underline">
                {current?.name ?? t('placement.stationNode')}
              </Link>
            ) : (
              here
            )}
            {station.nodeId && (
              <Badge tone={station.nodeOnline ? 'online' : 'warning'} dot>
                {station.nodeOnline ? t('placement.online') : t('placement.offline')}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {move ? (
        <div className="mt-4 rounded-md border border-line p-3">
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <span className="font-semibold">
              {move.state === 'failed'
                ? t('placement.failed')
                : move.direction === 'to_main'
                  ? t('placement.movingBack', { name: here })
                  : move.fromNodeId
                    ? t('placement.movingFromTo', { from: nodeName(move.fromNodeId), name: moveTo?.name ?? t('placement.stationNode') })
                    : t('placement.movingTo', { name: moveTo?.name ?? t('placement.stationNode') })}
            </span>
            <span className="tabular-nums text-muted">{pct}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-chip">
            <div className={move.state === 'failed' ? 'h-full bg-offline' : 'h-full bg-koraal transition-all'} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 text-xs text-muted">
            {t('placement.progress', { files: move.filesDone, total: move.files, done: formatBytes(move.bytesDone), size: formatBytes(move.bytes) })}
          </div>
          {move.message && <div className="mt-1 text-xs text-offline">{move.message}</div>}
          <div className="mt-3 flex gap-2">
            {move.state === 'failed' && (
              <Button size="sm" loading={place.isPending} onClick={() => place.mutate({ nodeId: move.direction === 'to_node' ? move.nodeId : null, force: true })}>
                {t('placement.retry')}
              </Button>
            )}
            <Button size="sm" variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate()}>
              {t('placement.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <Field label={t('placement.moveTo')} hint={nodes.length ? t('placement.moveHint') : t('placement.noNodes')}>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!nodes.length && !station.nodeId}>
              {(!noWayBack || !station.nodeId) && <option value={MAIN}>{here}</option>}
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                  {n.location ? ` · ${n.location}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={target === (station.nodeId ?? MAIN) || (!!station.nodeId && target !== MAIN && station.nodeOnline === false)} loading={place.isPending} onClick={start}>
              {t('placement.move')}
            </Button>
            {station.nodeId && station.nodeOnline === false && !noWayBack && (
              <Button variant="danger" loading={place.isPending} onClick={() => confirm(t('placement.forceConfirm')) && place.mutate({ nodeId: null, force: true })}>
                {t('placement.force')}
              </Button>
            )}
          </div>
          {station.nodeId && target !== MAIN && target !== station.nodeId && station.nodeOnline === false && <p className="text-xs text-muted">{t('placement.fromOffline')}</p>}
          {noWayBack && station.nodeId && <p className="text-xs text-muted">{t('placement.orchestratorOnly', { name: here })}</p>}
        </div>
      )}
    </Card>
  );
}
