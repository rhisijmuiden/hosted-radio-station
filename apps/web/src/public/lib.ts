import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { strings, type Lang, type StringKey } from './strings';

// Types of the public API (GET /api/public/stations/:slug/nowplaying).

export interface Song {
  text: string;
  artist: string | null;
  title: string;
  artworkUrl: string | null;
}
export interface PublicMount {
  path: string;
  name: string;
  format: string;
  contentType: string;
  bitrateKbps: number;
  isDefault: boolean;
  live: boolean;
  listenUrl: string | null;
}
export interface NowPlaying {
  station: {
    name: string;
    slug: string;
    description: string;
    genre: string;
    website: string;
    logoUrl: string | null;
    pageUrl: string;
    accentColor: string;
    theme: 'auto' | 'light' | 'dark';
    links: Record<string, string>;
  };
  onAir: boolean;
  live: { dj: string; since: string } | null;
  song: (Song & { startedAt: string | null }) | null;
  listeners: number | null;
  mounts: PublicMount[];
  history: (Song & { playedAt: string })[];
  requests: { enabled: boolean; open: boolean; message: string; library: boolean };
  onDemand: { enabled: boolean };
  updatedAt: string;
}
export interface OnDemandItem {
  id: string;
  title: string;
  description: string;
  host: string;
  source: string;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  recordedAt: string | null;
  publishedAt: string | null;
  audioUrl: string;
}

export const params = new URLSearchParams(location.search);

// Language

function initialLang(): Lang {
  const q = params.get('lang');
  if (q === 'en' || q === 'nl') return q;
  try {
    const saved = localStorage.getItem('hrs-lang');
    if (saved === 'en' || saved === 'nl') return saved;
  } catch {
    /* private mode */
  }
  return navigator.language.toLowerCase().startsWith('nl') ? 'nl' : 'en';
}

export function useLanguageState() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = (l: Lang) => {
    try {
      localStorage.setItem('hrs-lang', l);
    } catch {
      /* private mode */
    }
    setLangState(l);
  };
  return { lang, setLang };
}

export const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'en', setLang: () => {} });

export function useT() {
  const { lang } = useContext(LangContext);
  return useCallback(
    (key: StringKey | 'listeners', vars: Record<string, string | number> = {}) => {
      const k: StringKey = key === 'listeners' ? (vars.count === 1 ? 'listeners_one' : 'listeners_other') : key;
      return (strings[lang][k] ?? strings.en[k] ?? key).replace(/\{\{(\w+)\}\}/g, (_, v: string) => String(vars[v] ?? ''));
    },
    [lang],
  );
}

export function useLang() {
  return useContext(LangContext);
}

