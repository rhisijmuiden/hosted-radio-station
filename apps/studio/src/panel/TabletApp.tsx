import clsx from 'clsx';
import { Lock, LogOut, Mic, MicOff, Play, SkipForward, Square, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LanguageToggle, ThemeToggle } from '../components/Toggles';
import { duration } from '../lib/format';
import { useTheme } from '../lib/theme';
import { ThemeContext } from '../lib/theme-context';
import { connect, demo, forget, onMeters, pair, panelStore, send, usePanelStore } from './connection';
import type { PanelDeck, PanelLogRow, PanelState } from './protocol';

/** Ticks a few times a second, for the countdowns between two updates of the PC. */
function useTick(ms = 250) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** The PC's clock now, as this tablet counts it. */
const pcNow = () => Date.now() + panelStore().offset;

const clockText = (ms: number, seconds = true) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false });

export function TabletApp() {
  const theme = useTheme();
  const link = usePanelStore((s) => s.link);
  useEffect(() => connect(), []);
  return (
    <ThemeContext.Provider value={theme}>
      <div className="flex h-full flex-col overflow-y-auto bg-surface text-ink select-none">{link === 'unpaired' || link === 'revoked' ? <PairScreen revoked={link === 'revoked'} /> : <Studio />}</div>
    </ThemeContext.Provider>
  );
}

function PairScreen({ revoked }: { revoked: boolean }) {
  const { t } = useTranslation();
  const fromLink = new URLSearchParams(location.search).get('pair') ?? '';
  const [code, setCode] = useState(fromLink);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(revoked ? t('tablet.unpaired') : null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await pair(code, name.trim() || t('tablet.defaultName'));
      // The code is used: keep it out of the address bar and the bookmarks.
      history.replaceState(null, '', '/');
    } catch (err) {
      const m = (err as Error).message;
      setError(m === 'wrong' ? t('tablet.wrongCode') : m === 'expired' ? t('tablet.expiredCode') : t('tablet.pairFailed', { error: m }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid flex-1 place-items-center p-6">
      <form
        className="grid w-full max-w-md gap-5 rounded-lg border border-line bg-raised p-7 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <div className="flex items-center gap-3">
          <img src="/brand/rhis-icon-koraal.svg" alt="" className="size-10" />
          <div>
            <div className="display text-[22px] leading-tight">{t('tablet.pairTitle')}</div>
            <div className="text-[13px] text-muted">RHIS Studio · {t('tablet.title')}</div>
          </div>
        </div>
        <p className="text-[14px] text-muted">{t('tablet.pairText')}</p>
        <label className="grid gap-1.5">
          <span className="text-[13px] font-semibold">{t('tablet.codeLabel')}</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            className="h-16 rounded-md border border-line bg-surface text-center text-[32px] font-bold tracking-[0.3em] tabular outline-none focus:border-koraal"
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[13px] font-semibold">{t('tablet.nameLabel')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('tablet.namePlaceholder')} maxLength={40} className="h-12 rounded-md border border-line bg-surface px-3 text-[16px] outline-none focus:border-koraal" />
        </label>
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[14px] text-offline">{error}</p>}
        <button type="submit" disabled={code.length !== 6 || busy} className="h-14 rounded-md bg-koraal text-[17px] font-extrabold text-white disabled:opacity-50">
          {t('tablet.connect')}
        </button>
      </form>
    </div>
  );
}

function Studio() {
  const { t } = useTranslation();
  const s = usePanelStore((v) => v.state);
  const link = usePanelStore((v) => v.link);
  useTick();
  const on = s?.phase === 'on';
  return (
    <>
      <TopBar s={s} />
      {link !== 'online' && (
        <div className="flex items-center gap-3 bg-warning/15 px-5 py-2.5 text-[14px] font-semibold" role="status">
          <WifiOff className="size-4 shrink-0" />
          {link === 'connecting' && !s ? t('tablet.connecting') : t('tablet.reconnecting')}
        </div>
      )}
      <main className={clsx('flex-1 p-4 lg:p-5', link !== 'online' && 'pointer-events-none opacity-60')}>
        {!s ? null : on ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-[1fr_1fr_260px]">
            <Player s={s} i={0} />
            <Player s={s} i={1} />
            <MicColumn s={s} />
            <Log rows={s.log} />
          </div>
        ) : (
          <Off s={s} />
        )}
      </main>
    </>
  );
}

function TopBar({ s }: { s: PanelState | null }) {
  const { t } = useTranslation();
  const tablet = usePanelStore((v) => v.tablet);
  const on = s?.phase === 'on';
  const block = s?.nextBlock;
  const left = block ? Math.max(0, (block.at - pcNow()) / 1000) : null;
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-raised px-5 py-3">
      <img src="/brand/rhis-icon-koraal.svg" alt="RHIS" className="size-9" />
      <div className="min-w-0">
        <div className="display truncate text-[17px] leading-tight">{s?.station ?? t('tablet.title')}</div>
        <div className="truncate text-[12px] text-muted">{s ? [s.user, t('tablet.controls', { pc: s.pc })].filter(Boolean).join(' · ') : (tablet?.name ?? '')}</div>
      </div>
      <span className={clsx('rounded-full px-3 py-1.5 text-[12px] font-extrabold tracking-[0.08em] uppercase', on ? 'onair-pulse bg-onair text-white' : 'bg-chip text-muted')}>
        {on ? `${t('tablet.onAir')} · ${t('tablet.studioMode')}` : t('tablet.autodj')}
      </span>
      <div className="flex-1" />
      {block && left != null && (
        <div className="text-right">
          <div className="flex items-center justify-end gap-1 text-[11px] font-bold tracking-[0.06em] text-muted uppercase">
            {block.locked && <Lock className="size-3" />}
            {t('tablet.nextBlock')}
            {block.hard && ` · ${t('tablet.hard')}`}
          </div>
          <div className="text-[16px] font-bold tabular">
            {block.label || '–'} {clockText(block.at, false)} · <span className={clsx(left < 60 && 'text-accent-text')}>{duration(left)}</span>
          </div>
        </div>
      )}
      <div className="display text-[28px] leading-none tabular">{clockText(pcNow())}</div>
      <Menu />
    </header>
  );
}

