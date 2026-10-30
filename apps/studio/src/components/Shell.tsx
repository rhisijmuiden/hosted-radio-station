import clsx from 'clsx';
import { ChevronsUpDown, Clock3, Disc3, Grid3x3, Headphones, Lock, LogOut, Mic, Radio, Settings, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEngine } from '../lib/engine';
import { api } from '../lib/api';
import { duration } from '../lib/format';
import { useNow } from '../lib/now';
import { useAutoDj, useRundown, useStatus } from '../lib/queries';
import { useSession } from '../lib/session';
import { useSettings } from '../lib/settings';
import { blocksOf } from '../lib/timeline';
import { liveTarget } from '../pages/Live';
import { InfoButton } from './InfoDialog';
import { LayoutMenu } from './LayoutMenu';
import { StereoMeter } from './Meter';
import { LanguageToggle, ThemeToggle } from './Toggles';
import { Avatar } from './ui';

export type Page = 'assist' | 'live' | 'carts' | 'recordings' | 'settings';

const NAV: { page: Page; icon: LucideIcon }[] = [
  { page: 'assist', icon: Headphones },
  { page: 'live', icon: Mic },
  { page: 'carts', icon: Grid3x3 },
  { page: 'recordings', icon: Disc3 },
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

/** The narrow menu on the left: the pages as icons with a short label, and the signed-in DJ at the bottom. */
function NavRail({ page, onPage }: { page: Page; onPage: (p: Page) => void }) {
  const { t } = useTranslation();
  const { me, signOut, supports } = useSession();
  const broadcast = useEngine((s) => s.broadcast.state);
  const user = me ? me.user : null;
  const role = me ? (me.user.isSuperadmin ? t('roles.superadmin') : me.memberships[0] ? t(`roles.${me.memberships[0].role}`) : '') : '';
  return (
    <aside className="flex w-[84px] shrink-0 flex-col items-center border-r border-line bg-raised pt-4 pb-3">
      <img src="/brand/rhis-icon.svg" alt="RHIS Studio" className="size-9 dark:hidden" />
      <img src="/brand/rhis-icon-koraal.svg" alt="RHIS Studio" className="hidden size-9 dark:block" />
      <nav className="mt-5 flex w-full flex-col items-center gap-1 px-2">
        {NAV.filter((n) => n.page !== 'recordings' || supports('recordings')).map(({ page: p, icon: Icon }) => (
          <button
            key={p}
            onClick={() => onPage(p)}
            aria-current={page === p ? 'page' : undefined}
            title={p === 'carts' ? `${t(`nav.${p}`)} (F1–F12)` : t(`nav.${p}`)}
            className={clsx(
              'relative flex w-full flex-col items-center gap-1 rounded-md px-1 py-2 text-[10px] font-semibold transition-colors',
              page === p ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'text-muted hover:bg-hover hover:text-ink',
            )}
          >
            <Icon className={clsx('size-5', page === p && 'text-koraal')} strokeWidth={1.8} />
            <span className="max-w-full truncate">{t(`navShort.${p}`)}</span>
            {p === 'live' && broadcast === 'live' && <i className="onair-pulse absolute top-1.5 right-2.5 size-2 rounded-full bg-onair" aria-label={t('live.onAirShort')} />}
          </button>
        ))}
      </nav>
      <div className="flex-1" />
      {user && (
        <button
          onClick={() => confirm(t('signIn.signOutConfirm')) && void signOut()}
          title={`${user.name}${role ? ` · ${role}` : ''}\n${t('signIn.signOut')}`}
          className="group relative rounded-full"
        >
          <Avatar name={user.name} />
          <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-raised text-muted ring-1 ring-line group-hover:text-ink">
            <LogOut className="size-2.5" />
          </span>
        </button>
      )}
    </aside>
  );
}

function Clock() {
  const { i18n } = useTranslation();
  const now = useNow(250);
  return (
    <div className="text-right">
      <div className="display text-[26px] leading-none tabular">{new Date(now).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
      <div className="mt-0.5 text-[11px] text-muted">{new Date(now).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
    </div>
  );
}

/** The next fixed block of the format (news, commercials) and the time until it: what a DJ checks most. */
function NextBlock() {
  const { t } = useTranslation();
  const { station, supports } = useSession();
  const enabled = !!station && station.edition === 'station' && supports('rundown');
  const rundown = useRundown(station?.id, enabled);
  const now = useNow(1000);
  if (!enabled || !rundown.data?.enabled) return null;
  const block = blocksOf(rundown.data.rows, now).find((b) => b.at > now);
  if (!block) return null;
  const left = (block.at - now) / 1000;
  const label = block.items[0]?.label || t('rundown.fixed');
  // The PC's own time, like the clock next to it and the start times of the playlist.
  const at = new Date(block.at).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="border-l border-line pl-5" title={block.items.map((i) => i.label).filter(Boolean).join(' · ')}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-muted uppercase">
        {block.locked ? <Lock className="size-3" /> : <Clock3 className="size-3" />} {t('top.nextBlock')}
      </div>
      <div className="mt-1 flex items-baseline gap-2 whitespace-nowrap">
        <span className="max-w-[220px] truncate text-[15px] font-bold">{t('top.blockAt', { label, time: at })}</span>
        <span className={clsx('display text-[20px] leading-none tabular', left < 60 ? 'text-accent-text' : 'text-ink')}>{t('top.in', { time: duration(left) })}</span>
      </div>
    </div>
  );
}

/** The station, who is on air, the next fixed block, listeners and the clock: always in view. */
function TopBar({ page }: { page: Page }) {
  const { t } = useTranslation();
  const { station } = useSession();
  const status = useStatus(station?.id);
  const autodj = useAutoDj(station?.id);
  const broadcast = useEngine((s) => s.broadcast);
  const { me } = useSession();
  const live = status.data?.live[0];
  const meLive = broadcast.state === 'live';
  return (
    <header className="flex items-center gap-5 border-b border-line bg-raised px-5 py-3">
      <div className="w-60 shrink-0">
        <StationPicker />
      </div>
      {/* Who is on the station right now: a status, not a button. */}
      <div
        className={clsx(
          'flex h-10 shrink-0 cursor-default items-center gap-2 rounded-md px-4 text-sm font-extrabold tracking-[0.12em] uppercase',
          meLive ? 'onair-pulse bg-onair text-white' : live ? 'bg-offline/15 text-offline' : 'bg-chip text-muted',
        )}
        title={meLive ? t('live.tipYou') : live ? t('live.tipOther', { name: live.accountName }) : t('live.tipAutodj')}
      >
        <i className={clsx('size-2.5 rounded-full', meLive ? 'bg-white' : live ? 'bg-offline' : 'bg-muted/50')} />
        {meLive ? (me ? `${t('live.onAir')} · ${me.user.name.split(' ')[0]}` : t('live.onAir')) : live ? t('live.liveBy', { name: live.accountName }) : t('live.autodj')}
        {!meLive && !live && autodj.data?.playout && (
          <span className="font-semibold tracking-normal normal-case">· {autodj.data.playout.manual ? t('playout.manual') : t('playout.auto')}</span>
        )}
      </div>
      <NextBlock />
      <div className="flex-1" />
      {page === 'assist' && station?.edition === 'station' && <LayoutMenu />}
      <div className="text-right">
        <div className="display text-[22px] leading-none tabular">{status.data?.listeners ?? '–'}</div>
        <div className="text-[11px] text-muted">{t('assist.listeners')}</div>
      </div>
      <div className="border-l border-line pl-5">
        <Clock />
      </div>
    </header>
  );
}

/** Connection, server, quality and sound card at the bottom; version, theme and language on the right. */
function StatusBar() {
  const { t } = useTranslation();
  const broadcast = useEngine((s) => s.broadcast);
  const info = useEngine((s) => s.info);
  const settings = useSettings();
  const target = liveTarget();
  const server = (() => {
    try {
      return new URL(settings.server).host;
    } catch {
      return settings.server;
    }
  })();
  const state = broadcast.state;
  const tone = state === 'live' ? 'bg-online' : state === 'connecting' || state === 'reconnecting' ? 'bg-warning' : state === 'failed' ? 'bg-offline' : 'bg-line';
  return (
    <footer className="flex items-center gap-4 border-t border-line bg-raised px-4 py-1.5 text-[11px] text-muted">
      <span className="flex items-center gap-1.5 font-semibold text-ink">
        <i className={clsx('size-2 rounded-full', tone)} />
        {t(`status.${state}`)}
      </span>
      <span className="truncate tabular">
        {target && state !== 'off' ? `${target.host}:${target.port} · ${target.bitrate} kbps MP3${target.tls ? ' · TLS' : ''}` : server}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 truncate">
        <Mic className="size-3 shrink-0" />
        {info?.input ? `${info.input}${info.inputRate ? `, ${Math.round(info.inputRate / 1000)} kHz` : ''}` : t('status.noInput')}
      </span>
      <div className="flex-1" />
      <LanguageToggle />
      <ThemeToggle />
      <InfoButton />
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        Powered by
        <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-3 dark:hidden" />
        <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-3 dark:block" />
      </span>
    </footer>
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
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <NavRail page={page} onPage={onPage} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar page={page} />
          <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</main>
        </div>
        <MeterColumn />
      </div>
      <StatusBar />
      <PlayoutKeepAlive />
    </div>
  );
}
