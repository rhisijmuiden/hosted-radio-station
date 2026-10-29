import clsx from 'clsx';
import { ArrowUpToLine, ChevronRight, Clock3, Eraser, GripVertical, History as History2, Lock, Music2, Trash2 } from 'lucide-react';
import { Fragment, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { addLocalFile, DRAG_FILE, DRAG_MEDIA, useCanUpload } from './Library';
import { Badge, Button, Card } from './ui';
import { CueButton, CueEditor, hasCues, useCanCue } from './CueEditor';
import type { AutoDj, Played, QueueRow, RundownRow } from '../lib/api';
import { trackLength } from '../lib/cues';
import { duration } from '../lib/format';
import { clock, DRAG, queueOf, useQueueActions } from '../lib/queue';
import type { Block, Line } from '../lib/timeline';

/** What the playlist shows more in the OmniPlayer layout, where it is the log under players A/B. */
export interface LogView {
  history: Played[];
  showHistory: boolean;
  /** The rundown of the coming hours: the show or clock per hour. */
  hours: RundownRow[];
  /** The track on air, as the highlighted line between last played and the playlist. */
  onAir: QueueRow | null;
  now: number;
}

/** The hour a moment falls in, with the show (or else the hour clock) planned for it. */
function useHourOf(rows: RundownRow[] | undefined) {
  const hours = new Map<number, string>();
  for (const r of rows ?? []) {
    const at = new Date(r.hour).getTime();
    if (!hours.has(at)) hours.set(at, r.show?.name ?? r.clock?.name ?? '');
  }
  const known = [...hours.keys()].sort((x, y) => x - y);
  return (at: number) => {
    const from = known.findLast((h) => h <= at && at < h + 3_600_000);
    if (from != null) return { at: from, label: hours.get(from) ?? '' };
    // Without a rundown: the hour of this PC's clock.
    const d = new Date(at);
    d.setMinutes(0, 0, 0);
    return { at: d.getTime(), label: '' };
  };
}

/** The tracks that played last, folded in at the top of the log. */
function History({ items, show, onAir, grid }: { items: Played[]; show: boolean; onAir: string | null; grid: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  // The newest one is the track on air: it has its own line.
  const list = (items[0]?.mediaId === onAir ? items.slice(1) : items).slice(0, 5).reverse();
  if (!show || !list.length) return null;
  return (
    <div className="border-b border-line">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-1.5 bg-surface px-3 py-1.5 text-left text-[10px] font-bold tracking-[0.06em] text-muted uppercase hover:text-ink">
        <ChevronRight className={clsx('size-3.5 transition-transform', open && 'rotate-90')} />
        {t('decks.lastPlayed')}
        <span className="font-semibold normal-case">({list.length})</span>
      </button>
      {open &&
        list.map((p) => (
          <div key={`${p.mediaId}-${p.playedAt}`} className={clsx(grid, 'border-t border-line/60 px-2 py-1.5 opacity-60')}>
            <History2 className="size-3.5 text-muted" aria-hidden />
            <span className="text-[12px] text-muted tabular">{clock(new Date(p.playedAt).getTime())}</span>
            <div className="min-w-0 truncate text-[12px]">
              <span className="font-semibold">{p.title || p.path}</span>
              {p.artist && <span className="text-muted"> · {p.artist}</span>}
            </div>
            <span className="text-right text-xs text-muted tabular">{duration(p.durationSeconds)}</span>
            <span />
          </div>
        ))}
    </div>
  );
}

/** The kind of a fixed item, in words. */
function useItemKind() {
  const { t } = useTranslation();
  return (source: Block['items'][number]['source']) => (source === 'news' ? t('rundown.news') : source === 'track' ? t('rundown.track') : t('rundown.playlist'));
}

/**
 * The playlist: what plays after the current track, with the time each line starts. The fixed blocks of the format
 * (news, commercials) sit inline at their minute with a lock; the header backtimes to the next one.
 */
export function PlaylistCard({ data, stationId, lines, until, log }: { data: AutoDj; stationId: string; lines: Line[]; until: number | null; log?: LogView }) {
  const { t } = useTranslation();
  const a = useQueueActions(stationId);
  const canUpload = useCanUpload();
  const kind = useItemKind();
  const canCue = useCanCue();
  const [cue, setCue] = useState<QueueRow['media'] | null>(null);
  const [over, setOver] = useState<string | 'end' | null>(null);
  const rows = queueOf(data);
  const total = rows.reduce((n, r) => n + (trackLength(r.media) ?? 0), 0);
  const nextBlock = lines.find((l): l is Extract<Line, { kind: 'block' }> => l.kind === 'block')?.block;

  const drop = (e: DragEvent, beforeId: string | null) => {
    e.preventDefault();
    setOver(null);
    const itemId = e.dataTransfer.getData(DRAG);
    const mediaId = e.dataTransfer.getData(DRAG_MEDIA);
    const file = e.dataTransfer.getData(DRAG_FILE);
    const at = beforeId && beforeId === rows[0]?.id ? 'top' : 'bottom';
    if (itemId) a.move.mutate({ itemId, queue: 'q1', beforeId });
    else if (mediaId) a.add.mutate({ mediaId, queue: 'q1', at });
    else if (file && canUpload) void addLocalFile(stationId, file, 'q1', at, (v) => a.add.mutate(v), t);
  };
  const allow = (e: DragEvent, id: string | 'end') => {
    if ([DRAG, DRAG_MEDIA, DRAG_FILE].some((k) => e.dataTransfer.types.includes(k))) {
      e.preventDefault();
      setOver(id);
    }
  };
  const GRID = 'grid grid-cols-[20px_64px_minmax(0,1fr)_52px_80px] items-center gap-2';
  // The log of the OmniPlayer layout: a header at every new hour, with the show or clock of that hour.
  const hourOf = useHourOf(log?.hours);
  let hour: number | null = null;
  const header = (start: number) => {
    if (!log) return null;
    const h = hourOf(start);
    if (h.at === hour) return null;
    hour = h.at;
    return (
      <div key={`hour-${h.at}`} className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-[11px] font-extrabold">
        <span className="tabular">{clock(h.at).slice(0, 5)}</span>
        {h.label && <span className="truncate font-semibold text-muted">{h.label}</span>}
      </div>
    );
  };
  const onAir = log?.onAir ?? null;

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="display text-[17px]">{log ? t('decks.log') : t('assist.playlist')}</h2>
          <span className="text-xs whitespace-nowrap text-muted tabular">
            {t('assist.tracks', { count: rows.length })} · {duration(total)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {nextBlock && until != null && (
            <span
              className={clsx(
                'rounded-full px-2.5 py-1 text-xs font-bold whitespace-nowrap tabular',
                Math.abs(until) < 5 ? 'bg-online/15 text-online' : until > 0 ? 'bg-koraal/15 text-accent-text' : 'bg-chip text-muted',
              )}
              title={nextBlock.hard ? t('assist.backtimeHard') : t('assist.backtimeSoft')}
            >
              {t('assist.until', { label: nextBlock.items[0]?.label || t('rundown.fixed') })}:{' '}
              {Math.abs(until) < 5 ? t('assist.onTime') : until > 0 ? t('assist.tooLong', { time: duration(until) }) : t('assist.tooShort', { time: duration(-until) })}
            </span>
          )}
          <Button size="sm" variant="ghost" title={t('assist.clear')} onClick={() => confirm(t('assist.clearConfirm')) && a.clear.mutate('q1')}>
            <Eraser className="size-4" />
          </Button>
        </div>
      </div>
      <div className={clsx(GRID, 'bg-surface px-2 py-1.5 text-[10px] font-bold tracking-[0.06em] text-muted uppercase')}>
        <span />
        <span>{t('assist.start')}</span>
        <span>{t('assist.title')}</span>
        <span className="text-right">{t('assist.length')}</span>
        <span />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" onDragOver={(e) => allow(e, 'end')} onDragLeave={() => setOver(null)} onDrop={(e) => drop(e, null)}>
        {log && <History items={log.history} show={log.showHistory} onAir={onAir?.media.id ?? null} grid={GRID} />}
        {onAir && (
          <Fragment>
            {header(onAir.startedAt ? new Date(onAir.startedAt).getTime() : log!.now)}
            <div className={clsx(GRID, 'border-b border-line bg-koraal/15 py-2 pr-2 pl-[5px] shadow-[inset_3px_0_0_var(--color-koraal)]')}>
              <Music2 className="size-3.5 text-accent-text" aria-label={t('decks.onAir')} />
              <span className="text-[13px] font-bold tabular">{onAir.startedAt ? clock(new Date(onAir.startedAt).getTime()) : ''}</span>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-bold">
                  {onAir.label ? `${onAir.label}: ` : ''}
                  {onAir.media.title || onAir.media.path}
                </div>
                <div className="truncate text-[11px] text-muted">{[onAir.media.artist, t('decks.onAir')].filter(Boolean).join(' · ')}</div>
              </div>
              <span className="text-right text-xs text-muted tabular">{duration(trackLength(onAir.media))}</span>
              <span />
            </div>
          </Fragment>
        )}
        {rows.length === 0 && <p className="px-4 py-10 text-center text-[13px] text-muted">{t('assist.emptyQueue')}</p>}
        {lines.map((l) => {
          const head = header(l.start);
          if (l.kind === 'block') {
            let at = l.start;
            return (
              <Fragment key={`block-${l.block.at}`}>
                {head}
                <div className="flex items-center gap-2 border-b border-koraal/30 bg-koraal/10 px-3 py-1.5 text-[11px] font-bold text-accent-text">
                  {l.block.locked ? <Lock className="size-3.5" /> : <Clock3 className="size-3.5" />}
                  <span className="tabular">{clock(l.block.at).slice(0, 5)}</span>
                  <span className="font-semibold">{l.block.locked ? t('assist.lockedBlock') : t('assist.fixedBlock')}</span>
                  {l.block.hard && <span className="font-semibold text-muted">· {t('rundown.onTheMinute')}</span>}
                </div>
                {l.block.items.map((i, n) => {
                  const start = at;
                  at += (i.seconds ?? 0) * 1000;
                  return (
                    <div key={n} className={clsx(GRID, 'border-b border-line border-l-[3px] border-l-koraal bg-koraal/5 py-2 pr-2 pl-[5px]')}>
                      {i.locked ? <Lock className="size-3.5 text-accent-text" aria-label={t('assist.locked')} /> : <Clock3 className="size-3.5 text-accent-text" aria-label={t('assist.fixed')} />}
                      <span className="text-[13px] font-semibold text-muted tabular">{clock(start)}</span>
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold">{i.label || t('rundown.fixed')}</div>
                        <div className="truncate text-[11px] text-muted">
                          {kind(i.source)} · {i.locked ? t('assist.locked') : t('assist.fixed')}
                        </div>
                      </div>
                      <span className="text-right text-xs text-muted tabular">{i.seconds != null ? `±${duration(i.seconds)}` : '–'}</span>
                      <span />
                    </div>
                  );
                })}
              </Fragment>
            );
          }
          const r = l.row;
          return (
            <Fragment key={r.id}>
            {head}
            <div
              draggable={r.state === 'queued'}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG, r.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.stopPropagation();
                allow(e, r.id);
              }}
              onDrop={(e) => {
                e.stopPropagation();
                drop(e, r.id);
              }}
              className={clsx(
                'group border-b border-line px-2 py-2',
                GRID,
                over === r.id && 'border-t-2 border-t-koraal',
                r.state !== 'queued' && 'bg-chip/50',
                log && r.state === 'cued' && 'shadow-[inset_3px_0_0_var(--color-online)]',
              )}
            >
              <GripVertical className={clsx('size-4', r.state === 'queued' ? 'cursor-grab text-muted' : 'text-transparent')} />
              <span className="text-[13px] font-semibold tabular">{clock(l.start)}</span>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">
                  {r.label ? `${r.label}: ` : ''}
                  {r.media.title || r.media.path}
                </div>
                <div className="flex items-center gap-1.5 truncate text-[11px] text-muted">
                  {r.media.artist}
                  {r.requestId && <Badge tone="accent">{t('assist.request')}</Badge>}
                  {r.origin === 'manual' && r.addedBy && <span>· {r.addedBy}</span>}
                  {r.origin !== 'manual' && r.playlistName && <span>· {r.playlistName}</span>}
                  {r.state === 'cued' && <Badge tone="online">{t('assist.cued')}</Badge>}
                </div>
              </div>
              <span className="text-right text-xs text-muted tabular">{duration(trackLength(r.media))}</span>
              {r.state === 'queued' ? (
                <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
                  {canCue && <CueButton onClick={() => setCue(r.media)} set={hasCues(r.media)} />}
                  <button className="rounded p-1 text-muted hover:bg-hover hover:text-ink" title={t('assist.toTop')} onClick={() => rows[0]!.id !== r.id && a.move.mutate({ itemId: r.id, queue: 'q1', beforeId: rows[0]!.id })}>
                    <ArrowUpToLine className="size-3.5" />
                  </button>
                  <button className="rounded p-1 text-muted hover:bg-hover hover:text-offline" title={t('assist.remove')} onClick={() => a.remove.mutate(r.id)}>
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ) : canCue ? (
                <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
                  <CueButton onClick={() => setCue(r.media)} set={hasCues(r.media)} />
                </div>
              ) : (
                <span />
              )}
            </div>
            </Fragment>
          );
        })}
        <div className={clsx('h-8', over === 'end' && 'border-t-2 border-koraal')} />
      </div>
      {cue && <CueEditor stationId={stationId} track={cue} onClose={() => setCue(null)} />}
    </Card>
  );
}
