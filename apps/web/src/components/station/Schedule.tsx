import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Mic, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type ScheduleEntry, type SchedulerSettings, type SchedulerView, type StationDetail } from '../../lib/api';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Segmented, Select, Spinner, Switch, Textarea } from '../ui';
import { paint, useScheduler } from './Clocks';

const HOUR_PX = 44;
const DAY_PX = HOUR_PX * 24;

const addDays = (date: string, days: number) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const weekdayOf = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
};
const runsOn = (e: ScheduleEntry, date: string) => (e.date ? e.date === date : e.days.includes(weekdayOf(date)));
export const hhmm = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const parseTime = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

type Draft = Omit<ScheduleEntry, 'id' | 'createdAt'>;
const blankEntry = (day: number, startMinute: number): Draft => ({
  name: '',
  description: '',
  clockId: null,
  live: false,
  accountIds: [],
  days: [day],
  date: null,
  startMinute,
  durationMinutes: 60,
  isPublic: true,
  enabled: true,
});

function EntryDialog({ station, view, editing, onClose }: { station: StationDetail; view: SchedulerView; editing: ScheduleEntry | Draft | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(blankEntry(1, 0));
  useEffect(() => {
    if (!editing) return;
    const { id: _id, createdAt: _c, ...rest } = editing as ScheduleEntry;
    setDraft(rest);
  }, [editing]);
  const id = editing && 'id' in editing ? editing.id : null;
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['scheduler', station.id] });
    void qc.invalidateQueries({ queryKey: ['autodj', station.id] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => api(id ? `/stations/${station.id}/schedule/${id}` : `/stations/${station.id}/schedule`, { method: id ? 'PUT' : 'POST', body: draft }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      done();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/stations/${station.id}/schedule/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('schedule.deleted'));
      done();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const end = draft.startMinute + draft.durationMinutes;
  const setEnd = (v: string) => {
    let d = parseTime(v) - draft.startMinute;
    if (d <= 0) d += 1440;
    setDraft({ ...draft, durationMinutes: Math.max(5, d) });
  };
  const dayName = (d: number) => new Intl.DateTimeFormat(i18n.language, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, d)));

  return (
    <Dialog
      open={!!editing}
      onClose={onClose}
      wide
      title={id ? t('schedule.edit') : t('schedule.add')}
      description={t('schedule.dialogHint')}
      footer={
        <>
          {id && (
            <Button variant="danger" className="mr-auto" loading={del.isPending} onClick={() => confirm(t('schedule.deleteConfirm', { name: draft.name })) && del.mutate()}>
              <Trash2 className="size-4" /> {t('common.delete')}
            </Button>
          )}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form="schedule-form" variant="dark" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="schedule-form" onSubmit={submit} className="flex flex-col gap-4">
        <Segmented<'block' | 'live'>
          value={draft.live ? 'live' : 'block'}
          onChange={(v) => setDraft({ ...draft, live: v === 'live' })}
          options={[
            { value: 'block', label: t('schedule.kinds.block'), description: t('schedule.kinds.blockHint') },
            { value: 'live', label: t('schedule.kinds.live'), description: t('schedule.kinds.liveHint') },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fields.name')}>
            <Input required maxLength={80} value={draft.name} placeholder={draft.live ? t('schedule.showPlaceholder') : t('schedule.blockPlaceholder')} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label={t('schedule.clock')} hint={draft.live ? t('schedule.clockLiveHint') : t('schedule.clockHint')}>
            <Select value={draft.clockId ?? ''} onChange={(e) => setDraft({ ...draft, clockId: e.target.value || null })}>
              <option value="">{t('schedule.queuesOnly')}</option>
              {view.clocks.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('schedule.description')}>
          <Textarea className="min-h-16 font-sans text-sm" maxLength={500} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </Field>
        <div>
          <div className="mb-2 text-[13px] font-semibold">{t('schedule.when')}</div>
          <div className="mb-3 inline-flex rounded-md border border-line p-0.5">
            {(['weekly', 'once'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setDraft(m === 'once' ? { ...draft, date: draft.date ?? view.now.date } : { ...draft, date: null, days: draft.days.length ? draft.days : [view.now.weekday] })}
                className={clsx('rounded-[5px] px-3 py-1 text-[13px] font-semibold', (m === 'once') === !!draft.date ? 'bg-nacht text-white dark:bg-chip' : 'text-muted hover:text-ink')}
              >
                {t(`schedule.repeat.${m}`)}
              </button>
            ))}
          </div>
          {draft.date ? (
            <Input type="date" required className="max-w-48" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => {
                const on = draft.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDraft({ ...draft, days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort() })}
                    className={clsx('h-9 min-w-12 rounded-full border px-3 text-[13px] font-semibold capitalize transition-colors', on ? 'border-koraal bg-koraal text-nacht' : 'border-line hover:bg-hover')}
                  >
                    {dayName(d)}
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label={t('schedule.start')}>
              <Input type="time" required step={300} className="w-32" value={hhmm(draft.startMinute)} onChange={(e) => setDraft({ ...draft, startMinute: parseTime(e.target.value) })} />
            </Field>
            <Field label={t('schedule.end')}>
              <Input type="time" required step={300} className="w-32" value={hhmm(end)} onChange={(e) => setEnd(e.target.value)} />
            </Field>
            <p className="pb-2.5 text-xs text-muted">
              {t('schedule.length', { hours: Math.floor(draft.durationMinutes / 60), minutes: draft.durationMinutes % 60 })}
              {end > 1440 && ` · ${t('schedule.pastMidnight')}`}
            </p>
          </div>
        </div>
        {draft.live && (
          <div>
            <div className="mb-1 text-[13px] font-semibold">{t('schedule.djs')}</div>
            <p className="mb-2 text-xs text-muted">{view.settings.liveOnlyInShows ? t('schedule.djsLimited', { minutes: view.settings.liveEarlyMinutes }) : t('schedule.djsHint')}</p>
            <div className="flex flex-wrap gap-1.5">
              {view.accounts.map((a) => {
                const on = draft.accountIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setDraft({ ...draft, accountIds: on ? draft.accountIds.filter((x) => x !== a.id) : [...draft.accountIds, a.id] })}
                    className={clsx('inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold', on ? 'border-koraal bg-koraal/12 text-accent-text' : 'border-line hover:bg-hover')}
                  >
                    <Mic className="size-3.5" /> {a.displayName || a.username}
                  </button>
                );
              })}
              {!view.accounts.length && <span className="text-xs text-muted">{t('schedule.noAccounts')}</span>}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <Switch checked={draft.isPublic} onChange={(isPublic) => setDraft({ ...draft, isPublic })} label={t('schedule.public')} description={t('schedule.publicHint')} />
          <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('schedule.enabled')} description={t('schedule.enabledHint')} />
        </div>
      </form>
    </Dialog>
  );
}

function SettingsCard({ station, view, canEdit }: { station: StationDetail; view: SchedulerView; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<SchedulerSettings>(view.settings);
  useEffect(() => setDraft(view.settings), [view.settings]);
  const zones = useMemo(() => {
    try {
      const all = Intl.supportedValuesOf('timeZone');
      return all.includes(draft.timezone) ? all : [draft.timezone, ...all];
    } catch {
      return [draft.timezone];
    }
  }, [draft.timezone]);
  const save = useMutation({
    mutationFn: () => api<SchedulerView>(`/stations/${station.id}/scheduler`, { method: 'PUT', body: draft }),
    onSuccess: (v) => {
      qc.setQueryData(['scheduler', station.id], v);
      void qc.invalidateQueries({ queryKey: ['autodj', station.id] });
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.settings);

  return (
    <Card>
      <CardHeader
        title={t('schedule.settings')}
        description={t('schedule.settingsHint')}
        actions={
          canEdit && (
            <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              {t('common.save')}
            </Button>
          )
        }
      />
      <div className="p-5">
        <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
          <Switch disabled={!canEdit} checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('schedule.enabledAll')} description={t('schedule.enabledAllHint')} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('schedule.timezone')}>
              <Select disabled={!canEdit} value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('schedule.defaultClock')} hint={t('schedule.defaultClockHint')}>
              <Select disabled={!canEdit} value={draft.defaultClockId ?? ''} onChange={(e) => setDraft({ ...draft, defaultClockId: e.target.value || null })}>
                <option value="">{t('schedule.queuesOnly')}</option>
                {view.clocks.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Switch disabled={!canEdit} checked={draft.publicSchedule} onChange={(publicSchedule) => setDraft({ ...draft, publicSchedule })} label={t('schedule.publicSchedule')} description={t('schedule.publicScheduleHint')} />
          <Switch disabled={!canEdit} checked={draft.liveOnlyInShows} onChange={(liveOnlyInShows) => setDraft({ ...draft, liveOnlyInShows })} label={t('schedule.liveOnly')} description={t('schedule.liveOnlyHint')} />
          {draft.liveOnlyInShows && (
            <Field label={t('schedule.early')} hint={t('schedule.earlyHint')}>
              <Input
                disabled={!canEdit}
                type="number"
                min={0}
                max={60}
                className="w-24"
                value={draft.liveEarlyMinutes}
                onChange={(e) => setDraft({ ...draft, liveEarlyMinutes: Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))) })}
              />
            </Field>
          )}
        </div>
      </div>
    </Card>
  );
}

