import clsx from 'clsx';
import { ListMusic, Lock, Music2, Play, SkipForward, Square } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { addLocalFile, DRAG_FILE, DRAG_MEDIA, LibraryPanel, useCanUpload } from '../components/Library';
import { JingleBar } from '../components/Jingles';
import { Dashboard } from '../components/Dashboard';
import { JingleGrid, StationCartGrid } from '../components/Grids';
import { NewsPlayer } from '../components/NewsPlayer';
import { SinglePlayer } from '../components/SinglePlayer';
import { Decks, ModeSwitch } from '../components/Decks';
import { PlaylistCard, type LogView } from '../components/Playlist';
import { Badge, Button, Card, EmptyState, Spinner } from '../components/ui';
import type { AutoDj } from '../lib/api';
import { introLeft, playLength, trackLength } from '../lib/cues';
import { duration } from '../lib/format';
import { useNow } from '../lib/now';
import { DECK_WIDTH, useLayout } from '../lib/layout';
import { useAutoDj, useHistory, useRundown } from '../lib/queries';
import { clock, DRAG, queueOf, useLineText, useQueueActions } from '../lib/queue';
import { useSession } from '../lib/session';
import { backtime, blocksOf, timeline, type Line } from '../lib/timeline';

function NowPlaying({ data, stationId, lines, now }: { data: AutoDj; stationId: string; lines: Line[]; now: number }) {
  const { t } = useTranslation();
  const a = useQueueActions(stationId);
  const text = useLineText();
  const manual = !!data.playout?.manual;
  const holding = manual && !!data.playout?.holding;
  const np = data.nowPlaying;
  const elapsed = np?.startedAt ? (now - new Date(np.startedAt).getTime()) / 1000 : 0;
  // From cue in to cue out: the player starts the track at its cue in.
  const total = np ? trackLength(np.media) : null;
  const pct = total && !holding ? Math.min(100, (elapsed / total) * 100) : 0;
  const remaining = total && !holding ? Math.max(0, total - elapsed) : null;
  const ends = np?.startedAt && total ? new Date(np.startedAt).getTime() + total * 1000 : null;
  const intro = np && !holding ? introLeft(np.media, elapsed) : null;
  const introPct = np && total && np.media.cueIntro != null ? Math.min(100, ((np.media.cueIntro - (np.media.cueIn ?? 0)) / total) * 100) : null;
  const next = queueOf(data).find((r) => r.state === 'cued') ?? queueOf(data)[0];
  // While holding, the first line is the waiting track itself.
  const after = holding ? lines.slice(1, 3) : lines.slice(0, 2);
  // A track dropped on the player plays now: from the playlist, the library, or this PC (uploaded first).
  const { supports } = useSession();
  const canUpload = useCanUpload();
  const [over, setOver] = useState(false);
  // A locked item of the format on air: DJs cannot skip it or play something over it; managers are asked first.
  const lockedOnAir = !!np?.locked && !holding;
  const blocked = lockedOnAir && !canUpload;
  const accepts = (e: DragEvent) => !blocked && supports('play-now') && [DRAG, DRAG_MEDIA, ...(canUpload ? [DRAG_FILE] : [])].some((k) => e.dataTransfer.types.includes(k));
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const itemId = e.dataTransfer.getData(DRAG);
    const mediaId = e.dataTransfer.getData(DRAG_MEDIA);
    const file = e.dataTransfer.getData(DRAG_FILE);
    if (itemId) a.playNow.mutate({ itemId });
    else if (mediaId) a.playNow.mutate({ mediaId });
    else if (file && canUpload) void addLocalFile(stationId, file, 'q1', 'top', (v) => a.playNow.mutate({ mediaId: v.mediaId }), t);
  };
  return (
    <Card
      className={clsx('relative shrink-0 overflow-hidden', over && 'ring-2 ring-koraal')}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      {over && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-koraal/15 text-sm font-extrabold tracking-[0.08em] text-accent-text uppercase">
          {t('assist.dropToPlay')}
        </div>
      )}
      <div className="flex items-center gap-5 px-5 pt-5 pb-4">
        <div className="grid size-16 shrink-0 place-items-center rounded-md bg-nacht text-koraal">
          <Music2 className="size-7" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            {holding ? t('playout.waiting') : t('assist.nowPlaying')}
            {lockedOnAir && (
              <span className="inline-flex items-center gap-1 rounded-full bg-koraal/15 px-2 py-0.5 text-accent-text" title={t('assist.lockedHint')}>
                <Lock className="size-3" /> {t('assist.locked')}
              </span>
            )}
          </div>
          <div className="display truncate text-[22px]">{holding ? (next ? next.media.title || next.media.path : t('assist.nothing')) : np ? np.media.title || np.media.path : t('assist.nothing')}</div>
          <div className="truncate text-[13px] text-muted">
            {holding
              ? next
                ? [next.media.artist, t('playout.pressPlay')].filter(Boolean).join(' · ')
                : ''
              : np
                ? [np.media.artist, ends ? t('assist.endsAt', { time: clock(ends) }) : null].filter(Boolean).join(' · ')
                : !data.player.connected && data.player.expected
                  ? t('assist.playerOffline')
                  : ''}
          </div>
        </div>
        {intro != null && (
          <div className="rounded-md bg-lucht/20 px-3 py-1.5 text-right" title={t('assist.introHint')}>
            <div className={clsx('display text-[32px] leading-none tabular', intro < 5 && 'text-accent-text')}>{Math.ceil(intro)}</div>
            <div className="mt-1 text-[10px] font-bold tracking-[0.08em] text-muted uppercase">{t('assist.intro')}</div>
          </div>
        )}
        <div className="text-right">
          {holding ? (
            <>
              <div className="display text-[44px] leading-none tabular">{next ? duration(trackLength(next.media)) : '–:––'}</div>
              <div className="mt-1 text-[11px] text-muted">{t('playout.length')}</div>
            </>
          ) : (
            <>
              <div className={clsx('display text-[44px] leading-none tabular', remaining != null && remaining < 15 && 'text-accent-text')}>{remaining != null ? `-${duration(remaining)}` : '–:––'}</div>
              <div className="mt-1 text-[11px] text-muted">{t('assist.remainingLabel')}</div>
            </>
          )}
        </div>
      </div>
      <div className="relative h-1.5 bg-meter">
        {introPct != null && <div className="absolute inset-y-0 left-0 bg-lucht/40" style={{ width: `${introPct}%` }} />}
        <div className="relative h-full bg-koraal transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center gap-4 px-5 py-3">
        <ModeSwitch data={data} stationId={stationId} />
        <div className="min-w-0 flex-1 truncate text-[13px] text-muted" title={manual ? (holding ? t('playout.holdingText') : t('playout.manualText')) : t('playout.autoText')}>
          {after[0] ? (
            <>
              {t('assist.after')}: <b className="text-ink">{text(after[0])}</b>
              {after[1] && <>, {t('assist.then')} {text(after[1])}</>}
            </>
          ) : manual ? (
            holding ? t('playout.holdingText') : t('playout.manualText')
          ) : (
            t('playout.autoText')
          )}
        </div>
        {data.player.paused && <Badge tone="warning">{t('assist.paused')}</Badge>}
        {manual && (
          <>
            <Button
              variant="dark"
              onClick={() => a.player.mutate('play')}
              disabled={a.player.isPending}
              title={holding ? t('playout.play') : t('playout.playAfter')}
              aria-label={t('playout.play')}
              className={clsx('size-12 px-0', holding && 'onair-pulse')}
            >
              <Play className="size-5 fill-current" />
            </Button>
            <Button variant="secondary" onClick={() => a.player.mutate('stop')} disabled={a.player.isPending || holding || !np} title={t('playout.stop')} aria-label={t('playout.stop')} className="size-12 px-0">
              <Square className="size-4 fill-current" />
            </Button>
          </>
        )}
        <Button
          variant="primary"
          onClick={() => a.skip.mutate()}
          loading={a.skip.isPending}
          disabled={(!np && !holding) || data.edition !== 'station' || blocked}
          title={blocked ? t('assist.lockedHint') : t('assist.nextHint')}
          className="h-12 min-w-40 px-6 text-[15px]"
        >
          <SkipForward className="size-5" /> {t('playout.next')}
        </Button>
      </div>
    </Card>
  );
}

