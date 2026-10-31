import clsx from 'clsx';
import { ChevronDown, Lock, LogOut, Menu, Plus, Radio, Search, Sparkles, UserRound, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation, useMatch, useNavigate } from 'react-router';
import { api, type NodeItem, type StationDetail, type StationListItem, type Tenant } from '../../lib/api';
import { useLogout, useMe } from '../../lib/auth';
import { CreateStationDialog, useCreatableTenants } from '../../pages/Stations';
import { InfoButton } from '../InfoDialog';
import { QuickSearch } from '../QuickSearch';
import { usePendingRequests } from '../station/Requests';
import { stationTabHref } from '../station/menu';
import { LanguageToggle, ThemeToggle } from '../toggles';
import { Avatar } from '../ui';
import { activeIn, topMenu, type TopEntry, type TopItem, type TopKey } from './menu';

const CURRENT_KEY = 'hrs-current-station';
function readCurrent(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}
function writeCurrent(id: string) {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    /* private window: the station page in the address still decides */
  }
}

/**
 * The station the top menu works on: the one in the address, else the last one picked in this browser, else the
 * first station the user may see.
 */
function useCurrentStation() {
  const match = useMatch('/stations/:id');
  const stations = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations'), refetchInterval: 30_000 });
  const [picked, setPicked] = useState<string | null>(readCurrent);
  const fromUrl = match?.params.id;
  useEffect(() => {
    if (fromUrl && fromUrl !== picked) {
      setPicked(fromUrl);
      writeCurrent(fromUrl);
    }
  }, [fromUrl, picked]);
  const list = stations.data ?? [];
  const id = fromUrl ?? (list.some((s) => s.id === picked) ? picked : (list[0]?.id ?? null));
  const detail = useQuery({ queryKey: ['station', id], queryFn: () => api<StationDetail>(`/stations/${id}`), enabled: !!id });
  const pick = (next: string) => {
    setPicked(next);
    writeCurrent(next);
  };
  return { id, list, loaded: stations.isSuccess, station: detail.data ?? null, pick };
}

