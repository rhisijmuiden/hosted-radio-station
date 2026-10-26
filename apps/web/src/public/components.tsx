import clsx from 'clsx';
import { Check, Globe, LoaderCircle, Moon, Pause, Play, Radio, Send, Sun, Volume2, VolumeX } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { clock, params, seconds, timeAgo, useLang, useT, type LivePlayer, type NowPlaying, type OnDemandItem, type Song } from './lib';

/** Album art, else the station logo, else a soft gradient with a radio. */
export function Artwork({ song, logo, className, rounded = 'rounded-lg' }: { song?: Song | null; logo?: string | null; className?: string; rounded?: string }) {
  const src = song?.artworkUrl ?? logo ?? null;
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className={clsx('relative shrink-0 overflow-hidden bg-gradient-to-br from-[var(--station)] to-nacht', rounded, className)}>
      {src && failed !== src ? (
        <img key={src} src={src} alt="" className="absolute inset-0 size-full object-cover" onError={() => setFailed(src)} loading="lazy" />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-white/85">
          <Radio className="size-1/3" strokeWidth={1.5} />
        </div>
      )}
    </div>
  );
}

/** Animated bars while audio plays. */
export function Equalizer({ playing, className }: { playing: boolean; className?: string }) {
  return (
    <span className={clsx('inline-flex h-3.5 items-end gap-[2px]', className)} aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <i
          key={i}
          className={clsx('w-[3px] rounded-full bg-current', playing ? 'animate-[eq_0.9s_ease-in-out_infinite]' : 'h-1')}
          style={playing ? { animationDelay: `${i * -0.22}s`, height: '100%' } : undefined}
        />
      ))}
    </span>
  );
}

export function PlayButton({ player, size = 'lg', disabled }: { player: LivePlayer; size?: 'sm' | 'md' | 'lg'; disabled?: boolean }) {
  const t = useT();
  const busy = player.state === 'loading';
  const on = player.state === 'playing' || busy;
  return (
    <button
      type="button"
      onClick={player.toggle}
      disabled={disabled || !player.mount}
      aria-label={on ? t('pause') : t('play')}
      className={clsx(
        'group relative grid shrink-0 place-items-center rounded-full bg-[var(--station)] text-[var(--on-station)] shadow-lg shadow-[color-mix(in_srgb,var(--station)_35%,transparent)] transition hover:scale-[1.04] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none',
        size === 'lg' ? 'size-16 sm:size-[72px]' : size === 'md' ? 'size-12' : 'size-10',
      )}
    >
      {on && !busy && <span className="absolute inset-0 animate-ping rounded-full bg-[var(--station)] opacity-20" />}
      {busy ? (
        <LoaderCircle className={clsx('animate-spin', size === 'lg' ? 'size-7' : 'size-5')} />
      ) : on ? (
        <Pause className={clsx('fill-current', size === 'lg' ? 'size-7' : 'size-5')} />
      ) : (
        <Play className={clsx('translate-x-[2px] fill-current', size === 'lg' ? 'size-7' : 'size-5')} />
      )}
    </button>
  );
}

export function VolumeControl({ player, compact }: { player: LivePlayer; compact?: boolean }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => player.setMuted(!player.muted)} className="rounded-full p-1.5 text-muted hover:bg-hover hover:text-ink" aria-label={player.muted ? t('unmute') : t('mute')}>
        {player.muted || player.volume === 0 ? <VolumeX className="size-[18px]" /> : <Volume2 className="size-[18px]" />}
      </button>
      {!compact && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={player.muted ? 0 : player.volume}
          onChange={(e) => {
            player.setMuted(false);
            player.setVolume(Number(e.target.value));
          }}
          aria-label={t('volume')}
          className="h-1 w-24 cursor-pointer accent-[var(--station)]"
        />
      )}
    </div>
  );
}

export function QualitySelect({ player }: { player: LivePlayer }) {
  const t = useT();
  if (player.options.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="sr-only">{t('quality')}</span>
      <select
        value={player.mount?.path}
        onChange={(e) => player.choose(e.target.value)}
        className="h-8 rounded-full border border-line bg-raised px-3 text-xs font-semibold text-ink focus:border-[var(--station)] focus:outline-none"
      >
        {player.options.map((m) => (
          <option key={m.path} value={m.path}>
            {m.name || m.format.toUpperCase()} · {m.bitrateKbps} kbps
          </option>
        ))}
      </select>
    </label>
  );
}

export function LiveBadge({ np }: { np: NowPlaying }) {
  const t = useT();
  if (np.live) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#D93636] px-2.5 py-1 text-[11px] font-bold tracking-wide text-white uppercase">
        <i className="size-1.5 animate-pulse rounded-full bg-white" />
        {t('liveWith', { dj: np.live.dj })}
      </span>
    );
  }
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide uppercase', np.onAir ? 'bg-online/15 text-online' : 'bg-chip text-muted')}>
      <i className="size-1.5 rounded-full bg-current" />
      {np.onAir ? t('onAir') : t('offAir')}
    </span>
  );
}

