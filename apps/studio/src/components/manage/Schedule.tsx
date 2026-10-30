import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Clock3, Mic, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Header } from './common';
import { Badge, Button, Card, Dialog, Field, Input, Segmented, Select, Spinner, Switch, Textarea } from '../ui';
import { api, type ScheduleEntry, type SchedulerView, type StationListItem } from '../../lib/api';
import { paint, useScheduler } from '../../lib/clocks';
import { ask } from '../../lib/native';

const HOUR_PX = 40;
const DAY_PX = HOUR_PX * 24;
/** Dragging a block moves it in steps of a quarter of an hour. */
const SNAP = 15;

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

/** Dark text on a light block, white on a dark one. */
function inkOn(hex: string) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#14213D';
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#14213D' : '#FFFFFF';
}

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
const draftOf = (e: ScheduleEntry): Draft => {
  const { id: _id, createdAt: _c, ...rest } = e;
  return rest;
};

/** Add or change a block of the schedule: the same form as in the web panel. */
function EntryDialog({ stationId, view, editing, onClose }: { stationId: string; view: SchedulerView; editing: ScheduleEntry | Draft | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(blankEntry(1, 0));
  useEffect(() => {
    if (editing) setDraft('id' in editing ? draftOf(editing) : editing);
  }, [editing]);
  const id = editing && 'id' in editing ? editing.id : null;
  const done = (message: string) => {
    void qc.invalidateQueries({ queryKey: ['scheduler', stationId] });
    void qc.invalidateQueries({ queryKey: ['autodj', stationId] });
    void qc.invalidateQueries({ queryKey: ['rundown', stationId] });
    toast.success(message);
    onClose();
  };
  const save = useMutation({
    mutationFn: () => api(id ? `/stations/${stationId}/schedule/${id}` : `/stations/${stationId}/schedule`, { method: id ? 'PUT' : 'POST', body: draft }),
    onSuccess: () => done(t('schedule.saved')),
    onError: (err) => toast.error((err as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/stations/${stationId}/schedule/${id}`, { method: 'DELETE' }),
    onSuccess: () => done(t('schedule.deleted')),
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
            <Button variant="danger" className="mr-auto" loading={del.isPending} onClick={() => void ask(t('schedule.deleteConfirm', { name: draft.name })).then((yes) => yes && del.mutate())}>
              <Trash2 className="size-4" /> {t('schedule.delete')}
            </Button>
          )}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form="schedule-form" variant="primary" loading={save.isPending}>
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
          <Field label={t('schedule.name')}>
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
            <span className="block w-48">
              <Input type="date" required value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
            </span>
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
            <span className="w-32">
              <Field label={t('schedule.start')}>
                <Input type="time" required step={300} value={hhmm(draft.startMinute)} onChange={(e) => setDraft({ ...draft, startMinute: parseTime(e.target.value) })} />
              </Field>
            </span>
            <span className="w-32">
              <Field label={t('schedule.end')}>
                <Input type="time" required step={300} value={hhmm(end)} onChange={(e) => setEnd(e.target.value)} />
              </Field>
            </span>
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

/** The settings of the schedule as a whole: on or off, time zone, clock outside the blocks, live rules. */
function SettingsCard({ stationId, view }: { stationId: string; view: SchedulerView }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(view.settings);
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
    mutationFn: () => api<SchedulerView>(`/stations/${stationId}/scheduler`, { method: 'PUT', body: draft }),
    onSuccess: (v) => {
      qc.setQueryData(['scheduler', stationId], v);
      void qc.invalidateQueries({ queryKey: ['autodj', stationId] });
      void qc.invalidateQueries({ queryKey: ['rundown', stationId] });
      toast.success(t('schedule.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.settings);
  return (
    <Card className="mt-4 p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="display text-base">{t('schedule.settings')}</h2>
          <p className="mt-1 text-[13px] text-muted">{t('schedule.settingsHint')}</p>
        </div>
        <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
          {t('common.save')}
        </Button>
      </div>
      <div className="grid gap-x-8 gap-y-4 xl:grid-cols-2">
        <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('schedule.enabledAll')} description={t('schedule.enabledAllHint')} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('schedule.timezone')}>
            <Select value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('schedule.defaultClock')} hint={t('schedule.defaultClockHint')}>
            <Select value={draft.defaultClockId ?? ''} onChange={(e) => setDraft({ ...draft, defaultClockId: e.target.value || null })}>
              <option value="">{t('schedule.queuesOnly')}</option>
              {view.clocks.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Switch checked={draft.publicSchedule} onChange={(publicSchedule) => setDraft({ ...draft, publicSchedule })} label={t('schedule.publicSchedule')} description={t('schedule.publicScheduleHint')} />
        <Switch checked={draft.liveOnlyInShows} onChange={(liveOnlyInShows) => setDraft({ ...draft, liveOnlyInShows })} label={t('schedule.liveOnly')} description={t('schedule.liveOnlyHint')} />
        {draft.liveOnlyInShows && (
          <span className="w-40">
            <Field label={t('schedule.early')} hint={t('schedule.earlyHint')}>
              <Input
                type="number"
                min={0}
                max={60}
                value={draft.liveEarlyMinutes}
                onChange={(e) => setDraft({ ...draft, liveEarlyMinutes: Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))) })}
              />
            </Field>
          </span>
        )}
      </div>
    </Card>
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

/** A block being dragged: where the mouse went down, and how far it moved (minutes, snapped). */
interface Drag {
  id: string;
  y: number;
  delta: number;
  moved: boolean;
}

function WeekGrid({ stationId, view, onNew, onEdit }: { stationId: string; view: SchedulerView; onNew: (day: number, minute: number) => void; onEdit: (e: ScheduleEntry) => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [week, setWeek] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const monday = addDays(view.now.date, -(view.now.weekday - 1) + week * 7);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const clocks = new Map(view.clocks.map((c) => [c.id, c]));
  const accounts = new Map(view.accounts.map((a) => [a.id, a.displayName || a.username]));
  const fmt = (date: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(i18n.language, { ...o, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  const defaultClock = view.settings.defaultClockId ? clocks.get(view.settings.defaultClockId) : undefined;

  // Moving a block keeps its length and days; it is saved when the mouse goes up.
  const move = useMutation({
    mutationFn: ({ entry, start }: { entry: ScheduleEntry; start: number }) => api(`/stations/${stationId}/schedule/${entry.id}`, { method: 'PUT', body: { ...draftOf(entry), startMinute: start } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduler', stationId] });
      void qc.invalidateQueries({ queryKey: ['rundown', stationId] });
      toast.success(t('schedule.moved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (view.now.minuteOfDay / 60 - 2) * HOUR_PX);
    // Only once, when the grid opens.
  }, []);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = Math.round(((e.clientY - d.y) / HOUR_PX) * (60 / SNAP)) * SNAP;
      const next = { ...d, delta, moved: d.moved || Math.abs(e.clientY - d.y) > 4 };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      const entry = view.entries.find((x) => x.id === d.id);
      if (!entry) return;
      if (!d.moved) return onEdit(entry);
      const start = Math.max(0, Math.min(1440 - SNAP, entry.startMinute + d.delta));
      if (start !== entry.startMinute) move.mutate({ entry, start });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag?.id]);

  const click = (e: ReactMouseEvent<HTMLDivElement>, date: string) => {
    if (e.target !== e.currentTarget) return;
    onNew(weekdayOf(date), Math.min(23, Math.floor(e.nativeEvent.offsetY / HOUR_PX)) * 60);
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="text-[13px] text-muted">
          {fmt(dates[0]!, { day: 'numeric', month: 'short' })} – {fmt(dates[6]!, { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" title={t('schedule.prevWeek')} onClick={() => setWeek((w) => w - 1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button size="sm" disabled={week === 0} onClick={() => setWeek(0)}>
            {t('schedule.thisWeek')}
          </Button>
          <Button size="sm" variant="ghost" title={t('schedule.nextWeek')} onClick={() => setWeek((w) => w + 1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-[52px_repeat(7,1fr)] border-b border-line">
        <div />
        {dates.map((d) => (
          <div key={d} className={clsx('px-2 py-2 text-center', d === view.now.date && 'bg-koraal/8')}>
            <div className="text-[11px] font-bold tracking-[0.06em] text-muted uppercase">{fmt(d, { weekday: 'short' })}</div>
            <div className={clsx('text-[13px] font-semibold', d === view.now.date && 'text-accent-text')}>{fmt(d, { day: 'numeric', month: 'short' })}</div>
          </div>
        ))}
      </div>
      <div ref={scroller} className={clsx('max-h-[560px] overflow-y-auto', drag?.moved && 'cursor-grabbing select-none')}>
        <div className="relative grid grid-cols-[52px_repeat(7,1fr)]" style={{ height: DAY_PX }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="absolute right-2 -translate-y-1/2 font-mono text-[10px] text-muted tabular" style={{ top: h * HOUR_PX }}>
                {h ? `${String(h).padStart(2, '0')}:00` : ''}
              </span>
            ))}
          </div>
          {dates.map((date) => (
            <div
              key={date}
              onClick={(e) => click(e, date)}
              className={clsx('relative cursor-copy border-l border-line', date === view.now.date && 'bg-koraal/[0.04]')}
              style={{ backgroundImage: `repeating-linear-gradient(to bottom, var(--line) 0 1px, transparent 1px ${HOUR_PX}px)` }}
            >
              {piecesOn(view.entries, date).map((p) => {
                const clock = p.entry.clockId ? clocks.get(p.entry.clockId) : undefined;
                const color = paint(clock?.color ?? (p.entry.live ? '#FF6B57' : '#4F5B73'));
                const fill = color === 'var(--ink)' ? '#C9D1E3' : color;
                const shift = drag?.id === p.entry.id ? drag.delta : 0;
                const top = ((p.start + shift) / 60) * HOUR_PX;
                const height = ((p.end - p.start) / 60) * HOUR_PX;
                const onAir = view.onAir.entryId === p.entry.id && date === view.now.date && view.now.minuteOfDay >= p.start && view.now.minuteOfDay < p.end;
                const sub = p.entry.live && p.entry.accountIds.length ? p.entry.accountIds.map((id) => accounts.get(id)).filter(Boolean).join(', ') : (clock?.name ?? t('schedule.queuesOnly'));
                return (
                  <button
                    key={`${p.entry.id}-${p.start}`}
                    type="button"
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      const d = { id: p.entry.id, y: e.clientY, delta: 0, moved: false };
                      dragRef.current = d;
                      setDrag(d);
                    }}
                    className={clsx(
                      'absolute right-1 flex cursor-grab flex-col justify-start overflow-hidden rounded-md px-1.5 py-1 text-left text-[11px] leading-tight shadow-sm transition-[filter] hover:brightness-105',
                      !p.entry.enabled && 'opacity-45',
                      onAir && 'ring-2 ring-koraal ring-offset-1 ring-offset-[var(--surface-raised)]',
                      drag?.id === p.entry.id && drag.moved && 'z-40 opacity-85 shadow-lg',
                    )}
                    style={{
                      top: top + 1,
                      height: Math.max(18, height - 2),
                      left: 3 + p.depth * 10,
                      zIndex: drag?.id === p.entry.id ? 40 : 1 + p.depth + (p.entry.date ? 10 : 0),
                      background: fill,
                      color: inkOn(fill),
                    }}
                    title={`${p.entry.name} · ${hhmm(p.entry.startMinute + shift)}–${hhmm(p.entry.startMinute + shift + p.entry.durationMinutes)} · ${sub}`}
                  >
                    <div className="flex items-center gap-1 font-bold">
                      {p.entry.live && <Mic className="size-3 shrink-0" />}
                      <span className="truncate">{p.entry.name}</span>
                    </div>
                    {height > 30 && (
                      <div className="truncate font-mono opacity-75 tabular">
                        {hhmm(p.entry.startMinute + shift)}–{hhmm(p.entry.startMinute + shift + p.entry.durationMinutes)}
                      </div>
                    )}
                    {height > 46 && <div className="truncate opacity-75">{sub}</div>}
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
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line px-4 py-2.5 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Clock3 className="size-3.5" />
          {t('schedule.outside', { name: defaultClock?.name ?? t('schedule.queuesOnly') })}
        </span>
        <span>{t('schedule.gridHint')}</span>
        {move.isPending && <Spinner className="size-4" />}
      </div>
    </Card>
  );
}

/** Weekly schedule in the Manage view (phase 24): which hour clock or show runs when, on the same data as the web panel. */
export function ScheduleSection({ station }: { station: StationListItem }) {
  const { t } = useTranslation();
  const view = useScheduler(station.id);
  const [editing, setEditing] = useState<ScheduleEntry | Draft | null>(null);
  if (view.isPending) return <Spinner />;
  if (!view.data) return <Card className="p-8 text-center text-muted">{(view.error as Error)?.message}</Card>;
  const v = view.data;
  const entry = v.entries.find((e) => e.id === v.onAir.entryId);
  const clock = v.clocks.find((c) => c.id === v.onAir.clockId);
  return (
    <>
      <Header
        title={t('manage.menu.schedule')}
        description={t('manage.text.schedule')}
        actions={
          <Button variant="primary" size="sm" onClick={() => setEditing(blankEntry(v.now.weekday, ((Math.floor(v.now.minuteOfDay / 60) + 1) % 24) * 60))}>
            <Plus className="size-4" /> {t('schedule.addShow')}
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-muted">{t('schedule.nowOnAir', { time: hhmm(v.now.minuteOfDay) })} ·</span>
        {v.settings.enabled ? (
          <>
            <b>{entry?.name ?? t('schedule.outsideBlocks')}</b>
            <span className="inline-flex items-center gap-1.5 text-muted">
              <i className="size-2.5 rounded-full" style={{ background: clock ? paint(clock.color) : 'var(--koraal)' }} />
              {clock ? t('schedule.runsClock', { name: clock.name }) : t('schedule.runsQueues')}
            </span>
            {entry?.live && (
              <Badge tone="accent">
                <Mic className="size-3" /> {t('schedule.kinds.live')}
              </Badge>
            )}
          </>
        ) : (
          <span className="text-warning">{t('schedule.off')}</span>
        )}
        <span className="text-muted">· {v.settings.timezone.replace(/_/g, ' ')}</span>
      </div>
      <WeekGrid stationId={station.id} view={v} onNew={(day, minute) => setEditing(blankEntry(day, minute))} onEdit={(e) => setEditing(e)} />
      <SettingsCard stationId={station.id} view={v} />
      <EntryDialog stationId={station.id} view={v} editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}