/** Closes a pop-up on a click outside it or on Escape. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, ref]);
}

function placeLabel(s: StationListItem, nodes: NodeItem[], t: (k: string, o?: Record<string, unknown>) => string) {
  if (s.edition === 'distribution' && !s.nodeId) return t('topnav.switcher.viaIngest');
  const node = s.nodeId ? nodes.find((n) => n.id === s.nodeId) : null;
  if (node && node.tenantId === s.tenantId) return t('topnav.switcher.onOwn', { name: node.name });
  return t('topnav.switcher.onShared');
}

function StationSwitcher({ current, compact, onDone }: { current: ReturnType<typeof useCurrentStation>; compact?: boolean; onDone?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const me = useMe().data!;
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants') });
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<NodeItem[]>('/nodes'), enabled: open });
  const creatable = useCreatableTenants();
  const multi = me.memberships.length > 1;
  const s = current.list.find((x) => x.id === current.id) ?? null;

  // How much of the licence the customer of the current station uses: stations, and of those Radio stations.
  const tenant = tenants.data?.find((x) => x.id === (s?.tenantId ?? creatable[0]?.id));
  const ofTenant = current.list.filter((x) => x.tenantId === tenant?.id);
  const usage = tenant
    ? t('topnav.switcher.usage', {
        used: ofTenant.length,
        max: tenant.limits.maxStations,
        radio: ofTenant.filter((x) => x.edition === 'station').length,
        maxRadio: tenant.limits.maxRadioStations,
      })
    : null;
  const room = creatable.some((x) => current.list.filter((y) => y.tenantId === x.id).length < x.limits.maxStations);
  const shown = current.list.filter((x) => !q || `${x.name} ${x.tenantName}`.toLowerCase().includes(q.toLowerCase()));

  const choose = (id: string) => {
    current.pick(id);
    setOpen(false);
    onDone?.();
    // On a station page, stay on the same page of the newly picked station.
    if (location.pathname.startsWith('/stations/')) navigate(`/stations/${id}${location.search.replace(/[?&]focus=[^&]*/, '')}`);
  };

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={clsx('flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-line bg-raised py-1.5 pr-2.5 pl-1.5 text-left transition-colors hover:bg-hover', !compact && 'max-w-[240px]')}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-chip text-accent-text">
          <Radio className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[13.5px] leading-tight">{s?.name ?? (current.loaded ? t('topnav.switcher.none') : '…')}</b>
          <span className="block truncate text-[11.5px] text-muted">{s ? t(`stations.edition.${s.edition}`) : t('topnav.switcher.allStations')}</span>
        </span>
        <ChevronDown className={clsx('size-4 shrink-0 text-muted transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
      </button>
      {open && (
        <div className={clsx('absolute top-full left-0 z-50 mt-2 overflow-hidden rounded-xl border border-line bg-raised shadow-[var(--shadow-pop)]', compact ? 'w-full min-w-[280px]' : 'w-[380px]')}>
          <div className="flex items-center justify-between gap-2 px-3.5 pt-3 pb-1.5 text-[11px] tracking-[0.08em] text-muted uppercase">
            <Link to="/stations" onClick={() => (setOpen(false), onDone?.())} className="font-semibold hover:text-ink">
              {t('topnav.switcher.allStations')}
            </Link>
            {usage && <span className="truncate normal-case tracking-normal">{usage}</span>}
          </div>
          {current.list.length > 7 && (
            <div className="px-2.5 pb-1.5">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('topnav.switcher.find')}
                className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-koraal"
              />
            </div>
          )}
          <div role="listbox" className="max-h-[360px] overflow-y-auto px-1.5 pb-1.5">
            {shown.map((x) => (
              <button
                key={x.id}
                role="option"
                aria-selected={x.id === current.id}
                onClick={() => choose(x.id)}
                className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-hover', x.id === current.id && 'bg-[var(--top-active-bg)]')}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-chip text-accent-text">
                  <Radio className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[13.5px] leading-tight">{x.name}</b>
                  <span className="block truncate text-[11.5px] text-muted">
                    {t(`stations.edition.${x.edition}`)} · {nodes.data ? placeLabel(x, nodes.data, t) : '…'}
                    {multi ? ` · ${x.tenantName}` : ''}
                  </span>
                </span>
                {!x.enabled ? (
                  <span className="shrink-0 rounded-full bg-offline/10 px-2 py-0.5 text-[11px] font-semibold text-offline">{t('common.disabled')}</span>
                ) : x.onAir ? (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-online/10 px-2 py-0.5 text-[11px] font-semibold text-online">
                    <i className="size-1.5 rounded-full bg-online" /> {t('stations.onAir')}
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">{t('stations.offAir')}</span>
                )}
              </button>
            ))}
            {!shown.length && <p className="px-2 py-3 text-[13px] text-muted">{current.list.length ? t('topnav.switcher.noMatch') : t('topnav.switcher.empty')}</p>}
          </div>
          {creatable.length > 0 && (
            <div className="border-t border-line p-2">
              <button
                disabled={!room}
                onClick={() => (setOpen(false), setCreating(true))}
                title={room ? undefined : t('topnav.switcher.full')}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-semibold hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="size-4" /> {t('topnav.switcher.new')}
                {!room && <span className="ml-auto text-[11.5px] font-normal text-muted">{t('topnav.switcher.full')}</span>}
              </button>
            </div>
          )}
        </div>
      )}
      <CreateStationDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function ItemRow({ item, active, onNavigate }: { item: TopItem; active: boolean; onNavigate: () => void }) {
  const { t } = useTranslation();
  const Icon = item.locked ? Lock : item.icon;
  const body = (
    <>
      <Icon className={clsx('mt-0.5 size-[18px] shrink-0', active ? 'text-koraal' : 'text-muted')} strokeWidth={1.8} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13.5px] font-semibold">
          {item.label}
          {!!item.badge && <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-koraal px-1 text-[10px] font-bold text-nacht">{item.badge}</span>}
        </span>
        <span className="block text-[12px] leading-snug text-muted">{item.locked ? t('topnav.lockedHint') : item.hint}</span>
      </span>
    </>
  );
  if (item.locked)
    return (
      <div className="flex cursor-not-allowed gap-2.5 rounded-lg px-2.5 py-2 opacity-60" aria-disabled="true">
        {body}
      </div>
    );
  return (
    <Link to={item.to} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={clsx('flex gap-2.5 rounded-lg px-2.5 py-2 transition-colors', active ? 'bg-[var(--top-active-bg)]' : 'hover:bg-hover')}>
      {body}
    </Link>
  );
}

/** The bottom line of the Radio station menu: an upgrade for a Distribution station, otherwise a short explanation. */
function MegaFoot({ station, onNavigate }: { station: StationDetail; onNavigate: () => void }) {
  const { t } = useTranslation();
  const owner = station.role === 'owner' || station.role === 'superadmin';
  if (station.edition === 'distribution')
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 pt-3">
        <span className="flex items-center gap-2 text-[12.5px] text-muted">
          <Sparkles className="size-4 shrink-0 text-koraal" /> {owner ? t('topnav.upgradeHint') : t('topnav.upgradeAskOwner')}
        </span>
        {owner && (
          <Link to={stationTabHref(station.id, 'settings')} onClick={onNavigate} className="rounded-md bg-koraal px-3.5 py-1.5 text-[13px] font-bold text-nacht hover:brightness-95">
            {t('topnav.upgrade')}
          </Link>
        )}
      </div>
    );
  return <p className="border-t border-line px-3 pt-3 text-[12.5px] text-muted">{t('topnav.clockHelp')}</p>;
}

function DropDown({ entry, station, activeItem, onNavigate }: { entry: TopEntry; station: StationDetail | null; activeItem: string | null; onNavigate: () => void }) {
  if (entry.mega)
    return (
      <div className="absolute top-full right-4 left-4 z-40 mx-auto mt-1 max-w-[1000px] rounded-2xl border border-line bg-raised p-3 shadow-[var(--shadow-pop)]">
        <div className="grid gap-x-2 gap-y-3 pb-3" style={{ gridTemplateColumns: `repeat(${entry.groups.length}, minmax(0, 1fr))` }}>
          {entry.groups.map((g) => (
            <div key={g.key} className="min-w-0">
              {g.title && <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{g.title}</div>}
              {g.items.map((i) => (
                <ItemRow key={i.key} item={i} active={i.key === activeItem} onNavigate={onNavigate} />
              ))}
            </div>
          ))}
        </div>
        {station && <MegaFoot station={station} onNavigate={onNavigate} />}
      </div>
    );
  return (
    <div className="absolute top-full left-0 z-40 mt-2 w-[320px] rounded-xl border border-line bg-raised p-2 shadow-[var(--shadow-pop)]">
      {entry.groups.map((g) => (
        <div key={g.key}>
          {g.title && <div className="truncate px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{g.title}</div>}
          {g.items.map((i) => (
            <ItemRow key={i.key} item={i} active={i.key === activeItem} onNavigate={onNavigate} />
          ))}
        </div>
      ))}
    </div>
  );
}

function TopNav({ entries, active, station }: { entries: TopEntry[]; active: { top: TopKey | null; item: string | null }; station: StationDetail | null }) {
  const [open, setOpen] = useState<TopKey | null>(null);
  const ref = useRef<HTMLElement>(null);
  const location = useLocation();
  useDismiss(!!open, () => setOpen(null), ref);
  useEffect(() => setOpen(null), [location.pathname, location.search]);
  const openEntry = entries.find((e) => e.key === open);
  return (
    <nav ref={ref} className="flex min-w-0 items-center gap-0.5" aria-label="Main">
      {entries.map((e) => {
        const on = active.top === e.key;
        const cls = clsx(
          'relative flex items-center gap-1 rounded-md px-2.5 py-2 text-[14px] font-semibold whitespace-nowrap transition-colors',
          on || open === e.key ? 'bg-[var(--top-active-bg)] text-accent-text' : 'text-ink hover:bg-hover',
        );
        const bar = on && <span className="absolute inset-x-2.5 -bottom-[13px] h-[3px] rounded-full bg-koraal" />;
        if (e.to)
          return (
            <Link key={e.key} to={e.to} className={cls} aria-current={on ? 'page' : undefined}>
              {e.label}
              {bar}
            </Link>
          );
        return (
          <div key={e.key} className={clsx(!e.mega && 'relative')}>
            <button
              className={cls}
              aria-expanded={open === e.key}
              aria-haspopup="menu"
              onClick={() => setOpen((o) => (o === e.key ? null : e.key))}
              onMouseEnter={() => open && open !== e.key && setOpen(e.key)}
            >
              {e.label}
              <ChevronDown className={clsx('size-3.5 text-muted transition-transform motion-reduce:transition-none', open === e.key && 'rotate-180')} strokeWidth={2.4} />
              {bar}
            </button>
            {open === e.key && !e.mega && <DropDown entry={e} station={station} activeItem={active.item} onNavigate={() => setOpen(null)} />}
          </div>
        );
      })}
      {openEntry?.mega && <DropDown entry={openEntry} station={station} activeItem={active.item} onNavigate={() => setOpen(null)} />}
    </nav>
  );
}

function AvatarMenu() {
  const me = useMe().data!;
  const { t } = useTranslation();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const role = me.memberships[0] ? t(`roles.${me.memberships[0].role}`) : t('roles.user');
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} title={me.user.name} className="rounded-full ring-2 ring-transparent transition hover:ring-koraal">
        <Avatar name={me.user.name} />
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 w-72 rounded-xl border border-line bg-raised py-1 shadow-[var(--shadow-pop)]">
          <div className="border-b border-line px-3.5 py-2.5">
            <b className="block truncate text-sm">{me.user.name}</b>
            <span className="block truncate text-xs text-muted">
              {me.user.email} · {role}
            </span>
          </div>
          <Link to="/profile" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3.5 py-2 text-sm hover:bg-hover">
            <UserRound className="size-4 text-muted" /> {t('nav.profile')}
          </Link>
          <button onClick={() => void logout()} className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm hover:bg-hover">
            <LogOut className="size-4 text-muted" /> {t('auth.signOut')}
          </button>
          {/* On narrower screens the top bar has no room for these; they live here instead. */}
          <div className="flex items-center justify-between gap-2 border-t border-line px-3.5 py-2.5 min-[1400px]:hidden">
            <ThemeToggle />
            <LanguageToggle />
          </div>
        </div>
      )}
    </div>
  );
}

function Brand() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2.5">
      <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-[26px] dark:hidden" />
      <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-[26px] dark:block" />
      <span className="hidden border-l border-line pl-2.5 text-[11px] leading-tight text-muted sm:block xl:hidden 2xl:block">
        Hosted Radio
        <br />
        Station
      </span>
    </Link>
  );
}

/** Below wide screens the top menu folds into a panel with the same sections, opened with the menu button. */
function MobileMenu({ entries, active, station, current, onClose }: { entries: TopEntry[]; active: { top: TopKey | null; item: string | null }; station: StationDetail | null; current: ReturnType<typeof useCurrentStation>; onClose: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<TopKey | null>(active.top);
  return (
    <div className="fixed inset-0 z-50 xl:hidden">
      <div className="absolute inset-0 bg-[var(--overlay)]" onClick={onClose} />
      <aside className="absolute inset-y-0 left-0 flex w-[340px] max-w-[90vw] flex-col border-r border-line bg-raised shadow-2xl">
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <Brand />
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-hover" aria-label={t('common.close')}>
            <X className="size-5" />
          </button>
        </div>
        <div className="px-3 pb-2">
          <StationSwitcher current={current} compact onDone={onClose} />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {entries.map((e) =>
            e.to ? (
              <Link key={e.key} to={e.to} onClick={onClose} className={clsx('mt-1 block rounded-md px-2.5 py-2 text-[14px] font-semibold', active.top === e.key && active.item === null ? 'bg-[var(--top-active-bg)] text-accent-text' : 'hover:bg-hover')}>
                {e.label}
              </Link>
            ) : (
              <div key={e.key} className="mt-1">
                <button onClick={() => setOpen((o) => (o === e.key ? null : e.key))} aria-expanded={open === e.key} className={clsx('flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[14px] font-semibold hover:bg-hover', active.top === e.key && 'text-accent-text')}>
                  {e.label}
                  <ChevronDown className={clsx('size-4 text-muted transition-transform motion-reduce:transition-none', open === e.key && 'rotate-180')} />
                </button>
                {open === e.key && (
                  <div className="pb-1 pl-1">
                    {e.groups.map((g) => (
                      <div key={g.key}>
                        {g.title && <div className="px-2.5 pt-2 pb-0.5 text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">{g.title}</div>}
                        {g.items.map((i) => (
                          <ItemRow key={i.key} item={i} active={i.key === active.item} onNavigate={onClose} />
                        ))}
                      </div>
                    ))}
                    {e.mega && station && (
                      <div className="pt-2">
                        <MegaFoot station={station} onNavigate={onClose} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            ),
          )}
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <InfoButton />
          <ThemeToggle />
          <LanguageToggle />
        </div>
      </aside>
    </div>
  );
}

/** The customer panel: a top bar with the station switcher and the menu with drop-downs, the page below it. */
export function CustomerShell() {
  const { t, i18n } = useTranslation();
  const me = useMe().data!;
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const current = useCurrentStation();
  const requests = usePendingRequests(current.id ?? '');
  const station = current.station && current.station.id === current.id ? current.station : null;
  const notDj = me.memberships.some((m) => m.role !== 'dj');

  const entries = useMemo(
    () =>
      topMenu(
        {
          station,
          notDj,
          billed: me.memberships.some((m) => m.billed && m.role !== 'dj'),
          multiCustomer: me.memberships.length > 1,
          stationCount: current.list.length,
          pendingRequests: requests.data?.pending ?? 0,
        },
        t,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [station, notDj, me, current.list.length, requests.data?.pending, t, i18n.language],
  );
  const active = activeIn(entries, location.pathname, location.search);

  useEffect(() => setMobileOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // The language saved on the account wins over the browser language, once per sign-in.
  useEffect(() => {
    if (me.user.locale !== i18n.language) void i18n.changeLanguage(me.user.locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.user.id]);

  const pages = entries.flatMap((e) => [...(e.to ? [{ to: e.to, label: e.label, icon: Radio }] : []), ...e.groups.flatMap((g) => g.items.filter((i) => !i.locked).map((i) => ({ to: i.to, label: i.label, icon: i.icon })))]);

  return (
    <div className="flex h-full flex-col">
      <header className="relative z-30 border-b border-line bg-raised">
        <div className="flex h-[62px] items-center gap-3 px-4 xl:gap-5 xl:px-5">
          <button onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 hover:bg-hover xl:hidden" aria-label={t('nav.openMenu')}>
            <Menu className="size-5" />
          </button>
          <Brand />
          <div className="hidden min-w-0 sm:block xl:w-[230px]">
            <StationSwitcher current={current} />
          </div>
          <div className="hidden min-w-0 flex-1 xl:block">
            <TopNav entries={entries} active={active} station={station} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button onClick={() => setSearchOpen(true)} className="grid size-9 place-items-center rounded-lg border border-line hover:bg-hover" aria-label={t('search.open')} title={`${t('search.open')} (Ctrl K)`}>
              <Search className="size-4" />
            </button>
            <div className="hidden sm:block">
              <InfoButton />
            </div>
            <div className="hidden items-center gap-2 min-[1400px]:flex">
              <ThemeToggle />
              <LanguageToggle />
            </div>
            <AvatarMenu />
          </div>
        </div>
      </header>

      {mobileOpen && <MobileMenu entries={entries} active={active} station={station} current={current} onClose={() => setMobileOpen(false)} />}
      <QuickSearch open={searchOpen} onClose={() => setSearchOpen(false)} pages={pages} />

      <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-9 sm:py-7">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
