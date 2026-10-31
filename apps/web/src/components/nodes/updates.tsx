import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, ArrowUpCircle, CalendarClock, Pause, Play, Plus, RotateCcw, Trash2, X, Zap } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, type NodeItem, type NodeRolloutInfo, type NodesSettings, type NodeUpdateInfo, type NodeUpdatesSettings, type UpdateGroup, type UpdatePolicy, type UpdateWindow } from '../../lib/api';
import { formatDate, shortCommit } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Spinner, Switch } from '../ui';

export const POLICIES: UpdatePolicy[] = ['rolling', 'window', 'manual'];
/** Monday first, as in the Netherlands; the values are JavaScript days (0 = Sunday). */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const RUNNING = new Set(['draining', 'updating', 'checking', 'rollingBack']);

const stateTone: Record<NodeUpdateInfo['state'], 'online' | 'warning' | 'offline' | 'neutral' | 'accent'> = {
  upToDate: 'online',
  waiting: 'accent',
  scheduled: 'neutral',
  manual: 'neutral',
  paused: 'warning',
  disabled: 'neutral',
  failed: 'offline',
  queued: 'accent',
  draining: 'accent',
  updating: 'accent',
  checking: 'accent',
  rollingBack: 'warning',
};

/** The current time, every second, for countdowns and progress bars. */
function useNow(on = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** "Mon–Fri 03:00–05:00" */
export function useWindowText() {
  const { t } = useTranslation();
  return (w: UpdateWindow) => {
    if (!w.days.length) return t('nodeUpdates.window.never');
    const days = w.days.length === 7 ? t('nodeUpdates.window.everyDay') : WEEK.filter((d) => w.days.includes(d)).map((d) => t(`nodeUpdates.days.${d}`)).join(' ');
    return `${days} ${w.start}–${w.end}`;
  };
}

/** Compact state of a node's update, for lists. */
export function UpdateBadge({ update, available }: { update: NodeUpdateInfo; available: boolean }) {
  const { t } = useTranslation();
  if (update.state === 'upToDate' && !available) return null;
  const when = update.state === 'scheduled' && update.nextWindowAt ? ` · ${formatDate(update.nextWindowAt)}` : update.state === 'queued' && update.queuePosition ? ` #${update.queuePosition}` : '';
  return (
    <span title={update.message ?? undefined}>
      <Badge tone={stateTone[update.state]} dot={RUNNING.has(update.state)}>
        {t(`nodeUpdates.state.${update.state}`)}
        {when}
      </Badge>
    </span>
  );
}

function Progress({ from, to, now }: { from: string; to: string; now: number }) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  const share = b > a ? Math.min(1, Math.max(0, (now - a) / (b - a))) : 1;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
      <div className="h-full rounded-full bg-koraal transition-[width] duration-1000" style={{ width: `${share * 100}%` }} />
    </div>
  );
}

