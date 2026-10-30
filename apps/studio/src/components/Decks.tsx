import clsx from 'clsx';
import { AudioWaveform, Lock, Play, SkipForward, Square } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CueEditor, useCanCue } from './CueEditor';
import { addLocalFile, DRAG_FILE, DRAG_MEDIA, useCanUpload } from './Library';
import { Badge, Button, Card } from './ui';
import type { AutoDj, QueueRow } from '../lib/api';
import { introLeft, trackLength } from '../lib/cues';
import { duration } from '../lib/format';
import { clock, DRAG, queueOf, useQueueActions } from '../lib/queue';
import { useSession } from '../lib/session';
import type { Line } from '../lib/timeline';

/** Auto: the player plays on from track to track. Manual: it stops after each track until Play. */
export function ModeSwitch({ data, stationId }: { data: AutoDj; stationId: string }) {
  const { t } = useTranslation();
  const { supports } = useSession();
  const a = useQueueActions(stationId);
  const manual = !!data.playout?.manual;
  const can = supports('playout');
  return (
    <div role="group" aria-label={t('playout.label')} title={can ? undefined : t('server.needsUpdate')} className="flex rounded-md border border-line bg-surface p-0.5">
      {([false, true] as const).map((m) => (
        <button
          key={String(m)}
          type="button"
          disabled={!can || a.mode.isPending}
          aria-pressed={manual === m}
          onClick={() => manual !== m && a.mode.mutate(m)}
          className={clsx(
            'h-8 rounded-[7px] px-3.5 text-[13px] font-bold transition-colors disabled:cursor-not-allowed',
            manual === m ? 'bg-koraal text-nacht' : 'text-muted hover:text-ink',
          )}
        >
          {m ? t('playout.manual') : t('playout.auto')}
        </button>
      ))}
    </div>
  );
}

type Track = QueueRow['media'];

/** Drops on a deck: on the one on air a track plays now, on the next one it goes to the top of the playlist. */
function useDeckDrop(stationId: string, role: 'air' | 'next', blocked: boolean) {
  const { t } = useTranslation();
  const { supports } = useSession();
  const a = useQueueActions(stationId);
  const canUpload = useCanUpload();
  const [over, setOver] = useState(false);
  const kinds = [DRAG, DRAG_MEDIA, ...(canUpload ? [DRAG_FILE] : [])];
  const accepts = (e: DragEvent) => !blocked && (role === 'next' || supports('play-now')) && kinds.some((k) => e.dataTransfer.types.includes(k));
  const queueTop = useRef<string | null>(null);
  const play = (v: { itemId: string } | { mediaId: string }) => {
    if (role === 'air') a.playNow.mutate(v);
    else if ('itemId' in v) a.move.mutate({ itemId: v.itemId, queue: 'q1', beforeId: queueTop.current });
    else a.add.mutate({ mediaId: v.mediaId, queue: 'q1', at: 'top' });
  };
  return {
    over,
    setTop: (id: string | null) => (queueTop.current = id),
    props: {
      onDragOver: (e: DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        const itemId = e.dataTransfer.getData(DRAG);
        const mediaId = e.dataTransfer.getData(DRAG_MEDIA);
        const file = e.dataTransfer.getData(DRAG_FILE);
        if (itemId) play({ itemId });
        else if (mediaId) play({ mediaId });
        else if (file && canUpload) void addLocalFile(stationId, file, 'q1', 'top', (v) => play({ mediaId: v.mediaId }), t);
      },
    },
  };
}