/** What runs now: the block, its clock and whether it is a live show. */
function OnAirBanner({ view, onAdd }: { view: SchedulerView; onAdd: (() => void) | null }) {
  const { t } = useTranslation();
  const entry = view.entries.find((e) => e.id === view.onAir.entryId);
  const clock = view.clocks.find((c) => c.id === view.onAir.clockId);
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg bg-nacht px-5 py-4 text-white dark:bg-chip">
      <div className="min-w-0 flex-1">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-white/60 uppercase">
          {t('schedule.nowOnAir', { time: hhmm(view.now.minuteOfDay) })} · {view.settings.timezone.replace(/_/g, ' ')}
        </span>
        {view.settings.enabled ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="display text-xl">{entry?.name ?? t('schedule.outsideBlocks')}</span>
            <span className="inline-flex items-center gap-2 text-sm text-white/75">
              <i className="size-2.5 rounded-full" style={{ background: !clock ? 'var(--koraal)' : clock.color.toUpperCase() === '#14213D' ? '#FFFFFF' : clock.color }} />
              {clock ? t('schedule.runsClock', { name: clock.name }) : t('schedule.runsQueues')}
            </span>
            {entry?.live && (
              <Badge tone="accent">
                <Mic className="size-3" /> {t('schedule.kinds.live')}
              </Badge>
            )}
          </div>
        ) : (
          <div className="mt-1 text-sm text-white/75">{t('schedule.off')}</div>
        )}
      </div>
      {onAdd && (
        <Button variant="primary" onClick={onAdd}>
          <Plus className="size-4" /> {t('schedule.add')}
        </Button>
      )}
    </div>
  );
}