/** The update of one node: policy, what comes next, the running step, the last result, and its buttons. */
export function NodeUpdateCard({ node, canEdit }: { node: NodeItem; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const u = node.update;
  const running = RUNNING.has(u.state);
  const now = useNow(running);
  const windowText = useWindowText();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['nodes'] });
  const act = useMutation({
    mutationFn: (what: 'update' | 'rollback' | 'cancel') => api<{ position?: number }>(`/nodes/${node.id}/${what === 'cancel' ? 'update/cancel' : what}`, { method: 'POST' }),
    onSuccess: (res, what) => {
      toast.success(what === 'cancel' ? t('nodeUpdates.cancelled') : t('nodeUpdates.queuedToast', { position: res.position ?? 1 }));
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const behind = !!node.status.commit && !!u.target.commit && node.status.commit !== u.target.commit;
  const policy = `${t(`nodeUpdates.policy.${u.policy}`)}${u.policy === 'window' ? ` · ${windowText(u.window)}` : ''}`;
  const from = u.source === 'group' && u.group ? t('nodeUpdates.source.group', { name: u.group.name }) : t(`nodeUpdates.source.${u.source}`);

  return (
    <Card>
      <CardHeader
        title={t('nodeUpdates.cardTitle')}
        description={t('nodeUpdates.cardHint')}
        actions={
          canEdit && node.paired ? (
            <div className="flex flex-wrap gap-2">
              {(u.state === 'queued' || u.state === 'draining') && (
                <Button size="sm" loading={act.isPending} onClick={() => act.mutate('cancel')}>
                  <X className="size-4" /> {t('nodeUpdates.cancel')}
                </Button>
              )}
              {u.last?.rollbackTo && !running && u.state !== 'queued' && (
                <Button size="sm" loading={act.isPending} onClick={() => confirm(t('nodeUpdates.rollbackConfirm', { commit: shortCommit(u.last!.rollbackTo) })) && act.mutate('rollback')}>
                  <RotateCcw className="size-4" /> {t('nodeUpdates.rollback')}
                </Button>
              )}
              {behind && !running && u.state !== 'queued' && (
                <Button size="sm" variant="primary" disabled={!node.status.online} loading={act.isPending} onClick={() => act.mutate('update')}>
                  <ArrowUpCircle className="size-4" /> {t('nodes.detail.updateNow')}
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <UpdateBadge update={u} available />
          <span className="text-[13px]">
            <span className="font-mono">{shortCommit(node.status.commit) || '—'}</span>
            {behind && (
              <>
                {' → '}
                <span className="font-mono font-semibold">{shortCommit(u.target.commit)}</span>
              </>
            )}
          </span>
        </div>
        {running && (
          <div className="flex flex-col gap-2 rounded-md border border-line p-3">
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span className="font-semibold">{t(`nodeUpdates.phaseText.${u.state}`)}</span>
              {u.phaseEndsAt && <span className="tabular-nums text-muted">{mmss(Date.parse(u.phaseEndsAt) - now)}</span>}
            </div>
            {u.phaseAt && u.phaseEndsAt ? <Progress from={u.phaseAt} to={u.phaseEndsAt} now={now} /> : <div className="h-1.5 w-full animate-pulse rounded-full bg-koraal/40" />}
            {u.message && <p className="text-xs text-muted">{u.message}</p>}
          </div>
        )}
        {(u.state === 'failed' || u.state === 'paused') && u.message && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{u.message}</p>}
        <div className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2">
          <div>
            <div className="text-xs text-muted">{t('nodeUpdates.policyLabel')}</div>
            <div className="font-semibold">{policy}</div>
            <div className="text-xs text-muted">{from}</div>
          </div>
          <div>
            <div className="text-xs text-muted">{t('nodeUpdates.next')}</div>
            <div className="font-semibold">
              {!behind
                ? t('nodeUpdates.nothing')
                : running
                  ? t('nodeUpdates.now')
                  : u.state === 'scheduled' && u.nextWindowAt
                    ? formatDate(u.nextWindowAt)
                  : t(`nodeUpdates.nextText.${u.state}`, { defaultValue: t(`nodeUpdates.state.${u.state}`) })}
            </div>
          </div>
          {u.last && (
            <div className="sm:col-span-2">
              <div className="text-xs text-muted">{t('nodeUpdates.last')}</div>
              <div>
                <Badge tone={u.last.state === 'succeeded' ? 'online' : 'offline'}>{t(`nodeUpdates.result.${u.last.state}`)}</Badge>{' '}
                <span className="font-mono text-xs">
                  {shortCommit(u.last.from.commit)} → {shortCommit(u.last.target.commit)}
                </span>{' '}
                <span className="text-xs text-muted">{formatDate(u.last.at)}</span>
              </div>
              {u.last.message && <div className="mt-1 text-xs text-muted">{u.last.message}</div>}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Day toggles and two times. */
export function WindowEditor({ value, onChange }: { value: UpdateWindow; onChange: (w: UpdateWindow) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {WEEK.map((d) => {
          const on = value.days.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              onClick={() => onChange({ ...value, days: on ? value.days.filter((x) => x !== d) : [...value.days, d].sort() })}
              className={clsx('h-8 min-w-11 rounded-sm border px-2 text-[13px] font-semibold transition-colors', on ? 'border-koraal bg-koraal/10 text-ink' : 'border-line text-muted hover:bg-hover')}
            >
              {t(`nodeUpdates.days.${d}`)}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-[13px]">
        <Input type="time" className="w-32" value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} aria-label={t('nodeUpdates.window.start')} />
        <span className="text-muted">–</span>
        <Input type="time" className="w-32" value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} aria-label={t('nodeUpdates.window.end')} />
      </div>
    </div>
  );
}

function PolicyPicker({ value, onChange, inherit }: { value: string; onChange: (v: string) => void; inherit?: ReactNode }) {
  const { t } = useTranslation();
  const options = [...(inherit ? ['inherit'] : []), ...POLICIES];
  return (
    <div className={clsx('grid gap-2', inherit ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3')}>
      {options.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={clsx('rounded-md border p-3 text-left transition-colors', value === p ? 'border-koraal bg-koraal/8 ring-1 ring-koraal' : 'border-line hover:bg-hover')}
        >
          <div className="text-sm font-semibold">{p === 'inherit' ? t('nodeUpdates.policy.inherit') : t(`nodeUpdates.policy.${p}`)}</div>
          <div className="mt-0.5 text-xs text-muted">{p === 'inherit' ? inherit : t(`nodeUpdates.policyHint.${p}`)}</div>
        </button>
      ))}
    </div>
  );
}

/** The update part of a node's settings. Groups are the administrator's. */
export function NodeUpdateSettings({
  node,
  value,
  onChange,
  admin,
}: {
  node: NodeItem;
  value: Pick<NodeItem['config'], 'updatePolicy' | 'updateGroup' | 'updateWindow'>;
  onChange: (v: Partial<NodeItem['config']>) => void;
  admin: boolean;
}) {
  const { t } = useTranslation();
  const settings = useQuery({ queryKey: ['nodes', 'settings'], queryFn: () => api<NodesSettings>('/nodes/settings'), enabled: admin });
  const windowText = useWindowText();
  const groups = settings.data?.updates.groups ?? [];
  const inherited = node.update;
  const inheritText =
    value.updatePolicy === 'inherit' && inherited.source !== 'node'
      ? t('nodeUpdates.inheritNow', { policy: t(`nodeUpdates.policy.${inherited.policy}`) })
      : t('nodeUpdates.inheritHint');
  const showWindow = value.updatePolicy === 'window';
  return (
    <Card>
      <CardHeader title={t('nodeUpdates.settingsTitle')} description={t('nodeUpdates.settingsHint')} />
      <div className="flex flex-col gap-4 p-5">
        {admin && (
          <Field label={t('nodeUpdates.group')} hint={t('nodeUpdates.groupHint')}>
            <Select value={value.updateGroup ?? ''} onChange={(e) => onChange({ updateGroup: e.target.value || null })}>
              <option value="">{t('nodeUpdates.noGroup')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} · {t(`nodeUpdates.policy.${g.policy}`)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('nodeUpdates.policyLabel')}>
          <PolicyPicker value={value.updatePolicy} onChange={(p) => onChange({ updatePolicy: p as NodeItem['config']['updatePolicy'] })} inherit={inheritText} />
        </Field>
        {showWindow && (
          <Field label={t('nodeUpdates.window.label')} hint={value.updateWindow ? t('nodeUpdates.window.ownHint') : t('nodeUpdates.window.inheritedHint', { window: windowText(inherited.window) })}>
            <div className="flex flex-col gap-2">
              <Switch checked={!!value.updateWindow} onChange={(own) => onChange({ updateWindow: own ? { ...inherited.window } : null })} label={t('nodeUpdates.window.own')} />
              {value.updateWindow && <WindowEditor value={value.updateWindow} onChange={(w) => onChange({ updateWindow: w })} />}
            </div>
          </Field>
        )}
      </div>
    </Card>
  );
}

function slug(name: string, taken: string[]) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'group';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/** Policy for the whole network: on/off, the default, the windows, the timings and the groups. */
export function UpdatePolicyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['nodes', 'settings'], queryFn: () => api<NodesSettings>('/nodes/settings'), enabled: open });
  const [draft, setDraft] = useState<NodeUpdatesSettings | null>(null);
  useEffect(() => {
    if (open && settings.data) setDraft(settings.data.updates);
  }, [open, settings.data]);
  const save = useMutation({
    mutationFn: (updates: NodeUpdatesSettings) => api<NodesSettings>('/nodes/settings', { method: 'PUT', body: { ...settings.data!, autoUpdate: updates.enabled, updates } }),
    onSuccess: (res) => {
      qc.setQueryData(['nodes', 'settings'], res);
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      toast.success(t('nodeUpdates.saved'));
      onClose();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const set = (patch: Partial<NodeUpdatesSettings>) => draft && setDraft({ ...draft, ...patch });
  const setGroup = (i: number, patch: Partial<UpdateGroup>) => draft && set({ groups: draft.groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) });
  const move = (i: number, by: number) => {
    if (!draft) return;
    const groups = [...draft.groups];
    const [g] = groups.splice(i, 1);
    groups.splice(i + by, 0, g!);
    set({ groups });
  };
  const timezones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={t('nodeUpdates.dialogTitle')}
      description={t('nodeUpdates.dialogHint')}
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
        <div className="flex flex-col gap-5">
          <Switch checked={draft.enabled} onChange={(enabled) => set({ enabled })} label={t('nodeUpdates.enabled')} description={t('nodeUpdates.enabledHint')} />
          <Field label={t('nodeUpdates.defaultPolicy')} hint={t('nodeUpdates.defaultPolicyHint')}>
            <PolicyPicker value={draft.policy} onChange={(p) => set({ policy: p as UpdatePolicy })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('nodeUpdates.window.label')} hint={t('nodeUpdates.window.defaultHint')} className="sm:col-span-2">
              <WindowEditor value={draft.window} onChange={(window) => set({ window })} />
            </Field>
            <Field label={t('nodeUpdates.timezone')}>
              {timezones.length ? (
                <Select value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                  {timezones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} />
              )}
            </Field>
            <Field label={t('nodeUpdates.drain')} hint={t('nodeUpdates.drainHint')}>
              <Input type="number" min={0} max={1800} value={draft.drainSeconds} onChange={(e) => set({ drainSeconds: Number(e.target.value) })} />
            </Field>
            <Field label={t('nodeUpdates.health')} hint={t('nodeUpdates.healthHint')}>
              <Input type="number" min={15} max={3600} value={draft.healthSeconds} onChange={(e) => set({ healthSeconds: Number(e.target.value) })} />
            </Field>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">{t('nodeUpdates.groups')}</div>
                <div className="text-xs text-muted">{t('nodeUpdates.groupsHint')}</div>
              </div>
              <Button
                size="sm"
                type="button"
                disabled={draft.groups.length >= 20}
                onClick={() => {
                  const name = t('nodeUpdates.newGroup', { n: draft.groups.length + 1 });
                  set({ groups: [...draft.groups, { id: slug(name, draft.groups.map((g) => g.id)), name, policy: 'rolling', window: { ...draft.window } }] });
                }}
              >
                <Plus className="size-4" /> {t('nodeUpdates.addGroup')}
              </Button>
            </div>
            <div className="mt-2 flex flex-col gap-3">
              {draft.groups.map((g, i) => (
                <div key={g.id} className="rounded-md border border-line p-3">
                  <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 sm:grid-cols-[auto_1fr_12rem_auto]">
                    <span className="grid size-6 place-items-center rounded-full bg-chip text-xs font-bold">{i + 1}</span>
                    <Input className="h-9" maxLength={60} value={g.name} onChange={(e) => setGroup(i, { name: e.target.value })} aria-label={t('nodeUpdates.groupName')} />
                    <div className="col-span-3 row-start-2 sm:col-span-1 sm:row-start-auto">
                      <Select className="h-9" value={g.policy} onChange={(e) => setGroup(i, { policy: e.target.value as UpdatePolicy })} aria-label={t('nodeUpdates.policyLabel')}>
                        {POLICIES.map((p) => (
                          <option key={p} value={p}>
                            {t(`nodeUpdates.policy.${p}`)}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="flex">
                      <Button size="sm" type="button" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('nodeUpdates.up')}>
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button size="sm" type="button" variant="ghost" disabled={i === draft.groups.length - 1} onClick={() => move(i, 1)} aria-label={t('nodeUpdates.down')}>
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button size="sm" type="button" variant="ghost" onClick={() => set({ groups: draft.groups.filter((_, j) => j !== i) })} aria-label={t('common.delete')}>
                        <Trash2 className="size-4 text-offline" />
                      </Button>
                    </div>
                  </div>
                  {g.policy === 'window' && (
                    <div className="mt-3">
                      <WindowEditor value={g.window} onChange={(window) => setGroup(i, { window })} />
                    </div>
                  )}
                </div>
              ))}
              {!draft.groups.length && <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-muted">{t('nodeUpdates.noGroups')}</p>}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** For administrators above the node list: the version nodes get, the node being updated now, and the brakes. */
export function RolloutCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const rollout = useQuery({ queryKey: ['nodes', 'updates'], queryFn: () => api<NodeRolloutInfo>('/nodes/updates'), refetchInterval: 5000 });
  const toggle = useMutation({
    mutationFn: (pause: boolean) => api<NodeRolloutInfo>(`/nodes/updates/${pause ? 'pause' : 'resume'}`, { method: 'POST' }),
    onSuccess: (res) => {
      qc.setQueryData(['nodes', 'updates'], res);
      void qc.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const updateAll = useMutation({
    mutationFn: () => api<NodeRolloutInfo & { sent: number }>('/nodes/updates/all', { method: 'POST' }),
    onSuccess: (res) => {
      qc.setQueryData(['nodes', 'updates'], res);
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      toast.success(t('nodeUpdates.allNowSent', { count: res.sent }));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const r = rollout.data;
  if (!r || !r.paired) return null;
  const all = r.upToDate === r.paired;
  return (
    <Card className={clsx('mb-4', r.paused && 'border-warning/50')}>
      <div className="flex flex-wrap items-center gap-4 px-5 py-4">
        <div className="grid size-10 shrink-0 place-items-center rounded-full bg-koraal/12 text-koraal">
          <CalendarClock className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {t('nodeUpdates.rolloutTitle', { version: r.target.version })} <span className="font-mono text-xs text-muted">{shortCommit(r.target.commit)}</span>
          </div>
          <div className="text-[13px] text-muted">
            {r.current ? (
              <>
                <Link to={`/nodes/${r.current.nodeId}`} className="font-semibold text-ink hover:underline">
                  {r.current.nodeName}
                </Link>{' '}
                · {t(`nodeUpdates.phaseText.${r.current.phase}`)}
              </>
            ) : r.paused ? (
              <span className="text-warning">{t('nodeUpdates.pausedText', { reason: r.paused.nodeName ? `${r.paused.nodeName}: ${r.paused.reason}` : r.paused.reason })}</span>
            ) : !r.enabled ? (
              t('nodeUpdates.offText')
            ) : all ? (
              t('nodeUpdates.allUpToDate')
            ) : (
              t('nodeUpdates.progress', { done: r.upToDate, total: r.paired })
            )}
            {!!r.queue.length && <> · {t('nodeUpdates.inLine', { names: r.queue.map((q) => q.nodeName).join(', ') })}</>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {r.enabled &&
            (r.paused ? (
              <Button size="sm" variant="primary" loading={toggle.isPending} onClick={() => toggle.mutate(false)}>
                <Play className="size-4" /> {t('nodeUpdates.resume')}
              </Button>
            ) : (
              <Button size="sm" loading={toggle.isPending} onClick={() => toggle.mutate(true)}>
                <Pause className="size-4" /> {t('nodeUpdates.pause')}
              </Button>
            ))}
          {!all && (
            <Button size="sm" loading={updateAll.isPending} title={t('nodeUpdates.allNowHint')} onClick={() => confirm(t('nodeUpdates.allNowConfirm', { count: r.paired - r.upToDate })) && updateAll.mutate()}>
              <Zap className="size-4" /> {t('nodeUpdates.allNow')}
            </Button>
          )}
          <Button size="sm" onClick={() => setOpen(true)}>
            <CalendarClock className="size-4" /> {t('nodeUpdates.policyButton')}
          </Button>
        </div>
      </div>
      <UpdatePolicyDialog open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}
