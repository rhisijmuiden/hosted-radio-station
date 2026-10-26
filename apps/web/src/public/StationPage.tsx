import clsx from 'clsx';
import { CalendarDays, Headphones, History, Inbox, ListMusic, Mic, Share2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Artwork, Equalizer, HistoryList, LiveBadge, Links, OnDemandList, PlayButton, PoweredBy, QualitySelect, RequestForm, SongLine, Toggles, VolumeControl } from './components';
import { getJson, seconds, timeAgo, useElapsed, useLang, useLivePlayer, useT, type NowPlaying, type OnDemandItem, type Show } from './lib';

function Section({ icon, title, subtitle, children, className }: { icon: ReactNode; title: string; subtitle?: string; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('rounded-lg border border-line bg-raised p-5', className)}>
      <div className="mb-4 flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-full bg-[color-mix(in_srgb,var(--station)_14%,transparent)] text-[var(--station)]">{icon}</span>
        <div>
          <h2 className="display text-base">{title}</h2>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function ShareButton({ np }: { np: NowPlaying }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = np.station.pageUrl;
    if (navigator.share) {
      await navigator.share({ title: np.station.name, text: np.song?.text, url }).catch(() => undefined);
      return;
    }
    await navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button type="button" onClick={() => void share()} className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold text-muted hover:bg-hover hover:text-ink">
      <Share2 className="size-4" /> {copied ? t('copied') : t('share')}
    </button>
  );
}

function useOnDemand(np: NowPlaying | null) {
  const [items, setItems] = useState<OnDemandItem[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(6);
  const slug = np?.station.slug;
  const enabled = !!np?.onDemand.enabled;
  useEffect(() => {
    if (!slug || !enabled) return;
    void getJson<{ items: OnDemandItem[]; total: number }>(`/api/public/stations/${slug}/ondemand?limit=${limit}`)
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
      })
      .catch(() => undefined);
  }, [slug, enabled, limit]);
  return { items, total, more: () => setLimit((l) => l + 12) };
}

function useSchedule(np: NowPlaying | null) {
  const [data, setData] = useState<{ timezone: string; onAir: Show | null; upcoming: Show[] } | null>(null);
  const slug = np?.station.slug;
  const enabled = !!np?.schedule.enabled;
  // Refresh when the show on air changes.
  const current = np?.schedule.show?.start;
  useEffect(() => {
    if (!slug || !enabled) return;
    void getJson<{ timezone: string; onAir: Show | null; upcoming: Show[] }>(`/api/public/stations/${slug}/schedule`)
      .then(setData)
      .catch(() => undefined);
  }, [slug, enabled, current]);
  return data;
}

