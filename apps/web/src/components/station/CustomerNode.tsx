import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, type Tenant } from '../../lib/api';
import { Button, Card, Field, Select, Switch } from '../ui';
import { useServerNames } from '../../lib/server';
import { useStationNodes } from './Placement';

const MAIN = 'main';

/** The station node of a customer (phase 12): where its stations run, with the option to move them all at once. */
export function CustomerStationNodeCard({ tenant, canEdit }: { tenant: Tenant; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const nodes = useStationNodes(tenant.id);
  const server = useServerNames();
  // This server by its own name (phase 18). With "Orchestrator only" it runs no stations: no station node then means
  // distribution only, the encoders send to an ingest node.
  const here = server?.name ?? t('placement.mainServer');
  const noMain = !!server?.orchestratorOnly;
  const [target, setTarget] = useState(tenant.stationNodeId ?? MAIN);
  const [moveStations, setMoveStations] = useState(true);
  useEffect(() => setTarget(tenant.stationNodeId ?? MAIN), [tenant.stationNodeId]);
  const save = useMutation({
    mutationFn: () => api<{ moving: number; skipped: string[] }>(`/tenants/${tenant.id}/station-node`, { method: 'PUT', body: { nodeId: target === MAIN ? null : target, moveStations } }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['tenant', tenant.id] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      void qc.invalidateQueries({ queryKey: ['stations'] });
      toast.success(res.moving ? t('customerNode.saved', { count: res.moving }) : t('common.saved'));
      if (res.skipped.length) toast.warning(t('customerNode.skipped', { stations: res.skipped.join(', ') }));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  // Distribution only never has a studio: its encoders send to an ingest node.
  if ((tenant.plan === 'distribution' || !nodes.length) && !tenant.stationNodeId) return null;
  const current = nodes.find((n) => n.id === tenant.stationNodeId);
  return (
    <Card className="p-5">
      <h2 className="display text-base">{t('customerNode.title')}</h2>
      <p className="mt-1 mb-4 text-[13px] text-muted">{t('customerNode.hint')}</p>
      <Field label={t('customerNode.node')} hint={current ? t('customerNode.current', { name: current.name }) : noMain ? t('customerNode.noneYet') : t('customerNode.none', { name: here })}>
        {/* Keyed on the list: a select that first renders before the nodes are loaded keeps showing its first option. */}
        <Select key={nodes.map((n) => n.id).join()} value={target} onChange={(e) => setTarget(e.target.value)} disabled={!canEdit}>
          <option value={MAIN}>{noMain ? t('customerNode.noNode') : here}</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
              {n.location ? ` · ${n.location}` : ''}
            </option>
          ))}
        </Select>
      </Field>
      {canEdit && (
        <>
          <div className="mt-3">
            <Switch checked={moveStations} onChange={setMoveStations} label={t('customerNode.moveStations')} description={t('customerNode.moveStationsHint')} />
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary" disabled={target === (tenant.stationNodeId ?? MAIN)} loading={save.isPending} onClick={() => save.mutate()}>
              {t('common.save')}
            </Button>
            {tenant.stationNodeId && (
              <Link to={`/nodes/${tenant.stationNodeId}`} className="text-[13px] text-muted hover:text-ink">
                {t('customerNode.openNode')}
              </Link>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