function Menu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="grid size-11 place-items-center rounded-md border border-line text-muted" aria-label={t('nav.settings')} aria-expanded={open}>
        <span className="text-[20px] leading-none">⋯</span>
      </button>
      {open && (
        <div className="absolute top-12 right-0 z-20 grid w-64 gap-3 rounded-lg border border-line bg-raised p-4 shadow-xl">
          <div className="flex items-center justify-between gap-2">
            <ThemeToggle />
            <LanguageToggle />
          </div>
          {!demo && (
            <button
              type="button"
              onClick={() => {
                if (confirm(t('tablet.forgetConfirm'))) forget();
              }}
              className="flex h-11 items-center gap-2 rounded-md border border-line px-3 text-[14px] font-semibold text-offline"
            >
              <LogOut className="size-4" /> {t('tablet.forget')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Off({ s }: { s: PanelState }) {
  const { t } = useTranslation();
  const text = !s.station ? t('tablet.noStation') : !s.available ? t('tablet.unavailable') : s.phase === 'off' ? t('tablet.offText', { pc: s.pc }) : t(`tablet.${s.phase}`);
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <div className="max-w-lg text-center">
        <div className="mx-auto mb-4 grid size-16 place-items-center rounded-full bg-chip text-muted">
          <MicOff className="size-7" />
        </div>
        <div className="display text-[24px]">{s.phase === 'off' ? t('tablet.offTitle') : t('tablet.studioMode')}</div>
        <p className="mt-2 text-[15px] text-muted">{text}</p>
      </div>
    </div>
  );
}

/** Seconds into the file now: counted on from the last update while the track plays. */
function positionOf(d: PanelDeck) {
  const { receivedAt } = panelStore();
  return d.playing ? d.position + (Date.now() - receivedAt) / 1000 : d.position;
}

function Player({ s, i }: { s: PanelState; i: 0 | 1 }) {
  const { t } = useTranslation();
  const d = s.decks[i];
  const label = i === 0 ? 'A' : 'B';
  const air = d.role === 'air';
  const pos = positionOf(d);
  const remaining = air ? Math.max(0, d.end - pos) : null;
  const intro = air && d.intro != null ? d.intro - pos : null;
  const pct = air && d.end > d.start ? Math.min(100, ((pos - d.start) / (d.end - d.start)) * 100) : 0;
  const other = s.decks[i === 0 ? 1 : 0];
  const startsIn = d.role === 'next' && other.role === 'air' ? Math.max(0, other.end - positionOf(other)) : null;
  const manual = s.manual || s.faderStart;
  const nothingOnAir = !s.decks.some((x) => x.role === 'air');
  const tag = air ? t('tablet.playing') : d.role === 'next' ? (d.ready ? t('tablet.next') : t('tablet.loading')) : t('tablet.empty');
  return (
    <section className={clsx('flex min-w-0 flex-col gap-3 rounded-lg border-2 p-4', air ? 'border-studio bg-studio/[0.08]' : 'border-line bg-raised')} aria-label={t('tablet.player', { label })}>
      <div className="flex items-center gap-2 text-[12px] font-extrabold tracking-[0.08em] text-muted uppercase">
        <span className={clsx('grid size-7 place-items-center rounded-[6px] text-[14px] text-nacht', i === 0 ? 'bg-lucht' : 'bg-online/70')}>{label}</span>
        <span className={clsx('rounded-full px-2 py-0.5', air ? 'bg-studio text-nacht' : 'bg-chip')}>{tag}</span>
        {d.locked && (
          <span className="inline-flex items-center gap-1 rounded-full bg-koraal/15 px-2 py-0.5 text-accent-text">
            <Lock className="size-3" /> {t('tablet.locked')}
          </span>
        )}
      </div>
      <div className="min-h-[52px] min-w-0">
        <div className="display truncate text-[22px] leading-tight">{d.title || t('tablet.nothing')}</div>
        <div className="truncate text-[15px] text-muted">
          {[d.artist, startsIn != null && !manual ? t('tablet.startsIn', { time: duration(startsIn) }) : d.role === 'next' && manual ? t(s.faderStart ? 'tablet.openFader' : 'tablet.pressPlay') : null].filter(Boolean).join(' · ') || ' '}
        </div>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-meter">
        <div className={clsx('h-full', air ? 'bg-studio' : 'bg-koraal')} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-[10px] font-bold tracking-[0.08em] text-muted uppercase">{air ? t('tablet.remaining') : t('tablet.length')}</div>
          <div className={clsx('display text-[44px] leading-none tabular', remaining != null && remaining < 15 && 'text-accent-text')}>{air ? `-${duration(remaining)}` : duration(d.length)}</div>
        </div>
        {intro != null && intro > 0 && (
          <div className="rounded-md bg-lucht/25 px-3 py-1 text-right">
            <div className="text-[10px] font-bold tracking-[0.08em] text-muted uppercase">{t('tablet.intro')}</div>
            <div className={clsx('display text-[26px] leading-none tabular', intro < 5 && 'text-accent-text')}>{Math.ceil(intro)}</div>
          </div>
        )}
      </div>
      <div className="mt-auto flex gap-2.5">
        {air ? (
          <>
            {manual && (
              <BigButton tone="stop" onClick={() => send({ cmd: 'stop' })} label={t('tablet.btnStop')}>
                <Square className="size-5 fill-current" />
              </BigButton>
            )}
            <BigButton tone="primary" disabled={!s.canNext} onClick={() => send({ cmd: 'next' })} label={t('tablet.btnNext')} grow title={!s.canNext && d.locked ? t('tablet.lockedOnAir') : undefined}>
              <SkipForward className="size-5" />
            </BigButton>
          </>
        ) : (
          <BigButton tone={nothingOnAir && manual ? 'play' : 'secondary'} disabled={d.role !== 'next' || !d.ready || !s.canNext} onClick={() => send({ cmd: 'next' })} label={nothingOnAir && manual ? t('tablet.btnPlay') : t('tablet.btnNext')} grow>
            <Play className="size-5 fill-current" />
          </BigButton>
        )}
      </div>
    </section>
  );
}

function BigButton({ tone, onClick, disabled, label, grow, title, children }: { tone: 'primary' | 'secondary' | 'stop' | 'play'; onClick: () => void; disabled?: boolean; label: string; grow?: boolean; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        'flex h-16 items-center justify-center gap-2 rounded-md border px-4 text-[17px] font-extrabold transition-transform active:scale-[0.97] disabled:opacity-40',
        grow ? 'flex-[2]' : 'flex-1',
        tone === 'primary' && 'border-nacht bg-nacht text-white dark:border-koraal dark:bg-koraal',
        tone === 'secondary' && 'border-line bg-surface text-ink',
        tone === 'stop' && 'border-offline/50 bg-offline/10 text-offline',
        tone === 'play' && 'onair-pulse border-online bg-online text-white',
      )}
    >
      {children}
      {label}
    </button>
  );
}

function MicColumn({ s }: { s: PanelState }) {
  const { t } = useTranslation();
  return (
    <section className="grid gap-3 rounded-lg border border-line bg-raised p-4 md:col-span-2 md:grid-cols-[1fr_220px] lg:col-span-1 lg:grid-cols-1 lg:grid-rows-[1fr_auto]">
      {s.faderStart ? (
        <div className="grid gap-2" role="group" aria-label={t('tablet.faders')}>
          <div className="text-[11px] font-bold tracking-[0.08em] text-muted uppercase">{t('tablet.faders')}</div>
          <div className="grid flex-1 grid-cols-3 gap-2">
            {(['A', 'B', 'MIC'] as const).map((label, i) => {
              const open = s.faders[i]! > 0.02;
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={open}
                  onClick={() => send({ cmd: 'fader', channel: i as 0 | 1 | 2 })}
                  className={clsx(
                    'grid min-h-28 place-items-center content-center gap-1 rounded-md border-2 text-[18px] font-extrabold active:scale-[0.97]',
                    open ? (i === 2 ? 'border-onair bg-onair text-white' : 'border-studio bg-studio text-nacht') : 'border-line bg-surface text-muted',
                  )}
                >
                  {label === 'MIC' ? t('tablet.meterMic') : label}
                  <span className="text-[11px] font-semibold uppercase">{open ? t('tablet.faderOpen') : t('tablet.faderClosed')}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[12px] text-muted">{t('tablet.faderHint')}</p>
        </div>
      ) : (
        <button
          type="button"
          aria-pressed={s.mic}
          onClick={() => send({ cmd: 'mic' })}
          className={clsx(
            'grid min-h-36 place-items-center content-center gap-1 rounded-lg border-2 text-[22px] font-extrabold tracking-[0.08em] uppercase transition-transform active:scale-[0.98]',
            s.mic ? 'onair-pulse border-onair bg-onair text-white' : 'border-line bg-surface text-ink',
          )}
        >
          {s.mic ? <Mic className="size-8" /> : <MicOff className="size-8" />}
          {s.mic ? t('tablet.micOn') : t('tablet.micOff')}
          <span className="text-[12px] font-semibold tracking-normal normal-case opacity-80">{s.micAutoOff ? t('tablet.micNews') : s.mic ? t('tablet.micTapClose') : t('tablet.micTapOpen')}</span>
        </button>
      )}
      <Meters />
    </section>
  );
}

function Meters() {
  const { t } = useTranslation();
  const bars = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  useEffect(
    () =>
      onMeters((m) => {
        [m.music, m.mic, m.air].forEach((v, i) => {
          const el = bars[i]!.current;
          if (el) el.style.height = `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;
        });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return (
    <div className="grid h-32 grid-cols-3 gap-2">
      {[t('tablet.meterMusic'), t('tablet.meterMic'), t('tablet.meterAir')].map((label, i) => (
        <div key={label} className="grid grid-rows-[1fr_auto] gap-1 text-center text-[10.5px] font-bold tracking-[0.05em] text-muted uppercase">
          <div className="relative overflow-hidden rounded-[5px] border border-line bg-meter">
            <div ref={bars[i]} className="absolute inset-x-0 bottom-0 transition-[height] duration-100 ease-linear" style={{ height: '0%', background: 'linear-gradient(0deg, var(--status-online) 0 65%, var(--status-warning) 65% 85%, var(--status-offline) 85%)', backgroundSize: '100% 128px', backgroundPosition: 'bottom' }} />
          </div>
          {label}
        </div>
      ))}
    </div>
  );
}

const DOT: Record<PanelLogRow['kind'], string> = { music: 'bg-online', item: 'bg-koraal', news: 'bg-lucht', block: 'bg-studio' };

function Log({ rows }: { rows: PanelLogRow[] }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border border-line bg-raised p-2 md:col-span-2 lg:col-span-3" aria-label={t('tablet.log')}>
      <div className="px-3 pt-1 pb-2 text-[11px] font-bold tracking-[0.08em] text-muted uppercase">{t('tablet.log')}</div>
      {!rows.length ? (
        <p className="px-3 pb-3 text-[14px] text-muted">{t('tablet.logEmpty')}</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.id} className={clsx('grid grid-cols-[84px_12px_1fr_auto] items-center gap-3 rounded-md px-3 py-3 text-[16px]', r.role === 'air' && 'bg-studio/10', r.role !== 'air' && 'border-t border-line/60')}>
              <span className="text-[14px] font-semibold text-muted tabular">{clockText(r.at)}</span>
              <span className={clsx('size-2.5 rounded-full', DOT[r.kind])} />
              <span className="min-w-0 truncate">
                <b>{r.title}</b>
                {r.artist && <span className="text-muted"> · {r.artist}</span>}
              </span>
              <span className="flex items-center gap-2 text-[12px] font-bold">
                {r.locked && (
                  <span className="inline-flex items-center gap-1 rounded-[5px] bg-lucht/20 px-2 py-0.5 tracking-[0.04em] uppercase">
                    <Lock className="size-3" /> {t('tablet.locked')}
                  </span>
                )}
                {r.role === 'air' && <span className="text-accent-text uppercase">{t('tablet.playing')}</span>}
                {r.role === 'next' && <span className="text-muted uppercase">{t('tablet.next')}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