function ScheduleList({ data }: { data: { timezone: string; onAir: Show | null; upcoming: Show[] } }) {
  const t = useT();
  const { lang } = useLang();
  const [limit, setLimit] = useState(8);
  const tz = data.timezone;
  const time = (iso: string) => new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(iso));
  const day = (iso: string) => new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(new Date(iso));
  const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shown = data.upcoming.slice(0, limit);
  let lastDay = '';
  return (
    <div className="flex flex-col gap-3">
      {data.onAir && (
        <div className="rounded-md bg-[color-mix(in_srgb,var(--station)_12%,transparent)] p-4">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-[0.1em] text-[var(--station)] uppercase">
            <span className="size-1.5 animate-pulse rounded-full bg-[var(--station)]" /> {t('onNow')} · {time(data.onAir.start)}–{time(data.onAir.end)}
          </div>
          <div className="display mt-1 text-lg">{data.onAir.name}</div>
          {data.onAir.djs.length > 0 && <div className="text-sm text-muted">{t('withDjs', { djs: data.onAir.djs.join(', ') })}</div>}
          {data.onAir.description && <p className="mt-1 text-sm text-muted">{data.onAir.description}</p>}
        </div>
      )}
      {!shown.length && !data.onAir && <p className="text-sm text-muted">{t('noShows')}</p>}
      <ul className="flex flex-col">
        {shown.map((s) => {
          const d = day(s.start);
          const header = d !== lastDay;
          lastDay = d;
          return (
            <li key={`${s.name}-${s.start}`}>
              {header && <div className="mt-2 mb-1 text-[11px] font-bold tracking-[0.08em] text-muted uppercase first:mt-0">{d}</div>}
              <div className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-hover">
                <span className="w-24 shrink-0 pt-0.5 text-xs whitespace-nowrap text-muted tabular-nums">
                  {time(s.start)}–{time(s.end)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    {s.live && <Mic className="size-3.5 shrink-0 text-[var(--station)]" />}
                    <span className="truncate">{s.name}</span>
                  </div>
                  {s.djs.length > 0 && <div className="truncate text-xs text-muted">{t('withDjs', { djs: s.djs.join(', ') })}</div>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {data.upcoming.length > limit && (
        <button type="button" onClick={() => setLimit((l) => l + 12)} className="w-full rounded-md py-2 text-[13px] font-semibold text-[var(--station)] hover:bg-hover">
          {t('showMore')}
        </button>
      )}
      {own !== tz && <p className="text-[11px] text-muted">{t('timesIn', { zone: tz.replace(/_/g, ' ') })}</p>}
    </div>
  );
}

export function StationPage({ np, theme, setTheme }: { np: NowPlaying; theme: 'light' | 'dark'; setTheme: (t: 'light' | 'dark') => void }) {
  const t = useT();
  const { lang } = useLang();
  const player = useLivePlayer(np);
  const elapsed = useElapsed(np.song?.startedAt);
  const onDemand = useOnDemand(np);
  const schedule = useSchedule(np);
  const hero = useRef<HTMLDivElement>(null);
  const [heroVisible, setHeroVisible] = useState(true);
  const playing = player.state === 'playing';
  const art = np.song?.artworkUrl ?? np.station.logoUrl;

  useEffect(() => {
    document.title = np.song ? `${np.song.text} · ${np.station.name}` : np.station.name;
  }, [np.song?.text, np.station.name]);
  useEffect(() => {
    if (!hero.current) return;
    const io = new IntersectionObserver(([e]) => setHeroVisible(!!e?.isIntersecting), { threshold: 0.15 });
    io.observe(hero.current);
    return () => io.disconnect();
  }, []);

  return (
    <div className="min-h-full">
      {/* Hero: blurred artwork behind the player */}
      <div ref={hero} className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          {art && <img src={art} alt="" className="absolute inset-0 size-full scale-125 object-cover opacity-45 blur-3xl saturate-150 dark:opacity-35" />}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,color-mix(in_srgb,var(--station)_30%,transparent),transparent_60%)]" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[color-mix(in_srgb,var(--surface)_55%,transparent)] to-surface" />
        </div>

        <header className="relative mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 pt-4 sm:px-8 sm:pt-6">
          <div className="flex min-w-0 items-center gap-3">
            {np.station.logoUrl ? (
              <img src={np.station.logoUrl} alt="" className="size-9 rounded-md object-cover shadow-sm" />
            ) : (
              <span className="grid size-9 place-items-center rounded-md bg-[var(--station)] text-[var(--on-station)]">
                <Headphones className="size-5" />
              </span>
            )}
            <span className="truncate text-sm font-bold">{np.station.name}</span>
          </div>
          <div className="flex items-center gap-1">
            <ShareButton np={np} />
            <Toggles theme={theme} setTheme={setTheme} />
          </div>
        </header>

        <div className="relative mx-auto grid max-w-6xl items-center gap-8 px-4 pt-8 pb-12 sm:px-8 sm:pt-14 sm:pb-16 md:grid-cols-[minmax(0,340px)_1fr] lg:gap-14">
          <div className="mx-auto w-full max-w-[340px]">
            <div className={clsx('transition-transform duration-700', playing && 'scale-[1.02]')}>
              <Artwork song={np.song} logo={np.station.logoUrl} className="aspect-square w-full shadow-2xl shadow-black/25" rounded="rounded-[22px]" />
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <LiveBadge np={np} />
              {np.listeners !== null && np.onAir && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-raised/70 px-2.5 py-1 text-[11px] font-semibold text-muted backdrop-blur">
                  <Headphones className="size-3.5" /> {t('listeners', { count: np.listeners })}
                </span>
              )}
              {np.station.genre && <span className="rounded-full bg-raised/70 px-2.5 py-1 text-[11px] font-semibold text-muted backdrop-blur">{np.station.genre}</span>}
              {np.schedule.show && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-raised/70 px-2.5 py-1 text-[11px] font-semibold backdrop-blur">
                  <CalendarDays className="size-3.5 text-[var(--station)]" /> {np.schedule.show.name}
                </span>
              )}
            </div>
            <p className="mt-6 flex items-center gap-2 text-xs font-bold tracking-[0.12em] text-[var(--station)] uppercase">
              <Equalizer playing={playing} />
              {np.onAir ? t('nowPlaying') : t('offAir')}
            </p>
            <h1 className="display mt-2 text-[34px] leading-[1.05] break-words sm:text-5xl lg:text-[56px]">{np.song?.title ?? np.station.name}</h1>
            <p className="mt-2 text-lg text-muted sm:text-xl">{np.song?.artist ?? (np.onAir ? np.station.description || ' ' : t('offAirText'))}</p>
            {elapsed !== null && <p className="mt-1 text-xs text-muted tabular-nums">{seconds(elapsed)}</p>}
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
              <div className="flex items-center gap-4">
                <PlayButton player={player} disabled={!np.onAir} />
                <div className="flex flex-col">
                  <span className="text-sm font-semibold">{player.state === 'loading' ? t('connecting') : t('listen')}</span>
                  {player.mount && <span className="text-xs text-muted">{player.mount.format.toUpperCase()} · {player.mount.bitrateKbps} kbps</span>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <VolumeControl player={player} />
                <QualitySelect player={player} />
              </div>
            </div>
            {player.state === 'error' && <p className="mt-4 max-w-md text-[13px] text-offline">{t('playError')}</p>}
          </div>
        </div>
      </div>

      <main className="mx-auto grid max-w-6xl gap-4 px-4 pb-28 sm:px-8 lg:grid-cols-[1.15fr_1fr]">
        <div className="flex flex-col gap-4">
          {np.history.length > 0 || np.onAir ? (
            <Section icon={<History className="size-[18px]" />} title={t('recentlyPlayed')}>
              <HistoryList items={np.history} />
            </Section>
          ) : null}
          {np.onDemand.enabled && (
            <Section icon={<ListMusic className="size-[18px]" />} title={t('onDemand')} subtitle={t('onDemandText')}>
              <OnDemandList items={onDemand.items} onPlay={player.stop} />
              {onDemand.total > onDemand.items.length && (
                <button type="button" onClick={onDemand.more} className="mt-3 w-full rounded-md py-2 text-[13px] font-semibold text-[var(--station)] hover:bg-hover">
                  {t('onDemandMore')}
                </button>
              )}
            </Section>
          )}
        </div>
        <div className="flex flex-col gap-4">
          {np.schedule.enabled && schedule && (schedule.onAir || schedule.upcoming.length > 0) && (
            <Section icon={<CalendarDays className="size-[18px]" />} title={t('schedule')} subtitle={t('scheduleText')}>
              <ScheduleList data={schedule} />
            </Section>
          )}
          {np.requests.enabled && (
            <Section icon={<Inbox className="size-[18px]" />} title={t('requestTitle')} subtitle={t('requestText')}>
              <RequestForm np={np} />
            </Section>
          )}
          {(np.station.description || np.station.website || Object.keys(np.station.links).length > 0) && (
            <Section icon={<Headphones className="size-[18px]" />} title={t('about')}>
              {np.station.description && <p className="mb-4 text-sm leading-relaxed whitespace-pre-line text-muted">{np.station.description}</p>}
              <Links np={np} />
            </Section>
          )}
          {np.live && (
            <p className="px-1 text-xs text-muted">
              {t('liveWith', { dj: np.live.dj })} · {timeAgo(lang, np.live.since)}
            </p>
          )}
        </div>
      </main>

      <footer className="flex justify-center pb-24">
        <PoweredBy />
      </footer>

      {/* Mini player once the big one is out of view */}
      <div
        className={clsx(
          'fixed inset-x-0 bottom-0 z-20 border-t border-line bg-raised/85 backdrop-blur-xl transition-transform duration-300',
          heroVisible ? 'translate-y-full' : 'translate-y-0',
        )}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 sm:px-8">
          <Artwork song={np.song} logo={np.station.logoUrl} className="size-11" rounded="rounded-md" />
          <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="min-w-0 flex-1 text-left" title={t('backToTop')}>
            {np.song ? <SongLine song={np.song} /> : <div className="truncate font-semibold">{np.station.name}</div>}
          </button>
          <VolumeControl player={player} compact />
          <PlayButton player={player} size="md" disabled={!np.onAir} />
        </div>
      </div>
    </div>
  );
}