function DeckFrame({ letter, role, over, dropLabel, children, ...rest }: { letter: 'A' | 'B'; role: 'air' | 'next'; over: boolean; dropLabel: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={clsx(
        'relative flex min-w-0 flex-col gap-2 rounded-md border p-3',
        role === 'air' ? 'border-koraal/50 bg-koraal/[0.07]' : 'border-line bg-surface',
        over && 'ring-2 ring-koraal',
      )}
    >
      {over && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-md bg-koraal/15 text-center text-xs font-extrabold tracking-[0.08em] text-accent-text uppercase">{dropLabel}</div>}
      <span className={clsx('absolute top-3 right-3 grid size-6 place-items-center rounded-[5px] text-[13px] font-extrabold text-nacht', letter === 'A' ? 'bg-lucht' : 'bg-online/70')}>{letter}</span>
      {children}
    </div>
  );
}

function DeckTitle({ eyebrow, track, sub, locked }: { eyebrow: string; track: Track | null; sub: string; locked?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 pr-8">
      <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-[0.08em] text-muted uppercase">
        {eyebrow}
        {locked && (
          <span className="inline-flex items-center gap-1 rounded-full bg-koraal/15 px-1.5 py-px text-accent-text normal-case" title={t('assist.lockedHint')}>
            <Lock className="size-2.5" /> {t('assist.locked')}
          </span>
        )}
      </div>
      <div className="display truncate text-[16px] leading-tight">{track ? track.title || track.path : t('assist.nothing')}</div>
      <div className="truncate text-[12px] text-muted">{sub || ' '}</div>
    </div>
  );
}

function Counter({ label, value, warn, intro }: { label: string; value: string; warn?: boolean; intro?: boolean }) {
  return (
    <div className={clsx(intro && 'rounded-[5px] bg-lucht/25 px-2 py-0.5 text-right')}>
      <div className="text-[9px] font-bold tracking-[0.08em] text-muted uppercase">{label}</div>
      <div className={clsx('display leading-none tabular', intro ? 'text-[20px]' : 'text-[30px]', warn && 'text-accent-text')}>{value}</div>
    </div>
  );
}

function Progress({ pct, introPct }: { pct: number; introPct: number | null }) {
  return (
    <div className="relative h-1.5 overflow-hidden rounded-full bg-meter">
      {introPct != null && <div className="absolute inset-y-0 left-0 bg-lucht/50" style={{ width: `${introPct}%` }} />}
      <div className="relative h-full bg-koraal transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
    </div>
  );
}

const introShare = (m: Track, total: number | null) => (total && m.cueIntro != null ? Math.min(100, ((m.cueIntro - (m.cueIn ?? 0)) / total) * 100) : null);

/**
 * Players A and B of the OmniPlayer layout. They follow the playlist on the server: one deck has the track on air, the
 * other the cued track that goes on air next. At every new track the decks swap roles, like two players on a desk.
 * In Manual playout Play on the next deck starts it; in Auto it plays on by itself at the cue points.
 */
export function Decks({ data, stationId, lines, now }: { data: AutoDj; stationId: string; lines: Line[]; now: number }) {
  const { t } = useTranslation();
  const a = useQueueActions(stationId);
  const canUpload = useCanUpload();
  const canCue = useCanCue();
  const [cue, setCue] = useState<Track | null>(null);
  const manual = !!data.playout?.manual;
  const holding = manual && !!data.playout?.holding;
  const np = holding ? null : data.nowPlaying;
  const queue = queueOf(data);
  const nextRow = queue.find((r) => r.state === 'cued') ?? queue[0] ?? null;
  const nextLine = lines.find((l) => l.kind === 'track' && l.row.id === nextRow?.id);

  // The deck on air swaps at every new track.
  const [swapped, setSwapped] = useState(false);
  const last = useRef(data.nowPlaying?.id);
  useEffect(() => {
    const id = data.nowPlaying?.id;
    if (id && last.current && id !== last.current) setSwapped((s) => !s);
    if (id) last.current = id;
  }, [data.nowPlaying?.id]);

  const elapsed = np?.startedAt ? (now - new Date(np.startedAt).getTime()) / 1000 : 0;
  const total = np ? trackLength(np.media) : null;
  const remaining = total != null ? Math.max(0, total - elapsed) : null;
  const ends = np?.startedAt && total ? new Date(np.startedAt).getTime() + total * 1000 : null;
  const intro = np ? introLeft(np.media, elapsed) : null;
  const lockedOnAir = !!np?.locked;
  const blocked = lockedOnAir && !canUpload;

  const air = useDeckDrop(stationId, 'air', blocked);
  const next = useDeckDrop(stationId, 'next', false);
  next.setTop(queue[0]?.id ?? null);

  const nextLength = nextRow ? trackLength(nextRow.media) : null;
  const nextIntro = nextRow && nextRow.media.cueIntro != null ? nextRow.media.cueIntro - (nextRow.media.cueIn ?? 0) : null;
  // Play on the next deck: in Manual while the player waits, Play; otherwise it starts now, like Next.
  const startNext = () => (holding ? a.player.mutate('play') : a.skip.mutate());

  const airDeck = (letter: 'A' | 'B') => (
    <DeckFrame key="air" letter={letter} role="air" over={air.over} dropLabel={t('assist.dropToPlay')} {...air.props}>
      <DeckTitle
        eyebrow={holding ? t('playout.waiting') : t('decks.onAir')}
        track={np?.media ?? null}
        sub={np ? [np.media.artist, ends ? t('assist.endsAt', { time: clock(ends) }) : null].filter(Boolean).join(' · ') : !data.player.connected && data.player.expected ? t('assist.playerOffline') : ''}
        locked={lockedOnAir}
      />
      <div className="flex items-end justify-between gap-2">
        <Counter label={t('assist.remainingLabel')} value={remaining != null ? `-${duration(remaining)}` : '–:––'} warn={remaining != null && remaining < 15} />
        {intro != null && <Counter label={t('assist.intro')} value={String(Math.ceil(intro))} warn={intro < 5} intro />}
      </div>
      <Progress pct={total && np ? Math.min(100, (elapsed / total) * 100) : 0} introPct={np ? introShare(np.media, total) : null} />
      <div className="flex gap-1.5">
        {manual && (
          <Button variant="secondary" onClick={() => a.player.mutate('stop')} disabled={a.player.isPending || !np} title={t('playout.stop')} aria-label={t('playout.stop')} className="h-9 flex-1 px-0">
            <Square className="size-3.5 fill-current" />
          </Button>
        )}
        <Button
          variant="primary"
          onClick={() => a.skip.mutate()}
          loading={a.skip.isPending}
          disabled={!np || blocked}
          title={blocked ? t('assist.lockedHint') : t('assist.nextHint')}
          className="h-9 flex-[2] px-2"
        >
          <SkipForward className="size-4" /> {t('playout.next')}
        </Button>
      </div>
    </DeckFrame>
  );
  const nextDeck = (letter: 'A' | 'B') => (
    <DeckFrame key="next" letter={letter} role="next" over={next.over} dropLabel={t('decks.dropNext')} {...next.props}>
      <DeckTitle
        eyebrow={t('assist.cued')}
        track={nextRow?.media ?? null}
        sub={nextRow ? [nextRow.media.artist, nextLine && !holding ? t('decks.startsAt', { time: clock(nextLine.start) }) : holding ? t('playout.pressPlay') : null].filter(Boolean).join(' · ') : ''}
        locked={!!nextRow?.locked}
      />
      <div className="flex items-end justify-between gap-2">
        <Counter label={t('playout.length')} value={duration(nextLength)} />
        {nextIntro != null && nextIntro > 0 && <Counter label={t('assist.intro')} value={String(Math.round(nextIntro))} intro />}
      </div>
      <Progress pct={0} introPct={nextRow ? introShare(nextRow.media, nextLength) : null} />
      <div className="flex gap-1.5">
        {canCue && nextRow && (
          <Button variant="secondary" onClick={() => setCue(nextRow.media)} title={t('cue.open')} aria-label={t('cue.open')} className="h-9 flex-1 px-0">
            <AudioWaveform className="size-4" />
          </Button>
        )}
        <Button
          variant={holding ? 'dark' : 'secondary'}
          onClick={startNext}
          disabled={!nextRow || a.player.isPending || a.skip.isPending || (!holding && blocked)}
          title={holding ? t('playout.play') : t('decks.startNow')}
          aria-label={holding ? t('playout.play') : t('decks.startNow')}
          className={clsx('h-9 flex-[2] px-2', holding && 'onair-pulse')}
        >
          <Play className="size-4 fill-current" /> {holding ? t('playout.play') : t('decks.startNow')}
        </Button>
      </div>
    </DeckFrame>
  );

  return (
    <Card className="shrink-0 p-3">
      <div className="grid grid-cols-2 gap-2.5">{swapped ? [nextDeck('A'), airDeck('B')] : [airDeck('A'), nextDeck('B')]}</div>
      <div className="mt-2.5 flex items-center gap-3">
        <ModeSwitch data={data} stationId={stationId} />
        {data.player.paused && <Badge tone="warning">{t('assist.paused')}</Badge>}
        {data.player.stuckSince && !data.player.paused && <Badge tone="warning">{t('assist.stuck')}</Badge>}
        <span className="min-w-0 flex-1 truncate text-right text-[12px] text-muted">{manual ? (holding ? t('playout.holdingText') : t('playout.manualText')) : t('playout.autoText')}</span>
      </div>
      {cue && <CueEditor stationId={stationId} track={cue} onClose={() => setCue(null)} />}
    </Card>
  );
}
