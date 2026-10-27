import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError, type StationDetail, type StationRouting, type StationRoutingView } from '../../lib/api';
import { Badge, Button, Card, CardHeader, Field, Segmented, Select, Spinner, Switch, Table } from '../ui';
import { useServerNames } from '../../lib/server';

/**
 * Per station: which ingest takes the encoders, which one stands by, and which relays the ingest feeds directly
 * (phase 13). The orchestrator only hands out this route; the audio goes from the ingest straight to the relays.
 */
export function RoutingCard({ station }: { station: StationDetail }) {
  const server = useServerNames();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['station-routing', station.id], queryFn: () => api<StationRoutingView>(`/stations/${station.id}/routing`), refetchInterval: 5000 });
  const [form, setForm] = useState<StationRouting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = q.data;
  useEffect(() => {
    if (v && !form) setForm(v.routing);
  }, [v, form]);

  const save = useMutation({
    // Relays that can no longer carry the station are dropped, or the save would be refused for them.
    mutationFn: (body: StationRouting) =>
      api<StationRoutingView>(`/stations/${station.id}/routing`, { method: 'PUT', body: { ...body, relays: body.relays === 'auto' ? 'auto' : body.relays.filter((id) => !q.data?.stale.some((x) => x.id === id)) } }),
    onSuccess: (res) => {
      qc.setQueryData(['station-routing', station.id], res);
      setForm(res.routing);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['station', station.id] });
      toast.success(t('common.saved'));
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const here = server?.ingest ?? t('routing.thisServer');
  if (!v || !form)
    return (
      <Card className="grid place-items-center p-10">
        <Spinner />
      </Card>
    );

  const name = (ref: string | null) => (ref === 'local' ? here : (v.options.ingests.find((n) => n.id === ref)?.name ?? v.status.ingests.find((i) => i.ref === ref)?.name ?? '—'));
  const ingestStatus = (ref: string) => v.status.ingests.find((i) => i.ref === ref);
  const edit = v.canEdit;
  const chosen = form.relays === 'auto' ? null : form.relays;
  const dirty = JSON.stringify(form) !== JSON.stringify(v.routing) || (!!chosen && v.stale.some((x) => chosen.includes(x.id)));
  const toggleRelay = (id: string) => chosen && setForm({ ...form, relays: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id] });
  const ingestOptions = (
    <>
      {/* Orchestrator only: this server takes no encoders (phase 18). */}
      {!v.orchestratorOnly && <option value="local">{here}</option>}
      {v.options.ingests.map((n) => (
        <option key={n.id} value={n.id}>
          {n.name}
          {n.location ? ` · ${n.location}` : ''}
          {n.online ? '' : ` (${t('nodes.health.offline')})`}
        </option>
      ))}
    </>
  );
  const statusText = (ref: string) => {
    const s = ingestStatus(ref);
    if (!s) return '';
    return s.onAir ? t('routing.onAir') : s.online ? t('routing.standby') : t('nodes.health.offline');
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t('routing.settings')} description={v.locked ? t('routing.locked') : !v.canEdit ? t('routing.ownerOnly') : t('routing.orchestratorNote')} />
        <div className="flex flex-col gap-5 p-5">
          {/* On a station node the node is the ingest, so only the relays are chosen here (phase 19). */}
          {!v.locked && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('routing.mainIngest')} hint={v.autodjHere ? t('routing.autodjHere') : t('routing.mainIngestHint')}>
                <Select value={form.ingest} disabled={!edit || v.autodjHere} onChange={(e) => setForm({ ...form, ingest: e.target.value, backupIngest: form.backupIngest === e.target.value ? null : form.backupIngest })}>
                  {ingestOptions}
                </Select>
              </Field>
              <Field label={t('routing.backupIngest')} hint={t('routing.backupIngestHint')}>
                <Select value={form.backupIngest ?? ''} disabled={!edit} onChange={(e) => setForm({ ...form, backupIngest: e.target.value || null })}>
                  <option value="">{t('routing.noBackup')}</option>
                  {ingestOptions}
                </Select>
              </Field>
            </div>
          )}
          {!!v.stale.length && (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">{t('routing.stale', { names: v.stale.map((x) => x.name).join(', '), count: v.stale.length })}</p>
          )}
          <div className="flex flex-col gap-3">
            <div className="text-sm font-semibold">{t('routing.relays')}</div>
            <Segmented
              value={chosen ? 'chosen' : 'auto'}
              onChange={(x) => edit && setForm({ ...form, relays: x === 'auto' ? 'auto' : v.status.relays.filter((r) => !r.spare).map((r) => r.id) })}
              options={[
                { value: 'auto', label: t('routing.relaysAuto'), description: t('routing.relaysAutoHint') },
                { value: 'chosen', label: t('routing.relaysChosen'), description: t('routing.relaysChosenHint') },
              ]}
            />
            {chosen && (
              <div className="grid gap-2 sm:grid-cols-2">
                {v.options.relays.length === 0 && <p className="text-[13px] text-muted">{t('routing.noRelays')}</p>}
                {v.options.relays.map((n) => (
                  <label key={n.id} className="flex items-center gap-2.5 rounded-md border border-line px-3 py-2 text-[13px]">
                    <input type="checkbox" className="accent-koraal" disabled={!edit} checked={chosen.includes(n.id)} onChange={() => toggleRelay(n.id)} />
                    <span className="min-w-0 flex-1 truncate font-semibold">{n.name}</span>
                    {n.location && <span className="truncate text-xs text-muted">{n.location}</span>}
                    <Badge tone={n.online ? 'online' : 'offline'} dot>
                      {t(n.online ? 'nodes.health.online' : 'nodes.health.offline')}
                    </Badge>
                  </label>
                ))}
              </div>
            )}
            {chosen && <Switch checked={form.spareRelays} disabled={!edit} onChange={(x) => setForm({ ...form, spareRelays: x })} label={t('routing.spare')} description={t('routing.spareHint')} />}
          </div>
          {error && <p className="text-[13px] text-offline">{error}</p>}
          {edit && (
            <div className="flex justify-end gap-2">
              <Button disabled={!dirty || save.isPending} onClick={() => setForm(v.routing)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(form)}>
                {t('common.save')}
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title={t('routing.live')} description={t('routing.liveHint')} />
        <Table head={[t('routing.col.part'), t('routing.col.name'), t('routing.col.state')]}>
          {(v.locked ? [] : v.status.ingests).map((i) => (
            <tr key={i.ref}>
              <td className="text-[13px] text-muted">{i.priority === 0 ? t('routing.main') : t('routing.backup')}</td>
              <td className="text-[13px] font-semibold">{name(i.ref)}</td>
              <td>
                <Badge tone={i.onAir ? 'online' : i.online ? 'neutral' : 'offline'} dot>
                  {statusText(i.ref)}
                </Badge>
              </td>
            </tr>
          ))}
          {v.status.relays.map((r) => (
            <tr key={r.id}>
              <td className="text-[13px] text-muted">{r.spare ? t('routing.spareRelay') : t('routing.relay')}</td>
              <td className="text-[13px] font-semibold">{r.name}</td>
              <td>
                <Badge tone={!r.online ? 'offline' : r.total && r.connected === r.total ? 'online' : r.connected ? 'warning' : 'neutral'} dot>
                  {r.online ? t('routing.mounts', { up: r.connected, total: r.total }) : t('nodes.health.offline')}
                </Badge>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