export function timeAgo(lang: Lang, iso: string) {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export const clock = (lang: Lang, iso: string) => new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export const day = (lang: Lang, iso: string) => new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(new Date(iso));

export function seconds(s: number | null | undefined) {
  if (s == null || !Number.isFinite(s)) return '–:––';
  const v = Math.max(0, Math.floor(s));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = String(v % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// Theme: ?theme= wins, then the listener's choice, then the station's preference, then the system.

export function useThemeState(stationTheme: 'auto' | 'light' | 'dark' | undefined) {
  const forced = params.get('theme');
  const [choice, setChoice] = useState<'light' | 'dark' | null>(() => {
    if (forced === 'light' || forced === 'dark') return forced;
    try {
      const v = localStorage.getItem('hrs-public-theme');
      return v === 'light' || v === 'dark' ? v : null;
    } catch {
      return null;
    }
  });
  const [system, setSystem] = useState<'light' | 'dark'>(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const theme = choice ?? (stationTheme && stationTheme !== 'auto' ? stationTheme : system);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const setTheme = (t: 'light' | 'dark') => {
    try {
      localStorage.setItem('hrs-public-theme', t);
    } catch {
      /* private mode */
    }
    setChoice(t);
  };
  return { theme, setTheme };
}

/** Accent colour of the station (or ?accent=), with a readable text colour on top of it. */
export function useAccent(color: string | undefined) {
  const q = params.get('accent');
  const accent = q && /^[0-9a-f]{6}$/i.test(q) ? `#${q}` : color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#FF6B57';
  useEffect(() => {
    const r = parseInt(accent.slice(1, 3), 16);
    const g = parseInt(accent.slice(3, 5), 16);
    const b = parseInt(accent.slice(5, 7), 16);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const root = document.documentElement.style;
    root.setProperty('--station', accent);
    root.setProperty('--on-station', lum > 0.55 ? '#14213D' : '#FFFFFF');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', accent);
  }, [accent]);
  return accent;
}

// Data

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
  return res.json() as Promise<T>;
}

/** Now playing of a station, kept up to date over Server-Sent Events (with polling as a fallback). */
export function useNowPlaying(slug: string) {
  const [data, setData] = useState<NowPlaying | null>(null);
  const [error, setError] = useState<number | null>(null);
  useEffect(() => {
    let closed = false;
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const load = () =>
      getJson<NowPlaying>(`/api/public/stations/${encodeURIComponent(slug)}/nowplaying`)
        .then((np) => !closed && (setData(np), setError(null)))
        .catch((e: { status?: number }) => !closed && setError(e.status ?? 0));
    void load();
    if ('EventSource' in window) {
      es = new EventSource(`/api/public/stations/${encodeURIComponent(slug)}/events`);
      es.addEventListener('nowplaying', (e) => {
        setData(JSON.parse((e as MessageEvent).data) as NowPlaying);
        setError(null);
      });
      es.addEventListener('gone', () => setError(404));
    } else {
      poll = setInterval(load, 15_000);
    }
    return () => {
      closed = true;
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, [slug]);
  return { data, error };
}

/** Seconds since a moment, ticking every second. */
export function useElapsed(since: string | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? Math.max(0, (now - new Date(since).getTime()) / 1000) : null;
}

// The live player

/** Mounts this browser can play, best first: the default, then higher bitrates. */
export function playable(mounts: PublicMount[]) {
  const a = document.createElement('audio');
  const can = (m: PublicMount) => {
    const type = m.format === 'opus' ? 'audio/ogg; codecs=opus' : m.format === 'vorbis' ? 'audio/ogg; codecs=vorbis' : m.contentType;
    return !!m.listenUrl && a.canPlayType(type) !== '';
  };
  return mounts.filter(can).sort((x, y) => Number(y.isDefault) - Number(x.isDefault) || y.bitrateKbps - x.bitrateKbps);
}

export type PlayState = 'stopped' | 'loading' | 'playing' | 'error';

function loadVolume() {
  try {
    const v = Number(localStorage.getItem('hrs-volume'));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
  } catch {
    return 0.9;
  }
}

/**
 * Plays a live stream. Stopping really disconnects (no buffering in the background, no counting as a listener), and
 * playing again starts at "now". Lock screens and headsets get the title and artwork through the Media Session API.
 */
export function useLivePlayer(np: NowPlaying | null) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<PlayState>('stopped');
  const [volume, setVolumeState] = useState(loadVolume);
  const [muted, setMuted] = useState(false);
  const options = np ? playable(np.mounts) : [];
  const [mountPath, setMountPath] = useState<string | null>(null);
  const mount = options.find((m) => m.path === mountPath) ?? options[0] ?? null;

  if (!audio.current && typeof Audio !== 'undefined') {
    audio.current = new Audio();
    audio.current.preload = 'none';
  }

  useEffect(() => {
    const a = audio.current!;
    const on = (s: PlayState) => () => setState(s);
    const handlers: [string, () => void][] = [
      ['playing', on('playing')],
      ['waiting', on('loading')],
      ['error', () => a.src && setState('error')],
    ];
    for (const [e, h] of handlers) a.addEventListener(e, h);
    return () => {
      for (const [e, h] of handlers) a.removeEventListener(e, h);
      a.pause();
      a.removeAttribute('src');
      a.load();
    };
  }, []);

  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
    try {
      localStorage.setItem('hrs-volume', String(volume));
    } catch {
      /* private mode */
    }
  }, [volume]);
  useEffect(() => {
    if (audio.current) audio.current.muted = muted;
  }, [muted]);

  const stop = useCallback(() => {
    const a = audio.current!;
    a.pause();
    a.removeAttribute('src');
    a.load();
    setState('stopped');
  }, []);

  const play = useCallback(
    (path?: string) => {
      const m = options.find((x) => x.path === (path ?? mount?.path)) ?? options[0];
      if (!m?.listenUrl) return;
      const a = audio.current!;
      // A fresh connection every time, so playback starts live and caches never replay old audio.
      a.src = `${m.listenUrl}${m.listenUrl.includes('?') ? '&' : '?'}_=${Date.now().toString(36)}`;
      setState('loading');
      a.play().catch((err: Error) => setState(err.name === 'NotAllowedError' ? 'stopped' : 'error'));
    },
    [options, mount?.path],
  );

  const toggle = () => (state === 'playing' || state === 'loading' ? stop() : play());
  const choose = (path: string) => {
    setMountPath(path);
    if (state === 'playing' || state === 'loading') play(path);
  };

  // Lock screen / notification controls.
  const song = np?.song;
  useEffect(() => {
    if (!('mediaSession' in navigator) || !np) return;
    const art = song?.artworkUrl ?? np.station.logoUrl;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song?.title ?? np.station.name,
      artist: song?.artist ?? (np.live ? np.live.dj : np.station.name),
      album: np.station.name,
      artwork: art ? [{ src: art, sizes: '600x600' }] : [{ src: '/brand/rhis-icon.svg', sizes: '512x512', type: 'image/svg+xml' }],
    });
    navigator.mediaSession.setActionHandler('play', () => play());
    navigator.mediaSession.setActionHandler('pause', stop);
    navigator.mediaSession.setActionHandler('stop', stop);
  }, [np, song?.text, song?.artworkUrl, play, stop]);

  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state === 'playing' ? 'playing' : state === 'loading' ? 'playing' : 'paused';
  }, [state]);

  return { state, play, stop, toggle, volume, setVolume: setVolumeState, muted, setMuted, mount, options, choose };
}
export type LivePlayer = ReturnType<typeof useLivePlayer>;