/** The handle between the log column and the panels: drag to change the width, kept in the DJ profile. */
function Splitter() {
  const { t } = useTranslation();
  const [layout, setLayout] = useLayout();
  const [drag, setDrag] = useState<{ x: number; width: number } | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const clamp = (w: number) => Math.min(DECK_WIDTH.max, Math.max(DECK_WIDTH.min, Math.round(w)));
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('layout.resize')}
      aria-valuenow={width ?? layout.deckWidth}
      aria-valuemin={DECK_WIDTH.min}
      aria-valuemax={DECK_WIDTH.max}
      tabIndex={0}
      title={t('layout.resize')}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') setLayout({ deckWidth: clamp(layout.deckWidth + (e.key === 'ArrowLeft' ? -20 : 20)) });
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ x: e.clientX, width: layout.deckWidth });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const w = clamp(drag.width + e.clientX - drag.x);
        setWidth(w);
        // Live while dragging: on this PC only; the profile is saved once, when let go.
        const col = e.currentTarget.previousElementSibling as HTMLElement | null;
        if (col) col.style.width = `${w}px`;
      }}
      onPointerUp={() => {
        if (drag && width != null) setLayout({ deckWidth: width });
        setDrag(null);
        setWidth(null);
      }}
      onDoubleClick={() => setLayout({ deckWidth: DECK_WIDTH.default })}
      className="group flex w-3 shrink-0 cursor-col-resize items-center justify-center outline-none"
    >
      <span className={clsx('h-12 w-1 rounded-full transition-colors', drag ? 'bg-koraal' : 'bg-line group-hover:bg-muted group-focus-visible:bg-koraal')} />
    </div>
  );
}

