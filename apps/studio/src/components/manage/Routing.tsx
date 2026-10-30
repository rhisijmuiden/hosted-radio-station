import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { RotateCcw, Send } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Header, Label } from './common';
import { Badge, Button, Card, Field, Segmented, Select, Spinner, Switch } from '../ui';
import { api, ApiError, type StationListItem, type StationRouting } from '../../lib/api';
import { ask } from '../../lib/native';
import { useNetwork, useRouting, useStatus } from '../../lib/queries';

type Route = StationRouting['routing'];
type Tone = 'source' | 'online' | 'standby' | 'warning' | 'offline';

const BOX_W = 180;
const BOX_H = 52;
const ROW = 68;
const COLS = [16, 276, 536, 796];
const STROKE: Record<Tone, string> = { source: 'var(--koraal)', online: 'var(--lucht)', standby: 'var(--line)', warning: 'var(--status-warning)', offline: 'var(--status-offline)' };
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Box {
  key: string;
  name: string;
  meta: string;
  tone: Tone;
}
interface Edge {
  from: string;
  to: string;
  live: boolean;
}

/** The path of the audio now, as in the sketch: studio → ingest(s) → relays → listeners. */
function PathDiagram({ columns, edges }: { columns: Box[][]; edges: Edge[] }) {
  const rows = Math.max(1, ...columns.map((c) => c.length));
  const height = rows * ROW + 8;
  const pos = new Map<string, { x: number; y: number }>();
  columns.forEach((col, ci) => {
    const top = (height - col.length * ROW) / 2 + (ROW - BOX_H) / 2;
    col.forEach((b, i) => pos.set(b.key, { x: COLS[ci]!, y: top + i * ROW }));
  });
  return (
    <svg viewBox={`0 0 ${COLS[3]! + BOX_W + 16} ${height}`} className="w-full" style={{ maxHeight: 360 }} role="img">
      {edges.map((e) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const x1 = a.x + BOX_W;
        const y1 = a.y + BOX_H / 2;
        const x2 = b.x;
        const y2 = b.y + BOX_H / 2;
        const mid = (x1 + x2) / 2;
        return (
          <path
            key={`${e.from}-${e.to}`}
            d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
            fill="none"
            stroke={e.live ? 'var(--koraal)' : 'var(--ink-muted)'}
            strokeWidth={e.live ? 2.5 : 1.2}
            strokeDasharray={e.live ? undefined : '4 4'}
            opacity={e.live ? 1 : 0.7}
          />
        );
      })}
      {columns.flat().map((b) => {
        const p = pos.get(b.key)!;
        return (
          <g key={b.key} transform={`translate(${p.x} ${p.y})`}>
            <rect width={BOX_W} height={BOX_H} rx={9} fill="var(--surface-raised)" stroke={STROKE[b.tone]} strokeWidth={1.5} />
            <text x={12} y={21} fontSize={13} fontWeight={700} fill="var(--ink)">
              {cut(b.name, 22)}
            </text>
            <text x={12} y={39} fontSize={11} fill="var(--ink-muted)">
              {cut(b.meta, 30)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Panel({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={clsx('p-5', className)}>
      <Label>{title}</Label>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </Card>
  );
}

/** Audio routing of the Manage view: how the station's audio reaches the relays, with the path as it runs now. */
export function RoutingSection({ station }: { station: StationListItem }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useRouting(station.id);
  const network = useNetwork(station.id);
  const status = useStatus(station.id);
  const [form, setForm] = useState<Route | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = q.data;
  useEffect(() => {
    if (v && !form) setForm(v.routing);
  }, [v, form]);

  const save = useMutation({
    // Relays that can no longer carry the station are dropped, or the save would be refused for them.
    mutationFn: (body: Route) =>
      api<StationRouting>(`/stations/${station.id}/routing`, { method: 'PUT', body: { ...body, relays: body.relays === 'auto' ? 'auto' : body.relays.filter((id) => !v?.stale.some((x) => x.id === id)) } }),
    onSuccess: (res) => {
      qc.setQueryData(['routing', station.id], res);
      setForm(res.routing);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['network', station.id] });
      toast.success(t('routing.saved'));
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  if (!v || !form) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }

  const edit = v.canEdit;
  const chosen = form.relays === 'auto' ? null : form.relays;
  const dirty = JSON.stringify(form) !== JSON.stringify(v.routing) || (!!chosen && v.stale.some((x) => chosen.includes(x.id)));
  const toggleRelay = (id: string) => chosen && setForm({ ...form, relays: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id] });
  const apply = async () => {
    if (await ask(t('routing.applyConfirm'))) save.mutate(form);
  };
  const nodeOptions = v.options.ingests.map((n) => (
    <option key={n.id} value={n.id}>
      {n.name}
      {n.location ? ` · ${n.location}` : ''}
      {n.online ? '' : ` (${t('manage.state.offline')})`}
    </option>
  ));

  // The path as it runs now, from the server's view of the route and the nodes' health.
  const nodes = network.data?.nodes ?? [];
  const studioNode = nodes.find((n) => n.role === 'station');
  const direct = !!v.studio?.direct;
  const source: Box = v.locked
    ? { key: 'src', name: studioNode?.name ?? t('routing.studio'), meta: t('routing.stationNode'), tone: 'source' }
    : { key: 'src', name: t('routing.encoders'), meta: t('routing.encodersMeta'), tone: 'source' };
  const ingests: Box[] = direct
    ? []
    : v.status.ingests.map((i) => ({
        key: `i-${i.ref}`,
        name: i.ref === 'local' ? (nodes.find((n) => n.id === 'main')?.name ?? t('manage.thisServer')) : i.name,
        meta: `${i.priority === 0 ? t('routing.main') : t('routing.backup')} · ${i.onAir ? t('routing.onAir') : i.online ? t('routing.standby') : t('manage.state.offline')}`,
        tone: !i.online ? 'offline' : i.onAir ? 'online' : 'standby',
      }));
  const relays: Box[] = v.status.relays.map((r) => {
    const n = nodes.find((x) => x.id === r.id);
    const bad = !r.online || (r.total > 0 && r.connected < r.total) || n?.state === 'warning';
    return {
      key: `r-${r.id}`,
      name: r.name,
      meta: !r.online ? t('manage.state.offline') : `${r.spare ? t('routing.spareRelay') : t('routing.relay')} · ${t('routing.listeners', { count: n?.listeners ?? 0 })}`,
      tone: !r.online ? 'offline' : bad ? 'warning' : 'online',
    };
  });
  const listeners: Box = { key: 'out', name: t('routing.listenersTitle'), meta: t('routing.listenersNow', { count: status.data?.listeners ?? station.listeners ?? 0 }), tone: 'standby' };
  const edges: Edge[] = [];
  const firstHop = ingests.length ? ingests : relays;
  for (const b of firstHop) edges.push({ from: 'src', to: b.key, live: b.tone !== 'standby' && b.tone !== 'offline' });
  if (ingests.length) {
    const onAir = v.status.ingests.filter((i) => i.onAir).map((i) => `i-${i.ref}`);
    for (const i of ingests) for (const r of relays) edges.push({ from: i.key, to: r.key, live: onAir.includes(i.key) && r.tone !== 'offline' });
  }
  for (const r of relays) edges.push({ from: r.key, to: 'out', live: r.tone !== 'offline' });

  const note = v.studio
    ? v.studio.direct
      ? t(`routing.now.${v.studio.direct}`)
      : t('routing.now.ingest', { names: v.studio.ingests.map((i) => i.name).join(` ${t('routing.and')} `), count: v.studio.ingests.length })
    : null;

  return (
    <>
      <Header
        title={t('manage.menu.routing')}
        description={t('manage.text.routing')}
        actions={
          edit && (
            <>
              <Button disabled={!dirty || save.isPending} onClick={() => setForm(v.routing)}>
                <RotateCcw className="size-4" /> {t('routing.undo')}
              </Button>
              <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => void apply()}>
                <Send className="size-4" /> {t('routing.apply')}
              </Button>
            </>
          )
        }
      />
      <div className="flex flex-col gap-4">
        {!edit && <p className="rounded-md border border-line bg-raised px-4 py-3 text-[13px] text-muted">{t('routing.ownerOnly')}</p>}
        {v.locked && (
          <Panel title={t('routing.delivery')}>
            <Segmented
              value={form.delivery}
              onChange={(x) => edit && setForm({ ...form, delivery: x })}
              options={[
                { value: 'ingest', label: t('routing.viaIngest'), description: t('routing.viaIngestHint') },
                { value: 'direct', label: t('routing.direct'), description: t('routing.directHint') },
              ]}
            />
          </Panel>
        )}

        <Panel title={t('routing.pathNow')}>
          <PathDiagram columns={[[source], ingests, relays, [listeners]].filter((c) => c.length)} edges={edges} />
          {note && (
            <p className={clsx('rounded-md border px-3 py-2 text-[13px]', v.studio?.direct && v.studio.direct !== 'chosen' ? 'border-warning/40 bg-warning/10' : 'border-line')}>
              {note}
              {v.studio?.error && <span className="mt-1 block font-mono text-xs text-muted">{t('routing.lastError', { error: v.studio.error })}</span>}
            </p>
          )}
        </Panel>

        {!!v.stale.length && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">{t('routing.stale', { names: v.stale.map((x) => x.name).join(', '), count: v.stale.length })}</p>
        )}

        <div className="grid items-start gap-4 xl:grid-cols-2">
          {(!v.locked || form.delivery === 'ingest') && (
            <Panel title={t('routing.ingest')}>
              <Field label={t('routing.mainIngest')} hint={v.locked ? t('routing.mainHintNode') : v.autodjHere ? t('routing.autodjHere') : t('routing.mainIngestHint')}>
                <Select
                  value={form.ingest}
                  disabled={!edit || (!v.locked && v.autodjHere)}
                  onChange={(e) => setForm({ ...form, ingest: e.target.value, backupIngest: form.backupIngest === e.target.value ? null : form.backupIngest })}
                >
                  {v.locked ? <option value="local">{t('routing.auto')}</option> : !v.orchestratorOnly && <option value="local">{nodes.find((n) => n.id === 'main')?.name ?? t('manage.thisServer')}</option>}
                  {nodeOptions}
                </Select>
              </Field>
              <Field label={t('routing.backupIngest')} hint={v.locked ? t('routing.backupHintNode') : t('routing.backupIngestHint')}>
                <Select value={form.backupIngest ?? ''} disabled={!edit} onChange={(e) => setForm({ ...form, backupIngest: e.target.value || null })}>
                  <option value="">{t('routing.noBackup')}</option>
                  {!v.locked && !v.orchestratorOnly && form.ingest !== 'local' && <option value="local">{t('manage.thisServer')}</option>}
                  {nodeOptions}
                </Select>
              </Field>
            </Panel>
          )}
          <Panel title={t('routing.relays')}>
            <Segmented
              value={chosen ? 'chosen' : 'auto'}
              onChange={(x) => edit && setForm({ ...form, relays: x === 'auto' ? 'auto' : v.status.relays.filter((r) => !r.spare).map((r) => r.id) })}
              options={[
                { value: 'auto', label: t('routing.relaysAuto'), description: t('routing.relaysAutoHint') },
                { value: 'chosen', label: t('routing.relaysChosen'), description: t('routing.relaysChosenHint') },
              ]}
            />
            {chosen && (
              <div className="flex flex-col gap-2">
                {v.options.relays.length === 0 && <p className="text-[13px] text-muted">{t('routing.noRelays')}</p>}
                {v.options.relays.map((n) => (
                  <label key={n.id} className="flex items-center gap-2.5 rounded-md border border-line px-3 py-2 text-[13px]">
                    <input type="checkbox" className="accent-koraal" disabled={!edit} checked={chosen.includes(n.id)} onChange={() => toggleRelay(n.id)} />
                    <span className="min-w-0 flex-1 truncate font-semibold">{n.name}</span>
                    {n.location && <span className="truncate text-xs text-muted">{n.location}</span>}
                    <Badge tone={n.online ? 'online' : 'offline'} dot>
                      {t(n.online ? 'manage.state.online' : 'manage.state.offline')}
                    </Badge>
                  </label>
                ))}
              </div>
            )}
            {chosen && <Switch checked={form.spareRelays} disabled={!edit} onChange={(x) => setForm({ ...form, spareRelays: x })} label={t('routing.spare')} description={t('routing.spareHint')} />}
          </Panel>
        </div>
        {error && <p className="text-[13px] text-offline">{error}</p>}
      </div>
    </>
  );
}
