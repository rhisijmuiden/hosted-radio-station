import clsx from 'clsx';
import { ExternalLink } from 'lucide-react';
import { Artwork, Equalizer, HistoryList, LiveBadge, PlayButton, PoweredBy, RequestForm, transparent, VolumeControl } from './components';
import { params, useLivePlayer, useT, type NowPlaying } from './lib';

const shell = (extra?: string) => clsx('flex h-full min-h-0 flex-col', !transparent && 'bg-surface', extra);

function OpenPage({ np }: { np: NowPlaying }) {
  const t = useT();
  return (
    <a href={np.station.pageUrl} target="_blank" rel="noreferrer" className="rounded-full p-1.5 text-muted hover:bg-hover hover:text-ink" title={t('openPage')} aria-label={t('openPage')}>
      <ExternalLink className="size-4" />
    </a>
  );
}

/**
 * Player widget. layout=bar (default, about 88 px high, any width) or layout=card (square art, about 340 × 460).
 * Options: theme=light|dark, accent=ff6b57, lang=en|nl, transparent=1.
 */
export function PlayerEmbed({ np }: { np: NowPlaying }) {
  const t = useT();
  const player = useLivePlayer(np);
  const playing = player.state === 'playing';
  const layout = params.get('layout') === 'card' ? 'card' : 'bar';
  const title = np.song?.title ?? np.station.name;
  const sub = np.song?.artist ?? (np.onAir ? np.station.name : t('offAir'));

  if (layout === 'card') {
    return (
      <div className={shell('p-3')}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-raised">
          <div className="relative">
            <Artwork song={np.song} logo={np.station.logoUrl} className="aspect-square w-full" rounded="rounded-none" />
            <div className="absolute top-3 left-3">
              <LiveBadge np={np} />
            </div>
          </div>
          <div className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px] font-bold tracking-[0.1em] text-[var(--station)] uppercase">
                <Equalizer playing={playing} /> {np.station.name}
              </div>
              <div className="mt-1 truncate text-base font-bold">{title}</div>
              <div className="truncate text-[13px] text-muted">{sub}</div>
            </div>
            <PlayButton player={player} size="md" disabled={!np.onAir} />
          </div>
          <div className="mt-auto flex items-center justify-between border-t border-line px-3 py-2">
            <VolumeControl player={player} />
            <div className="flex items-center gap-1">
              <PoweredBy />
              <OpenPage np={np} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={shell('justify-center p-2')}>
      <div className="flex items-center gap-3 rounded-lg border border-line bg-raised p-2.5 pr-3">
        <PlayButton player={player} size="md" disabled={!np.onAir} />
        <Artwork song={np.song} logo={np.station.logoUrl} className="hidden size-12 min-[360px]:block" rounded="rounded-md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] font-bold tracking-[0.1em] text-[var(--station)] uppercase">
            <Equalizer playing={playing} className="h-2.5" />
            <span className="truncate">{np.live ? t('liveWith', { dj: np.live.dj }) : np.station.name}</span>
          </div>
          <div className="truncate text-sm font-bold">{title}</div>
          <div className="truncate text-xs text-muted">{sub}</div>
        </div>
        <div className="hidden items-center sm:flex">
          <VolumeControl player={player} />
        </div>
        <div className="hidden flex-col items-end gap-0.5 min-[480px]:flex">
          <OpenPage np={np} />
          <PoweredBy className="text-[10px]" />
        </div>
      </div>
    </div>
  );
}

/** Recently played. Option: limit=5 (1–10). */
export function HistoryEmbed({ np }: { np: NowPlaying }) {
  const t = useT();
  const limit = Math.min(10, Math.max(1, Number(params.get('limit')) || 5));
  return (
    <div className={shell('p-3')}>
      <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-raised">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm font-bold">{t('recentlyPlayed')}</div>
          <OpenPage np={np} />
        </div>
        {np.song && (
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <Artwork song={np.song} logo={np.station.logoUrl} className="size-12" rounded="rounded-md" />
            <div className="min-w-0">
              <div className="text-[10px] font-bold tracking-[0.1em] text-[var(--station)] uppercase">{t('nowPlaying')}</div>
              <div className="truncate text-sm font-bold">{np.song.title}</div>
              {np.song.artist && <div className="truncate text-xs text-muted">{np.song.artist}</div>}
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <HistoryList items={np.history} limit={limit} />
        </div>
        <div className="flex justify-end border-t border-line px-3 py-2">
          <PoweredBy />
        </div>
      </div>
    </div>
  );
}

/** Song request form. */
export function RequestsEmbed({ np }: { np: NowPlaying }) {
  const t = useT();
  return (
    <div className={shell('p-3')}>
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-raised p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold">{t('requestTitle')}</div>
            <div className="text-xs text-muted">{np.station.name}</div>
          </div>
          <LiveBadge np={np} />
        </div>
        {np.requests.enabled ? <RequestForm np={np} /> : <p className="text-[13px] text-muted">{t('requestsClosed')}</p>}
        <div className="flex justify-end">
          <PoweredBy />
        </div>
      </div>
    </div>
  );
}