export function PoweredBy({ className }: { className?: string }) {
  const t = useT();
  return (
    <a href="https://rhis.nl" target="_blank" rel="noreferrer" className={clsx('inline-flex items-center gap-1.5 text-[11px] text-muted hover:text-ink', className)}>
      {t('poweredBy')}
      <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-3 dark:hidden" />
      <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-3 dark:block" />
    </a>
  );
}

export function Toggles({ theme, setTheme }: { theme: 'light' | 'dark'; setTheme: (t: 'light' | 'dark') => void }) {
  const t = useT();
  const { lang, setLang } = useLang();
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setLang(lang === 'en' ? 'nl' : 'en')}
        className="h-8 rounded-full px-2.5 text-xs font-bold text-muted uppercase hover:bg-hover hover:text-ink"
        aria-label={t('language')}
      >
        {lang === 'en' ? 'NL' : 'EN'}
      </button>
      <button
        type="button"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        className="grid size-8 place-items-center rounded-full text-muted hover:bg-hover hover:text-ink"
        aria-label={theme === 'dark' ? t('light') : t('dark')}
      >
        {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>
    </div>
  );
}

export function SongLine({ song, className }: { song: Song | null; className?: string }) {
  if (!song) return null;
  return (
    <div className={clsx('min-w-0', className)}>
      <div className="truncate font-semibold">{song.title}</div>
      {song.artist && <div className="truncate text-[13px] text-muted">{song.artist}</div>}
    </div>
  );
}

export function HistoryList({ items, limit }: { items: NowPlaying['history']; limit?: number }) {
  const t = useT();
  const { lang } = useLang();
  if (!items.length) return <p className="py-6 text-center text-[13px] text-muted">{t('nothingPlayed')}</p>;
  return (
    <ol className="flex flex-col">
      {items.slice(0, limit).map((s, i) => (
        <li key={`${s.playedAt}-${i}`} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-hover">
          <Artwork song={s} className="size-11" rounded="rounded-md" />
          <SongLine song={s} className="flex-1" />
          <time className="shrink-0 text-xs text-muted tabular-nums" dateTime={s.playedAt} title={clock(lang, s.playedAt)}>
            {timeAgo(lang, s.playedAt)}
          </time>
        </li>
      ))}
    </ol>
  );
}

const inputClass =
  'h-11 w-full rounded-md border border-line bg-raised px-3.5 text-sm text-ink placeholder:text-muted/70 focus:border-[var(--station)] focus:outline-none disabled:opacity-60';