interface Piece {
  entry: ScheduleEntry;
  start: number;
  end: number;
  depth: number;
}

/** The parts of the blocks that fall on a date (a block from the day before can run past midnight). */
function piecesOn(entries: ScheduleEntry[], date: string): Piece[] {
  const yesterday = addDays(date, -1);
  const raw: Omit<Piece, 'depth'>[] = [];
  for (const e of entries) {
    if (runsOn(e, date)) raw.push({ entry: e, start: e.startMinute, end: Math.min(1440, e.startMinute + e.durationMinutes) });
    if (runsOn(e, yesterday) && e.startMinute + e.durationMinutes > 1440) raw.push({ entry: e, start: 0, end: e.startMinute + e.durationMinutes - 1440 });
  }
  // One-off blocks and later starts win: they sit on top, a little indented.
  raw.sort((a, b) => Number(!!a.entry.date) - Number(!!b.entry.date) || a.start - b.start);
  return raw.map((p, i) => ({ ...p, depth: raw.slice(0, i).filter((o) => o.start <= p.start && o.end > p.start).length }));
}

function WeekCalendar({ view, canEdit, onNew, onEdit }: { view: SchedulerView; canEdit: boolean; onNew: (day: number, minute: number) => void; onEdit: (e: ScheduleEntry) => void }) {
  const { t, i18n } = useTranslation();
  const [week, setWeek] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const monday = addDays(view.now.date, -(view.now.weekday - 1) + week * 7);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const clocks = new Map(view.clocks.map((c) => [c.id, c]));
  const accounts = new Map(view.accounts.map((a) => [a.id, a.displayName || a.username]));
  const fmt = (date: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(i18n.language, { ...o, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  const defaultClock = view.settings.defaultClockId ? clocks.get(view.settings.defaultClockId) : undefined;

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (view.now.minuteOfDay / 60 - 2) * HOUR_PX);
    // Only once, when the calendar opens.
  }, []);

  const click = (e: MouseEvent<HTMLDivElement>, date: string) => {
    if (!canEdit || e.target !== e.currentTarget) return;
    const y = e.nativeEvent.offsetY;
    onNew(weekdayOf(date), Math.min(23, Math.floor(y / HOUR_PX)) * 60);
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <CalendarDays className="size-4 text-accent-text" /> {t('schedule.week')}
          </span>
        }
        description={`${fmt(dates[0]!, { day: 'numeric', month: 'short' })} – ${fmt(dates[6]!, { day: 'numeric', month: 'short', year: 'numeric' })}`}
        actions={
          <>
            <Button size="sm" variant="ghost" title={t('schedule.prevWeek')} onClick={() => setWeek((w) => w - 1)}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button size="sm" disabled={week === 0} onClick={() => setWeek(0)}>
              {t('schedule.thisWeek')}
            </Button>
            <Button size="sm" variant="ghost" title={t('schedule.nextWeek')} onClick={() => setWeek((w) => w + 1)}>
              <ChevronRight className="size-4" />
            </Button>
          </>
        }
      />
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="grid grid-cols-[52px_repeat(7,1fr)] border-b border-line bg-raised">
            <div />
            {dates.map((d) => (
              <div key={d} className={clsx('border-l border-line px-2 py-2 text-center', d === view.now.date && 'bg-koraal/8')}>
                <div className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{fmt(d, { weekday: 'short' })}</div>
                <div className={clsx('display text-lg', d === view.now.date && 'text-accent-text')}>{fmt(d, { day: 'numeric' })}</div>
              </div>
            ))}
          </div>
          <div ref={scroller} className="max-h-[620px] overflow-y-auto">
            <div className="relative grid grid-cols-[52px_repeat(7,1fr)]" style={{ height: DAY_PX }}>
              <div className="relative">
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} className="absolute right-2 -translate-y-1/2 text-[10px] text-muted tabular-nums" style={{ top: h * HOUR_PX }}>
                    {h ? `${String(h).padStart(2, '0')}:00` : ''}
                  </span>
                ))}
              </div>
              {dates.map((date) => (
                <div
                  key={date}
                  onClick={(e) => click(e, date)}
                  className={clsx('relative border-l border-line', canEdit && 'cursor-copy', date === view.now.date && 'bg-koraal/[0.04]')}
                  style={{ backgroundImage: `repeating-linear-gradient(to bottom, var(--line) 0 1px, transparent 1px ${HOUR_PX}px)` }}
                >
                  {piecesOn(view.entries, date).map((p) => {
                    const clock = p.entry.clockId ? clocks.get(p.entry.clockId) : undefined;
                    const color = paint(clock?.color ?? (p.entry.live ? '#FF6B57' : '#4F5B73'));
                    const height = ((p.end - p.start) / 60) * HOUR_PX;
                    const onAir = view.onAir.entryId === p.entry.id && date === view.now.date && view.now.minuteOfDay >= p.start && view.now.minuteOfDay < p.end;
                    return (
                      <button
                        key={`${p.entry.id}-${p.start}`}
                        type="button"
                        onClick={() => onEdit(p.entry)}
                        className={clsx(
                          'absolute right-1 flex flex-col justify-start overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-left text-[11px] leading-tight shadow-sm transition-[filter] hover:brightness-95',
                          !p.entry.enabled && 'opacity-45',
                          onAir && 'ring-2 ring-koraal',
                        )}
                        style={{
                          top: (p.start / 60) * HOUR_PX + 1,
                          height: Math.max(18, height - 2),
                          left: 4 + p.depth * 10,
                          zIndex: 1 + p.depth + (p.entry.date ? 10 : 0),
                          borderLeftColor: color,
                          background: `color-mix(in srgb, ${color} 16%, var(--surface-raised))`,
                        }}
                        title={`${p.entry.name} · ${hhmm(p.entry.startMinute)}–${hhmm(p.entry.startMinute + p.entry.durationMinutes)}`}
                      >
                        <div className="flex items-center gap-1 font-bold">
                          {p.entry.live && <Mic className="size-3 shrink-0 text-accent-text" />}
                          <span className="truncate">{p.entry.name}</span>
                        </div>
                        {height > 30 && (
                          <div className="truncate text-muted tabular-nums">
                            {hhmm(p.entry.startMinute)}–{hhmm(p.entry.startMinute + p.entry.durationMinutes)}
                          </div>
                        )}
                        {height > 46 && (
                          <div className="truncate text-muted">
                            {p.entry.live && p.entry.accountIds.length
                              ? p.entry.accountIds.map((id) => accounts.get(id)).filter(Boolean).join(', ')
                              : (clock?.name ?? t('schedule.queuesOnly'))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                  {date === view.now.date && (
                    <div className="pointer-events-none absolute inset-x-0 z-30 flex items-center" style={{ top: (view.now.minuteOfDay / 60) * HOUR_PX }}>
                      <i className="-ml-1 size-2 rounded-full bg-koraal" />
                      <div className="h-0.5 flex-1 bg-koraal" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line px-5 py-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Clock3 className="size-3.5" />
          {t('schedule.outside', { name: defaultClock?.name ?? t('schedule.queuesOnly') })}
        </span>
        {canEdit && <span>{t('schedule.clickHint')}</span>}
      </div>
    </Card>
  );
}

export function ScheduleTab({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const view = useScheduler(station.id);
  const [editing, setEditing] = useState<ScheduleEntry | Draft | null>(null);

  if (view.isPending) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  if (!view.data) return <Card className="p-8 text-center text-muted">{(view.error as Error)?.message}</Card>;
  const v = view.data;
  return (
    <div className="flex flex-col gap-4">
      <OnAirBanner view={v} onAdd={canEdit ? () => setEditing(blankEntry(v.now.weekday, ((Math.floor(v.now.minuteOfDay / 60) + 1) % 24) * 60)) : null} />
      <WeekCalendar view={v} canEdit={canEdit} onNew={(day, minute) => setEditing(blankEntry(day, minute))} onEdit={(e) => canEdit && setEditing(e)} />
      <SettingsCard station={station} view={v} canEdit={canEdit} />
      {canEdit && <EntryDialog station={station} view={v} editing={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
