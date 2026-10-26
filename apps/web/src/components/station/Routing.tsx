import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Cpu, Headphones, Mic, Radio, Server } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError, type StationDetail, type StationRouting, type StationRoutingView } from '../../lib/api';
import { Badge, Button, Card, CardHeader, Field, Segmented, Select, Spinner, Switch, Table } from '../ui';

function Step({ icon, title, meta, active, muted }: { icon: ReactNode; title: ReactNode; meta?: ReactNode; active?: boolean; muted?: boolean }) {
  return (
    <div className={clsx('flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2', active ? 'border-koraal' : 'border-line', muted && 'opacity-60')}>
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-chip text-accent-text [&_svg]:size-4">{icon}</span>
      <span className="min-w-0">
        <b className="block truncate text-[13px]">{title}</b>
        {meta && <small className="block truncate text-[11.5px] text-muted">{meta}</small>}
      </span>
    </div>
  );
}

const Arrow = () => <ArrowRight className="mx-auto size-4 shrink-0 rotate-90 text-koraal sm:rotate-0" />;

/**
 * Per station: which ingest takes the encoders, which one stands by, and which relays the ingest feeds directly
 * (phase 13). The orchestrator only hands out this route; the audio goes from the ingest straight to the relays.
 */
export function RoutingCard({ station }: { station: StationDetail }) {
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
    mutationFn: (body: StationRouting) => api<StationRoutingView>(`/stations/${station.id}/routing`, { method: 'PUT', body }),
    onSuccess: (res) => {
      qc.setQueryData(['station-routing', station.id], res);
      setForm(res.routing);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['station', station.id] });
      toast.success(t('common.saved'));
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  if (!v || !form)
    return (
      <Card className="grid place-items-center p-10">
        <Spinner />
      </Card>
    );

  const name = (ref: string | null) => (ref === 'local' ? t('routing.thisServer') : (v.options.ingests.find((n) => n.id === ref)?.name ?? v.status.ingests.find((i) => i.ref === ref)?.name ?? '—'));
  const ingestStatus = (ref: string) => v.status.ingests.find((i) => i.ref === ref);
  const edit = v.canEdit && !v.locked;
  const chosen = form.relays === 'auto' ? null : form.relays;
  const dirty = JSON.stringify(form) !== JSON.stringify(v.routing);
  const toggleRelay = (id: string) => chosen && setForm({ ...form, relays: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id] });
  const ingestOptions = (
    <>
      <option value="local">{t('routing.thisServer')}</option>
      {v.options.ingests.map((n) => (
        <option key={n.id} value={n.id}>
          {n.name}
          {n.location ? ` · ${n.location}` : ''}
          {n.online ? '' : ` (${t('nodes.health.offline')})`}
        </option>
      ))}
    </>
  );
  const relaysOnline = v.status.relays.filter((r) => r.online && r.connected > 0).length;
  const statusText = (ref: string) => {
    const s = ingestStatus(ref);
    if (!s) return '';
    return s.onAir ? t('routing.onAir') : s.online ? t('routing.standby') : t('nodes.health.offline');
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t('routing.title')} description={t('routing.subtitle')} />
        <div className="grid items-center gap-2 p-5 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
          <Step icon={<Mic />} title={t('routing.flow.encoders')} meta={t('routing.flow.encodersMeta')} />
          <Arrow />
          <div className="flex flex-col gap-1.5">
            <Step icon={<Server />} title={name(v.routing.ingest)} meta={`${t('routing.main')} · ${statusText(v.routing.ingest)}`} active={v.status.active === v.routing.ingest} />
            {v.routing.backupIngest && (
              <Step icon={<Server />} title={name(v.routing.backupIngest)} meta={`${t('routing.backup')} · ${statusText(v.routing.backupIngest)}`} active={v.status.active === v.routing.backupIngest} muted={v.status.active !== v.routing.backupIngest} />
            )}
          </div>
          <Arrow />
          <Step icon={<Radio />} title={t('routing.flow.relays', { count: v.status.relays.length })} meta={t('routing.flow.relaysMeta', { up: relaysOnline, total: v.status.relays.length })} active={relaysOnline > 0} />
          <Arrow />
          <Step icon={<Headphones />} title={t('routing.flow.listeners')} />
        </div>
        <p className="flex items-center gap-2 border-t border-line px-5 py-3 text-xs text-muted">
          <Cpu className="size-4 shrink-0 text-lucht" /> {t('routing.orchestratorNote')}
        </p>
      </Card>

      <Card>
        <CardHeader title={t('routing.settings')} description={v.locked ? t('routing.locked') : !v.canEdit ? t('routing.ownerOnly') : undefined} />
        <div className="flex flex-col gap-5 p-5">
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
          {v.status.ingests.map((i) => (
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