export function AssistPage() {
  const { t } = useTranslation();
  const { station, supports } = useSession();
  const autodj = useAutoDj(station?.id);
  const rundown = useRundown(station?.id, !!station && station.edition === 'station' && supports('rundown'));
  const queueActions = useQueueActions(station?.id ?? '');
  const now = useNow();
  const [layout] = useLayout();
  const omni = layout.assist === 'omni';
  const history = useHistory(station?.id, autodj.data?.nowPlaying?.id, omni && layout.panels.history && station?.edition === 'station' && supports('history'));
  if (!station) return <EmptyState icon={<ListMusic className="size-6" />} title={t('station.none')} description={t('station.noneText')} />;
  if (autodj.isPending) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  const data = autodj.data;
  if (!data) return <EmptyState icon={<ListMusic className="size-6" />} title={t('assist.loadFailed')} description={(autodj.error as Error)?.message} />;
  if (data.edition !== 'station') {
    return (
      <Card>
        <EmptyState icon={<ListMusic className="size-6" />} title={t('assist.distributionTitle')} description={t('assist.distributionText')} />
      </Card>
    );
  }
  // The playlist starts where the track on air ends, overlapping by the crossfade; while holding, now.
  const np = data.nowPlaying;
  const fade = data.settings.crossfadeSeconds ?? 0;
  const holding = !!data.playout?.manual && !!data.playout?.holding;
  const npLength = np ? playLength(np.media, fade) : null;
  const from = np?.startedAt && npLength != null && !holding ? Math.max(now, new Date(np.startedAt).getTime() + npLength * 1000) : now;
  const queue = queueOf(data);
  const blocks = rundown.data?.enabled ? blocksOf(rundown.data.rows, now) : [];
  const lines = timeline(queue, blocks, from, fade);
  const until = backtime(queue, blocks[0], from, fade);
  if (omni) {
    const p = layout.panels;
    const jingles = p.jingles && supports('jingles');
    const carts = p.stationCarts && supports('station-carts');
    const news = p.news && supports('news');
    const top = p.single || news || jingles || carts || p.dashboard;
    const right = top || p.library;
    const log: LogView = { history: history.data?.items ?? [], showHistory: p.history, hours: rundown.data?.enabled ? rundown.data.rows : [], onAir: holding ? null : np, now };
    return (
      <div className="flex h-full min-h-[600px] gap-0">
        <div className="flex min-h-0 shrink-0 flex-col gap-3" style={right ? { width: layout.deckWidth } : { flex: 1 }}>
          <Decks data={data} stationId={station.id} lines={lines} now={now} />
          <PlaylistCard data={data} stationId={station.id} lines={lines} until={until} log={log} />
        </div>
        {right && (
          <>
            <Splitter />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              {top && (
                <div className="flex shrink-0 flex-wrap items-stretch gap-3">
                  {p.single && <SinglePlayer stationId={station.id} />}
                  {news && <NewsPlayer stationId={station.id} />}
                  {jingles && <JingleGrid stationId={station.id} />}
                  {carts && <StationCartGrid stationId={station.id} />}
                  {p.dashboard && <Dashboard data={data} stationId={station.id} blocks={blocks} />}
                </div>
              )}
              {p.library && (
                <div className="flex min-h-0 flex-1 flex-col">
                  <LibraryPanel stationId={station.id} add={(v) => queueActions.add.mutate(v)} wide />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="grid h-full min-h-[600px] grid-cols-[minmax(0,1fr)_minmax(300px,360px)] gap-4">
      <div className="flex min-h-0 flex-col gap-4">
        <NowPlaying data={data} stationId={station.id} lines={lines} now={now} />
        {supports('jingles') && <JingleBar stationId={station.id} />}
        <PlaylistCard data={data} stationId={station.id} lines={lines} until={until} />
      </div>
      <LibraryPanel stationId={station.id} add={(v) => queueActions.add.mutate(v)} />
    </div>
  );
}
