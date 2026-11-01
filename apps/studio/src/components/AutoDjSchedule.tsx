import clsx from 'clsx';
import { CalendarDays, ChevronLeft, ChevronRight, Mic } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClockDonut } from './ClockDonut';
import { Label } from './manage/common';
import { addDays, hhmm, inkOn, piecesOn, weekdayOf, type Piece } from './manage/Schedule';
import { Badge, Button, Card, Dialog, EmptyState } from './ui';
import type { Clock, ScheduleEntry, SchedulerView } from '../lib/api';
import { clockLayout, paint, type useItemInfo } from '../lib/clocks';

type Info = ReturnType<typeof useItemInfo>;
const WEEK_HOUR_PX = 22;

/** The colour of a block: its clock, coral for a live show without a clock, grey for queues only. */
function colorOf(entry: ScheduleEntry, clocks: Map<string, Clock>) {
  const clock = entry.clockId ? clocks.get(entry.clockId) : undefined;
  const color = paint(clock?.color ?? (entry.live ? '#FF6B57' : '#4F5B73'));
  return color === 'var(--ink)' ? '#C9D1E3' : color;
}

/** One block of the schedule: when it runs, its clock, live or not, its DJs. Only to look at. */
function EntryDetails({ view, info, entry, onClose }: { view: SchedulerView; info: Info; entry: ScheduleEntry | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  if (!entry) return null;
  const clocks = new Map(view.clocks.map((c) => [c.id, c]));
  const clock = entry.clockId ? clocks.get(entry.clockId) : undefined;
  const djs = entry.accountIds
    .map((id) => view.accounts.find((a) => a.id === id))
    .filter((a) => !!a)
    .map((a) => a.displayName || a.username);
  const dayName = (d: number) =>
    new Intl.DateTimeFormat(i18n.language, {
      weekday: 'long',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2024, 0, d)));
  const when = entry.date
    ? new Intl.DateTimeFormat(i18n.language, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC',
      }).format(new Date(`${entry.date}T12:00:00Z`))
    : entry.days.length === 7
      ? t('autodjView.schedule.everyDay')
      : entry.days.map(dayName).join(', ');
  return (
    <Dialog open onClose={onClose} title={entry.name} description={entry.description || undefined} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="flex gap-5">
        {clock ? (
          <ClockDonut size={160} segments={clockLayout(clock.items, info.seconds)} colorOf={(item) => info.color(item, clock.color)} nameOf={() => ''} title={clock.name} />
        ) : (
          <span className="grid size-[150px] shrink-0 place-items-center rounded-full bg-chip text-[12px] text-muted">{t('autodjView.noClock')}</span>
        )}
        <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] content-start gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-muted">{t('autodjView.schedule.kind')}</dt>
          <dd>
            {entry.live ? (
              <Badge tone="onair">
                <Mic className="size-3" /> {t('autodjView.schedule.liveBadge')}
              </Badge>
            ) : (
              <Badge>{t('autodjView.block')}</Badge>
            )}
            {!entry.enabled && (
              <span className="ml-2">
                <Badge tone="warning">{t('autodjView.schedule.disabled')}</Badge>
              </span>
            )}
          </dd>
          <dt className="text-muted">{t('autodjView.schedule.when')}</dt>
          <dd className="first-letter:uppercase">{when}</dd>
          <dt className="text-muted">{t('autodjView.schedule.time')}</dt>
          <dd className="font-mono tabular">
            {hhmm(entry.startMinute)}–{hhmm(entry.startMinute + entry.durationMinutes)}
          </dd>
          <dt className="text-muted">{t('autodjView.schedule.clock')}</dt>
          <dd className="flex items-center gap-2">
            {clock && <i className="size-2.5 shrink-0 rounded-full" style={{ background: paint(clock.color) }} />}
            {clock?.name ?? t('autodjView.schedule.queuesOnly')}
          </dd>
          {entry.live && (
            <>
              <dt className="text-muted">{t('autodjView.schedule.djs')}</dt>
              <dd>{djs.length ? djs.join(', ') : t('autodjView.schedule.anyDj')}</dd>
            </>
          )}
          <dt className="text-muted">{t('autodjView.schedule.public')}</dt>
          <dd>{entry.isPublic ? t('autodjView.schedule.yes') : t('autodjView.schedule.no')}</dd>
        </dl>
      </div>
    </Dialog>
  );
}

