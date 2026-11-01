import clsx from 'clsx';
import { Clock3, ListMusic, Lock, Mic, Music2, Newspaper, Pencil, Radio } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AutoDjSchedule } from '../components/AutoDjSchedule';
import { ClockDonut } from '../components/ClockDonut';
import { Label } from '../components/manage/common';
import { Badge, Button, Card, EmptyState, Spinner, Tabs } from '../components/ui';
import type { Clock, RundownRow, StationListItem } from '../lib/api';
import { clockLayout, paint, usePlaylists, useItemInfo, useScheduler } from '../lib/clocks';
import { trackLength } from '../lib/cues';
import { duration } from '../lib/format';
import { useCanManage } from '../lib/layout';
import { useOpenInManage } from '../lib/manageTarget';
import { useNow } from '../lib/now';
import { useAutoDj, useRundown, useStatus } from '../lib/queries';
import { blocksOf } from '../lib/timeline';

/** How many hours the view looks ahead, the current one included. */
const HOURS = 6;

interface Hour {
  /** Start of the hour (epoch ms). */
  at: number;
  rows: RundownRow[];
  clock: RundownRow['clock'];
  show: RundownRow['show'];
}

/** The rundown split into its hours, in the order the server sends them. */
function hoursOf(rows: RundownRow[]): Hour[] {
  const out: Hour[] = [];
  for (const r of rows) {
    const at = new Date(r.hour).getTime();
    let h = out[out.length - 1];
    if (!h || h.at !== at) {
      h = { at, rows: [], clock: r.clock, show: r.show };
      out.push(h);
    }
    h.rows.push(r);
  }
  return out;
}

function SourceIcon({ row }: { row: RundownRow }) {
  const cls = 'size-3.5 shrink-0 text-muted';
  if (row.source === 'news') return <Newspaper className={cls} />;
  if (row.source === 'track') return <Radio className={cls} />;
  if (row.kind === 'music') return <Music2 className={cls} />;
  return <ListMusic className={cls} />;
}

/** A big value with a small label above it, for the strip at the top. */
function Fact({ label, children, sub }: { label: ReactNode; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-raised px-4 py-3">
      <Label>{label}</Label>
      <div className="mt-1 truncate text-[15px] font-semibold">{children}</div>
      {sub && <div className="mt-0.5 truncate text-[12px] text-muted">{sub}</div>}
    </div>
  );
}

/**
 * The AutoDJ view of Live assist: what the AutoDJ plays now and in the coming hours. The hour clock on air as a dial
 * with a hand at the minute now, its items with the part already played dimmed, and the hours after it with their clock
 * and show. Only to look at: hour clocks and the schedule are changed in the Manage view or the web panel.
 */
