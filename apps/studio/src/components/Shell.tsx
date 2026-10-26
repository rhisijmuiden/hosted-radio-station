import clsx from 'clsx';
import { ChevronsUpDown, Grid3x3, Headphones, LogOut, Mic, Radio, Settings, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEngine } from '../lib/engine';
import { api } from '../lib/api';
import { useAutoDj, useStatus } from '../lib/queries';
import { useSession } from '../lib/session';
import { duration } from '../lib/format';
import { InfoButton } from './InfoDialog';
import { RundownList } from './Rundown';
import { StereoMeter } from './Meter';
import { LanguageToggle, ThemeToggle } from './Toggles';
import { Avatar, Badge } from './ui';

export type Page = 'assist' | 'live' | 'carts' | 'settings';

const NAV: { page: Page; icon: LucideIcon }[] = [
  { page: 'assist', icon: Headphones },
  { page: 'live', icon: Mic },
  { page: 'carts', icon: Grid3x3 },
  { page: 'settings', icon: Settings },
];

function StationPicker() {
  const { t } = useTranslation();
  const { stations, station, chooseStation } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2 text-left hover:bg-hover"
        aria-expanded={open}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-nacht text-white dark:bg-koraal dark:text-nacht">
          <Radio className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold">{station?.name ?? t('station.none')}</span>
          <span className="block truncate text-[11px] text-muted">{station ? `${station.tenantName} · ${t(`edition.${station.edition}`)}` : t('station.noneText')}</span>
        </span>
        <ChevronsUpDown className="size-4 text-muted" />
      </button>
      {open && stations.length > 0 && (
        <div className="absolute top-full right-0 left-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-md border border-line bg-raised py-1 shadow-lg">
          {stations.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                chooseStation(s.id);
                setOpen(false);
              }}
              className={clsx('flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover', s.id === station?.id && 'bg-chip')}
            >
              <i className={clsx('size-2 shrink-0 rounded-full', s.onAir ? 'bg-online' : 'bg-line')} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{s.name}</span>
                <span className="block truncate text-[11px] text-muted">{s.tenantName}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Sidebar({ page, onPage }: { page: Page; onPage: (p: Page) => void }) {
  const { t } = useTranslation();
  const { me, signOut } = useSession();
  const broadcast = useEngine((s) => s.broadcast.state);
  const user = me ? me.user : null;
  const role = me ? (me.user.isSuperadmin ? t('roles.superadmin') : me.memberships[0] ? t(`roles.${me.memberships[0].role}`) : '') : '';
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-raised px-3.5 pt-5 pb-4">
      <div className="flex items-center gap-2.5 px-2 pb-5">
        <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-[26px] dark:hidden" />
        <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-[26px] dark:block" />
        <span className="border-l border-line pl-2.5 text-[11px] leading-tight text-muted">
          Studio
          <br />
          {t('app.tagline')}
        </span>
      </div>
      <StationPicker />
      <nav className="mt-4 flex flex-col gap-0.5">
        {NAV.map(({ page: p, icon: Icon }) => (
          <button
            key={p}
            onClick={() => onPage(p)}
            className={clsx(
              'group flex items-center gap-3 rounded-md px-2.5 py-2 text-left font-medium transition-colors',
              page === p ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'text-ink hover:bg-hover',
            )}
          >
            <Icon className={clsx('size-[18px]', page === p ? 'text-koraal' : 'text-muted')} strokeWidth={1.8} />
            <span className="flex-1">{t(`nav.${p}`)}</span>
            {p === 'live' && broadcast === 'live' && <Badge tone="accent" dot>{t('live.onAirShort')}</Badge>}
            {p === 'carts' && <kbd className="text-[10px] text-muted">F1–F12</kbd>}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col">
        <RundownList />
      </div>
      <div className="mt-3 border-t border-line pt-3">
        {user && (
          <div className="flex items-center gap-2.5 px-2 py-2">
            <Avatar name={user.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold">{user.name}</span>
              <span className="block truncate text-xs text-muted">{role}</span>
            </span>
            <button onClick={() => confirm(t('signIn.signOutConfirm')) && void signOut()} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink" title={t('signIn.signOut')}>
              <LogOut className="size-4" />
            </button>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 px-2 pt-3">
          <InfoButton />
          <ThemeToggle />
        </div>
        <div className="flex items-center justify-between gap-2 px-2 pt-3.5">
          <span className="flex items-center gap-2 text-[11px] text-muted">
            Powered by
            <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-3.5 dark:hidden" />
            <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-3.5 dark:block" />
          </span>
          <LanguageToggle />
        </div>
      </div>
    </aside>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 250);
    return () => clearInterval(id);
  }, []);
  return <div className="display text-[26px] leading-none tabular">{now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>;
}

/** On air, now playing, listeners and the clock: always in view. */
function TopBar() {
  const { t, i18n } = useTranslation();
  const { station } = useSession();
  const status = useStatus(station?.id);
  const autodj = useAutoDj(station?.id);
  const broadcast = useEngine((s) => s.broadcast);
  const live = status.data?.live[0];
  const np = autodj.data?.nowPlaying;
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = np?.startedAt ? (Date.now() - new Date(np.startedAt).getTime()) / 1000 : 0;
  const remaining = np?.media.durationSeconds ? np.media.durationSeconds - elapsed : null;
  const meLive = broadcast.state === 'live';
  return (
    <header className="flex items-center gap-5 border-b border-line bg-raised px-6 py-3.5">
      <div
        className={clsx(
          'flex h-11 shrink-0 items-center gap-2 rounded-md px-4 text-sm font-extrabold tracking-[0.12em] uppercase',
          meLive ? 'onair-pulse bg-koraal text-nacht' : live ? 'bg-offline/15 text-offline' : 'bg-chip text-muted',
        )}
      >
        <i className={clsx('size-2.5 rounded-full', meLive ? 'bg-nacht' : live ? 'bg-offline' : 'bg-muted/50')} />
        {meLive ? t('live.onAir') : live ? t('live.someoneLive') : t('live.autodj')}
      </div>
      <div className="min-w-0 flex-1">
        {live && !meLive ? (
          <>
            <div className="truncate text-[15px] font-bold">{t('live.liveBy', { name: live.accountName })}</div>
            <div className="truncate text-xs text-muted">{status.data?.mounts.find((m) => m.live)?.title ?? live.mountPath}</div>
          </>
        ) : np ? (
          <>
            <div className="truncate text-[15px] font-bold">{np.media.title || np.media.path}</div>
            <div className="truncate text-xs text-muted">
              {np.media.artist} {remaining != null && <span className="tabular">· {t('assist.remaining', { time: duration(remaining) })}</span>}
            </div>
          </>
        ) : (
          <div className="truncate text-[13px] text-muted">{status.data?.mounts.find((m) => m.live)?.title ?? (station ? t('assist.nothing') : '')}</div>
        )}
      </div>
      <div className="text-right">
        <div className="display text-[22px] leading-none tabular">{status.data?.listeners ?? '–'}</div>
        <div className="text-[11px] text-muted">{t('assist.listeners')}</div>
      </div>
      <div className="border-l border-line pl-5 text-right">
        <Clock />
        <div className="text-[11px] text-muted">{new Date().toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      </div>
    </header>
  );
}

/** The level of the stream this PC sends, at the right edge of every screen, rising from the bottom. */
function MeterColumn() {
  const { t } = useTranslation();
  return (
    <aside aria-label={t('meters.stream')} className="flex w-[76px] shrink-0 flex-col items-center border-l border-line bg-raised px-2 pt-5 pb-4">
      <StereoMeter source="output" label={t('meters.stream')} vertical scale className="min-h-0 flex-1" />
    </aside>
  );
}

/**
 * Manual playout stays on only while a studio PC keeps saying so: every 10 seconds while the server reports it on.
 * When this PC closes or loses its connection, the server goes back to Auto by itself after 30 seconds.
 */
function PlayoutKeepAlive() {
  const { station, supports } = useSession();
  const autodj = useAutoDj(station?.edition === 'station' ? station.id : undefined);
  const manual = !!autodj.data?.playout?.manual;
  const id = station?.id;
  const can = supports('playout');
  useEffect(() => {
    if (!manual || !id || !can) return;
    const renew = () => void api(`/stations/${id}/autodj/mode`, { method: 'POST', body: { manual: true } }).catch(() => undefined);
    const timer = setInterval(renew, 10_000);
    return () => clearInterval(timer);
  }, [manual, id, can]);
  return null;
}

export function Shell({ page, onPage, children }: { page: Page; onPage: (p: Page) => void; children: ReactNode }) {
  return (
    <div className="flex h-full">
      <Sidebar page={page} onPage={onPage} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</main>
      </div>
      <MeterColumn />
      <PlayoutKeepAlive />
    </div>
  );
}