/** Today as a bar of 24 hours with a line at the time now, and the blocks of today as a list under it. */
function Today({ view, onOpen }: { view: SchedulerView; onOpen: (e: ScheduleEntry) => void }) {
  const { t } = useTranslation();
  const clocks = new Map(view.clocks.map((c) => [c.id, c]));
  const pieces = piecesOn(view.entries, view.now.date).sort((a, b) => a.start - b.start);
  const defaultClock = view.settings.defaultClockId ? clocks.get(view.settings.defaultClockId) : undefined;
  const nowMin = view.now.minuteOfDay;
  const pct = (m: number) => `${(m / 1440) * 100}%`;
  const state = (p: Piece) => (nowMin >= p.end ? 'done' : nowMin >= p.start ? 'now' : 'coming');
  return (
    <Card className="p-4">
      <Label>{t('autodjView.schedule.today')}</Label>
      <div className="relative mt-3 h-12 overflow-hidden rounded-md border border-line bg-chip" role="img" aria-label={t('autodjView.schedule.today')}>
        {pieces.map((p) => {
          const fill = colorOf(p.entry, clocks);
          return (
            <button
              key={`${p.entry.id}-${p.start}`}
              type="button"
              onClick={() => onOpen(p.entry)}
              className={clsx(
                'absolute inset-y-1 overflow-hidden rounded px-1.5 text-left text-[11px] leading-[2.5rem] font-bold whitespace-nowrap hover:brightness-105',
                !p.entry.enabled && 'opacity-45',
              )}
              style={{
                left: pct(p.start),
                width: `calc(${pct(p.end - p.start)} - 2px)`,
                background: fill,
                color: inkOn(fill),
                zIndex: 1 + p.depth + (p.entry.date ? 10 : 0),
              }}
              title={`${p.entry.name} · ${hhmm(p.start)}–${hhmm(p.end)}`}
            >
              {p.entry.live && <Mic className="mr-1 inline size-3" />}
              {p.entry.name}
            </button>
          );
        })}
        <div className="pointer-events-none absolute inset-y-0 z-30 w-0.5 bg-koraal" style={{ left: pct(nowMin) }} />
      </div>
      <div className="relative mt-1 h-4 font-mono text-[10px] text-muted tabular">
        {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
          <span key={h} className="absolute" style={{ left: pct(h * 60) }}>
            {String(h).padStart(2, '0')}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[12px] text-muted">
        {t('autodjView.schedule.gaps', {
          name: defaultClock?.name ?? t('autodjView.schedule.queuesOnly'),
        })}
      </p>
      {pieces.length ? (
        <ol className="mt-3 text-[13px]">
          {pieces.map((p) => {
            const clock = p.entry.clockId ? clocks.get(p.entry.clockId) : undefined;
            const s = state(p);
            return (
              <li key={`${p.entry.id}-${p.start}`}>
                <button
                  type="button"
                  onClick={() => onOpen(p.entry)}
                  className={clsx(
                    'flex w-full items-center gap-3 border-t border-line px-1 py-2 text-left hover:bg-hover',
                    s === 'done' && 'text-muted opacity-60',
                    s === 'now' && 'rounded-md border-transparent bg-koraal/10 font-semibold',
                  )}
                >
                  <span className="w-24 shrink-0 font-mono text-[12px] tabular text-muted">
                    {hhmm(p.start)}–{hhmm(p.end)}
                  </span>
                  <i className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(p.entry, clocks) }} />
                  <span className="min-w-0 flex-1 truncate">{p.entry.name}</span>
                  <span className="hidden truncate text-[12px] text-muted sm:inline">{clock?.name ?? t('autodjView.schedule.queuesOnly')}</span>
                  {p.entry.live && (
                    <Badge tone="onair">
                      <Mic className="size-3" /> {t('autodjView.schedule.liveBadge')}
                    </Badge>
                  )}
                  {s === 'now' && <Badge tone="online">{t('autodjView.now')}</Badge>}
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="mt-3 text-[13px] text-muted">{t('autodjView.schedule.noneToday')}</p>
      )}
    </Card>
  );
}

/** The week as seven columns, like the editor of the Manage view but smaller and only to look at. */
function Week({ view, onOpen }: { view: SchedulerView; onOpen: (e: ScheduleEntry) => void }) {
  const { t, i18n } = useTranslation();
  const [week, setWeek] = useState(0);
  const clocks = new Map(view.clocks.map((c) => [c.id, c]));
  const monday = addDays(view.now.date, -(weekdayOf(view.now.date) - 1) + week * 7);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const fmt = (date: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(i18n.language, { ...o, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <Label>
          {t('autodjView.schedule.week')} · {fmt(dates[0]!, { day: 'numeric', month: 'short' })} – {fmt(dates[6]!, { day: 'numeric', month: 'short' })}
        </Label>
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
      <div className="grid grid-cols-[40px_repeat(7,1fr)] border-b border-line">
        <div />
        {dates.map((d) => (
          <div key={d} className={clsx('px-1 py-1.5 text-center', d === view.now.date && 'bg-koraal/8')}>
            <div className="text-[10px] font-bold tracking-[0.06em] text-muted uppercase">{fmt(d, { weekday: 'short' })}</div>
            <div className={clsx('text-[12px] font-semibold', d === view.now.date && 'text-accent-text')}>{fmt(d, { day: 'numeric' })}</div>
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative grid grid-cols-[40px_repeat(7,1fr)]" style={{ height: WEEK_HOUR_PX * 24 }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) =>
              h % 3 === 0 && h ? (
                <span key={h} className="absolute right-1.5 -translate-y-1/2 font-mono text-[10px] text-muted tabular" style={{ top: h * WEEK_HOUR_PX }}>
                  {String(h).padStart(2, '0')}
                </span>
              ) : null,
            )}
          </div>
          {dates.map((date) => (
            <div
              key={date}
              className={clsx('relative border-l border-line', date === view.now.date && 'bg-koraal/[0.04]')}
              style={{
                backgroundImage: `repeating-linear-gradient(to bottom, var(--line) 0 1px, transparent 1px ${WEEK_HOUR_PX * 3}px)`,
              }}
            >
              {piecesOn(view.entries, date).map((p) => {
                const fill = colorOf(p.entry, clocks);
                const height = ((p.end - p.start) / 60) * WEEK_HOUR_PX;
                const onAir = view.onAir.entryId === p.entry.id && date === view.now.date && view.now.minuteOfDay >= p.start && view.now.minuteOfDay < p.end;
                return (
                  <button
                    key={`${p.entry.id}-${p.start}`}
                    type="button"
                    onClick={() => onOpen(p.entry)}
                    className={clsx(
                      'absolute right-0.5 overflow-hidden rounded px-1 py-0.5 text-left text-[10px] leading-tight font-bold hover:brightness-105',
                      !p.entry.enabled && 'opacity-45',
                      onAir && 'ring-2 ring-koraal ring-offset-1 ring-offset-[var(--surface-raised)]',
                    )}
                    style={{
                      top: (p.start / 60) * WEEK_HOUR_PX + 1,
                      height: Math.max(12, height - 2),
                      left: 2 + p.depth * 6,
                      zIndex: 1 + p.depth + (p.entry.date ? 10 : 0),
                      background: fill,
                      color: inkOn(fill),
                    }}
                    title={`${p.entry.name} · ${hhmm(p.start)}–${hhmm(p.end)}`}
                  >
                    <span className="flex items-center gap-0.5">
                      {p.entry.live && <Mic className="size-2.5 shrink-0" />}
                      <span className="truncate">{p.entry.name}</span>
                    </span>
                  </button>
                );
              })}
              {date === view.now.date && week === 0 && <div className="pointer-events-none absolute inset-x-0 z-30 h-0.5 bg-koraal" style={{ top: (view.now.minuteOfDay / 60) * WEEK_HOUR_PX }} />}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** The schedule tab of the AutoDJ view: today and the week, only to look at. A click on a block shows its details. */
export function AutoDjSchedule({ view, info }: { view: SchedulerView; info: Info }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<ScheduleEntry | null>(null);
  if (!view.settings.enabled && !view.entries.length) {
    return (
      <Card>
        <EmptyState icon={<CalendarDays className="size-6" />} title={t('autodjView.schedule.emptyTitle')} description={t('autodjView.schedulerOffText')} />
      </Card>
    );
  }
  return (
    <>
      {!view.settings.enabled && <p className="text-[13px] text-warning">{t('autodjView.schedule.offNote')}</p>}
      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Today view={view} onOpen={setOpen} />
        <Week view={view} onOpen={setOpen} />
      </div>
      <EntryDetails view={view} info={info} entry={open} onClose={() => setOpen(null)} />
    </>
  );
}