export function AutoDjView({ station }: { station: StationListItem }) {
  const { t } = useTranslation();
  const autodj = useAutoDj(station.id);
  const status = useStatus(station.id);
  const rundown = useRundown(station.id, true, HOURS);
  const scheduler = useScheduler(station.id);
  const playlists = usePlaylists(station.id);
  const info = useItemInfo(playlists.data, scheduler.data?.tracks ?? [], {});
  // Managers jump from here to the clock or block in the Manage view; DJs only look.
  const canManage = useCanManage();
  const openInManage = useOpenInManage();
  const now = useNow(1000);
  const [tab, setTab] = useState<'now' | 'schedule'>('now');

  if (rundown.isPending || autodj.isPending) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  if (!rundown.data) return <EmptyState icon={<Clock3 className="size-6" />} title={t('autodjView.loadFailed')} description={(rundown.error as Error)?.message} />;

  const tz = rundown.data.timezone;
  const time = (ms: number | string) =>
    new Date(ms).toLocaleTimeString('nl-NL', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: tz,
    });
  const hours = hoursOf(rundown.data.rows);
  const current = hours[0];
  const clocks = new Map<string, Clock>((scheduler.data?.clocks ?? []).map((c) => [c.id, c]));
  const clock = current?.clock ? clocks.get(current.clock.id) : undefined;
  const segments = clock ? clockLayout(clock.items, info.seconds) : [];
  const step = current?.rows.findIndex((r) => r.current) ?? -1;
  const minute = current ? Math.min(59.99, Math.max(0, (now - current.at) / 60_000)) : null;

  // What is on air: a live DJ goes first, then the AutoDJ and its state.
  const data = autodj.data;
  const live = status.data?.live[0];
  const np = data?.playout?.holding ? null : (data?.nowPlaying ?? null);
  const next = data?.queues.q1.find((r) => r.id !== np?.id);
  const total = np ? trackLength(np.media) : null;
  const elapsed = np?.startedAt ? (now - new Date(np.startedAt).getTime()) / 1000 : 0;
  const stuck = data?.player.stuckSince ?? null;
  const state = live
    ? {
        tone: 'onair' as const,
        text: t('autodjView.live', { name: live.accountName }),
      }
    : stuck
      ? {
          tone: 'offline' as const,
          text: t('autodjView.stuck', { time: time(stuck) }),
        }
      : data?.playout?.manual && data.playout.holding
        ? { tone: 'warning' as const, text: t('autodjView.holding') }
        : np
          ? { tone: 'online' as const, text: t('autodjView.playing') }
          : { tone: 'neutral' as const, text: t('autodjView.silent') };
  const block = rundown.data.enabled ? blocksOf(rundown.data.rows, now)[0] : undefined;
  // The next hour where another block or show of the schedule starts.
  const change = hours.slice(1).find((h) => (h.show?.id ?? null) !== (current?.show?.id ?? null));
  const label = (r: RundownRow) => r.label || (r.kind === 'music' ? t('autodjView.music') : t(`autodjView.source.${r.source}`));

  return (
    <div className="flex h-full min-h-[560px] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="display text-[22px] leading-tight">{t('layout.autodj')}</h1>
        <Badge tone={state.tone} dot>
          {state.text}
        </Badge>
        {!rundown.data.enabled && <Badge tone="warning">{t('autodjView.schedulerOff')}</Badge>}
      </div>
      <div className="-mb-1">
        <Tabs<'now' | 'schedule'>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'now', label: t('autodjView.tab.now') },
            { value: 'schedule', label: t('autodjView.tab.schedule') },
          ]}
        />
      </div>
      {tab === 'schedule' ? (
        scheduler.data ? (
          <AutoDjSchedule view={scheduler.data} info={info} onEdit={canManage ? (entryId) => openInManage({ section: 'schedule', entryId }) : undefined} />
        ) : scheduler.isPending ? (
          <Spinner />
        ) : (
          <EmptyState icon={<Clock3 className="size-6" />} title={t('autodjView.loadFailed')} description={(scheduler.error as Error)?.message} />
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Fact
              label={t('autodjView.onAir')}
              sub={
                next
                  ? t('autodjView.next', {
                      title: [next.media.artist, next.media.title].filter(Boolean).join(' – ') || next.label || '',
                    })
                  : undefined
              }
            >
              {np ? [np.media.artist, np.media.title].filter(Boolean).join(' – ') || np.label : <span className="text-muted">{t('autodjView.nothing')}</span>}
              {np && total ? (
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-chip">
                    <div
                      className="h-full bg-koraal transition-[width]"
                      style={{
                        width: `${Math.min(100, (elapsed / total) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="font-mono text-[11px] tabular text-muted">-{duration(Math.max(0, total - elapsed))}</span>
                </div>
              ) : null}
            </Fact>
            <Fact
              label={t('autodjView.clockNow')}
              sub={
                !rundown.data.enabled
                  ? t('autodjView.schedulerOff')
                  : current?.show
                    ? t(current.show.live ? 'autodjView.inLiveShow' : 'autodjView.inBlock', { name: current.show.name })
                    : t('autodjView.noBlock')
              }
            >
              {current?.clock ? (
                <span className="flex items-center gap-2">
                  <i className="size-2.5 shrink-0 rounded-full" style={{ background: paint(current.clock.color) }} />
                  <span className="truncate">{current.clock.name}</span>
                </span>
              ) : (
                <span className="text-muted">{t('autodjView.noClock')}</span>
              )}
            </Fact>
            <Fact label={t('autodjView.nextFixed')} sub={block ? `${time(block.at)} · ${block.hard ? t('autodjView.hard') : t('autodjView.soft')}` : undefined}>
              {block ? (
                <span className="flex items-center gap-1.5">
                  {block.locked && <Lock className="size-3.5 shrink-0 text-muted" />}
                  <span className="truncate">{block.items[0]?.label || t('autodjView.fixedItem')}</span>
                </span>
              ) : (
                <span className="text-muted">{t('autodjView.noFixed')}</span>
              )}
            </Fact>
            <Fact
              label={t('autodjView.nextShow')}
              sub={change ? `${time(change.at)} · ${change.show ? t(change.show.live ? 'autodjView.liveShow' : 'autodjView.block') : (change.clock?.name ?? t('autodjView.noClock'))}` : undefined}
            >
              {change ? (
                <span className="flex items-center gap-1.5">
                  {change.show?.live && <Mic className="size-3.5 shrink-0 text-onair" />}
                  <span className="truncate">{change.show?.name ?? t('autodjView.noBlockShort')}</span>
                </span>
              ) : (
                <span className="text-muted">{t('autodjView.noChange', { count: HOURS - 1 })}</span>
              )}
            </Fact>
          </div>

          <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
            <Card className="flex min-h-0 flex-col p-4">
              <div className="flex items-center justify-between gap-2">
                <Label>
                  {current
                    ? t('autodjView.thisHour', {
                        from: time(current.at),
                        to: time(current.at + 3_600_000),
                      })
                    : t('autodjView.thisHourEmpty')}
                </Label>
                <div className="flex items-center gap-2">
                  {live && (
                    <Badge tone="onair">
                      <Mic className="size-3" /> {t('autodjView.paused')}
                    </Badge>
                  )}
                  {canManage && clock && (
                    <Button size="sm" variant="ghost" onClick={() => openInManage({ section: 'clocks', clockId: clock.id })}>
                      <Pencil className="size-3.5" /> {t('autodjView.editClock')}
                    </Button>
                  )}
                </div>
              </div>
              {current && clock && segments.length ? (
                <div className="mt-3 flex min-h-0 flex-1 flex-wrap items-start gap-5">
                  <ClockDonut
                    segments={segments}
                    colorOf={(item) => info.color(item, clock.color)}
                    nameOf={(item) => item.label || info.playlist(item.playlistId)?.name || info.track(item.mediaId)?.title || t(`autodjView.kind.${item.kind}`)}
                    title={clock.name}
                    subtitle={minute != null ? `:${String(Math.floor(minute)).padStart(2, '0')}` : undefined}
                    highlight={step >= 0 ? step : null}
                    hand={minute}
                    size={300}
                  />
                  <ol className="min-w-[240px] flex-1 overflow-y-auto text-[13px]">
                    {current.rows.map((r, i) => (
                      <li
                        key={`${r.startsAt}-${i}`}
                        className={clsx(
                          'flex items-center gap-2.5 border-t border-line py-2 first:border-t-0',
                          r.past && 'text-muted opacity-60',
                          r.current && 'relative -mx-2 rounded-md border-transparent bg-koraal/10 px-2 font-semibold',
                        )}
                        aria-current={r.current ? 'step' : undefined}
                      >
                        <span className="w-11 shrink-0 font-mono text-[12px] tabular text-muted">{r.timed || i === 0 ? time(r.startsAt) : ''}</span>
                        <i
                          className="size-2 shrink-0 rounded-full"
                          style={{
                            background: segments[i] ? info.color(segments[i]!.item, clock.color) : 'var(--line)',
                          }}
                        />
                        <SourceIcon row={r} />
                        <span className="min-w-0 flex-1 truncate">{label(r)}</span>
                        {r.kind === 'music' && r.count > 0 && <span className="text-[11px] text-muted">{t('autodjView.tracks', { count: r.count })}</span>}
                        {r.locked && <Lock className="size-3.5 shrink-0 text-muted" aria-label={t('autodjView.locked')} />}
                        {r.hard && <span className="rounded bg-chip px-1.5 text-[10px] font-bold text-muted uppercase">{t('autodjView.hardShort')}</span>}
                        {r.current && <Badge tone="online">{t('autodjView.now')}</Badge>}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="mt-3 text-[13px] text-muted">{rundown.data.enabled ? t('autodjView.noClockText') : t('autodjView.schedulerOffText')}</p>
              )}
            </Card>

            <Card className="flex min-h-0 flex-col p-4">
              <Label>{t('autodjView.coming')}</Label>
              <ol className="mt-2 min-h-0 flex-1 overflow-y-auto">
                {hours.slice(1).map((h) => {
                  const c = h.clock ? clocks.get(h.clock.id) : undefined;
                  const fixed = h.rows.filter((r) => r.kind === 'item');
                  return (
                    <li key={h.at} className="flex gap-3 border-t border-line py-3 first:border-t-0">
                      {c ? (
                        <ClockDonut size={40} segments={clockLayout(c.items, info.seconds)} colorOf={(item) => info.color(item, c.color)} nameOf={() => ''} />
                      ) : (
                        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-chip">
                          <Music2 className="size-4 text-muted" />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-[13px]">
                          <span className="font-mono tabular text-muted">{time(h.at)}</span>
                          {canManage && h.clock ? (
                            <button
                              type="button"
                              onClick={() => openInManage({ section: 'clocks', clockId: h.clock!.id })}
                              className="truncate font-bold hover:text-accent-text hover:underline"
                              title={t('autodjView.editClock')}
                            >
                              {h.clock.name}
                            </button>
                          ) : (
                            <b className="truncate">{h.clock?.name ?? t('autodjView.noClock')}</b>
                          )}
                          {h.show && (
                            <Badge tone={h.show.live ? 'onair' : 'neutral'}>
                              {h.show.live && <Mic className="size-3" />} {h.show.name}
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 text-[12px] text-muted">
                          {fixed.length
                            ? fixed
                                .slice(0, 6)
                                .map((r) => `${r.timed ? `${time(r.startsAt)} ` : ''}${label(r)}`)
                                .join(' · ') + (fixed.length > 6 ? ' …' : '')
                            : t('autodjView.onlyMusic')}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <p className="mt-2 border-t border-line pt-2 text-[11px] text-muted">{canManage ? t('autodjView.readOnlyManager') : t('autodjView.readOnly')}</p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