export function RequestForm({ np }: { np: NowPlaying }) {
  const t = useT();
  const [form, setForm] = useState({ artist: '', title: '', name: '', message: '', website: '' });
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  if (!np.requests.enabled) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('sending');
    try {
      const res = await fetch(`/api/public/stations/${np.station.slug}/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
      if (res.ok) {
        setState('sent');
        setForm({ ...form, artist: '', title: '', message: '' });
        return;
      }
      const code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
      setError(code === 'too_many_requests' || res.status === 429 ? t('requestsTooMany') : code === 'requests_closed' ? t('requestsClosed') : t('requestFailed'));
      setState('error');
    } catch {
      setError(t('requestFailed'));
      setState('error');
    }
  };
  if (!np.requests.open) return <p className="rounded-md bg-chip px-4 py-3 text-[13px] text-muted">{t('requestsClosed')}</p>;
  if (state === 'sent') {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md bg-online/10 px-4 py-6 text-center">
        <span className="grid size-10 place-items-center rounded-full bg-online text-white">
          <Check className="size-5" />
        </span>
        <p className="text-sm font-semibold">{t('requestSent')}</p>
        <button type="button" onClick={() => setState('idle')} className="text-[13px] font-semibold text-[var(--station)] hover:underline">
          {t('requestAnother')}
        </button>
      </div>
    );
  }
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      {np.requests.message && <p className="text-[13px] text-muted">{np.requests.message}</p>}
      <div className="grid gap-2.5 sm:grid-cols-2">
        <input required maxLength={120} className={inputClass} placeholder={t('requestArtist')} value={form.artist} onChange={set('artist')} />
        <input required maxLength={160} className={inputClass} placeholder={t('requestSong')} value={form.title} onChange={set('title')} />
      </div>
      <input maxLength={60} className={inputClass} placeholder={t('requestName')} value={form.name} onChange={set('name')} />
      <textarea maxLength={300} rows={2} className={clsx(inputClass, 'h-auto py-2.5')} placeholder={t('requestMessage')} value={form.message} onChange={set('message')} />
      {/* Left empty by people; bots fill in every field. */}
      <input tabIndex={-1} autoComplete="off" className="absolute -left-[9999px] h-0 w-0 opacity-0" aria-hidden value={form.website} onChange={set('website')} />
      {state === 'error' && <p className="text-[13px] text-offline">{error}</p>}
      <button
        type="submit"
        disabled={state === 'sending'}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-[var(--station)] px-5 text-sm font-bold text-[var(--on-station)] transition hover:brightness-95 disabled:opacity-60"
      >
        {state === 'sending' ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
        {t('requestSend')}
      </button>
    </form>
  );
}

/** On-demand items with one shared audio element: one plays at a time, with seeking. */
export function OnDemandList({ items, onPlay }: { items: OnDemandItem[]; onPlay?: () => void }) {
  const t = useT();
  const { lang } = useLang();
  const [current, setCurrent] = useState<string | null>(null);
  const [audio] = useState(() => (typeof Audio !== 'undefined' ? new Audio() : null));
  const [pos, setPos] = useState({ t: 0, d: 0, playing: false });
  if (audio && !audio.dataset.wired) {
    audio.dataset.wired = '1';
    audio.preload = 'metadata';
    audio.addEventListener('timeupdate', () => setPos({ t: audio.currentTime, d: audio.duration, playing: !audio.paused }));
    audio.addEventListener('play', () => setPos((p) => ({ ...p, playing: true })));
    audio.addEventListener('pause', () => setPos((p) => ({ ...p, playing: false })));
  }
  if (!items.length) return <p className="py-6 text-center text-[13px] text-muted">{t('onDemandEmpty')}</p>;
  const toggle = (item: OnDemandItem) => {
    if (!audio) return;
    if (current === item.id) {
      if (audio.paused) void audio.play();
      else audio.pause();
      return;
    }
    onPlay?.();
    setCurrent(item.id);
    audio.src = item.audioUrl;
    void audio.play();
  };
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => {
        const active = current === item.id;
        const duration = active && Number.isFinite(pos.d) && pos.d > 0 ? pos.d : item.durationSeconds;
        return (
          <li key={item.id} className={clsx('rounded-md border px-3 py-3 transition-colors', active ? 'border-[var(--station)] bg-[color-mix(in_srgb,var(--station)_6%,transparent)]' : 'border-line')}>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => toggle(item)}
                className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--station)] text-[var(--on-station)] transition hover:scale-105"
                aria-label={active && pos.playing ? t('pause') : t('play')}
              >
                {active && pos.playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 translate-x-[1px] fill-current" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{item.title}</div>
                <div className="truncate text-xs text-muted">
                  {[item.host && t('with', { host: item.host }), item.recordedAt && new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.recordedAt)), seconds(item.durationSeconds)]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
            </div>
            {item.description && <p className="mt-2 text-[13px] text-muted">{item.description}</p>}
            {active && (
              <div className="mt-3 flex items-center gap-3 text-[11px] text-muted tabular-nums">
                <span>{seconds(pos.t)}</span>
                <input
                  type="range"
                  min={0}
                  max={duration ?? 0}
                  step={1}
                  value={pos.t}
                  onChange={(e) => audio && (audio.currentTime = Number(e.target.value))}
                  className="h-1 flex-1 cursor-pointer accent-[var(--station)]"
                  aria-label="Seek"
                />
                <span>{seconds(duration)}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const linkIcons: Record<string, ReactNode> = {
  instagram: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" />
    </>
  ),
  facebook: <path d="M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8z" />,
  x: <path d="M4 4l16 16M20 4L4 20" />,
  tiktok: <path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5M14 3c.5 2.5 2.5 4.5 5 5" />,
  youtube: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
      <path d="M10 9.5v5l4.5-2.5z" fill="currentColor" />
    </>
  ),
  soundcloud: <path d="M3 15v-2M6 16v-5M9 16V9M12 16V7a5 5 0 0 1 5 4 3 3 0 1 1 1 5h-6" />,
  mixcloud: <path d="M7 17a4 4 0 1 1 1-7.9A5 5 0 0 1 17.6 10 3.5 3.5 0 1 1 17 17z" />,
  whatsapp: <path d="M4 20l1.3-4A8 8 0 1 1 8 18.7zM9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 1a4 4 0 0 1-2-2l1-1-1-2z" />,
};

export function Links({ np }: { np: NowPlaying }) {
  const t = useT();
  const links = Object.entries(np.station.links);
  if (!links.length && !np.station.website) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {np.station.website && (
        <a href={np.station.website} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-full border border-line px-3.5 text-[13px] font-semibold hover:bg-hover">
          <Globe className="size-4" /> {t('website')}
        </a>
      )}
      {links.map(([kind, url]) => (
        <a key={kind} href={url} target="_blank" rel="noreferrer" aria-label={kind} title={kind} className="grid size-9 place-items-center rounded-full border border-line hover:bg-hover">
          <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {linkIcons[kind] ?? <circle cx="12" cy="12" r="8" />}
          </svg>
        </a>
      ))}
    </div>
  );
}

/** Widgets can be shown without their own background, so they blend into the website around them. */
export const transparent = params.get('transparent') === '1';
