import clsx from 'clsx';
import { Activity, ArrowLeft, BarChart3, BookOpen, Building2, ChevronDown, ChevronUp, Cloud, DatabaseBackup, FileText, Globe, KeyRound, Landmark, LayoutDashboard, LogOut, Mail, Menu, MonitorSmartphone, Network, Package, Radio, RadioTower, Receipt, RefreshCw, ScrollText, Search, Server, Tag, UserRound, Users, Webhook, type LucideIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useLocation, useMatch, useSearchParams } from 'react-router';
import { api, type AlertSummary, type NodeRegistration, type StationDetail, type StationStatus } from '../lib/api';
import { isAdmin, useLogout, useMe } from '../lib/auth';
import { InfoButton, useSystemInfo } from './InfoDialog';
import { LanguageToggle, ThemeToggle } from './toggles';
import { CustomerShell } from './topbar/CustomerShell';
import { QuickSearch } from './QuickSearch';
import { usePendingRequests } from './station/Requests';
import { stationMenu, stationTabHref, stationTabs, type StationTab } from './station/menu';
import { Avatar } from './ui';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  external?: boolean;
  /** A count that needs attention, such as nodes waiting for approval. */
  badge?: number;
  /** A quiet badge: something is ready, nothing is wrong. */
  soft?: boolean;
}

function NavItemLink({ item, onNavigate, active }: { item: NavItem; onNavigate: () => void; active: boolean }) {
  const Icon = item.icon;
  const base = 'group flex items-center gap-3 rounded-md px-2.5 py-2 font-medium transition-colors';
  if (item.external) {
    return (
      <a href={item.to} target="_blank" rel="noreferrer" className={clsx(base, 'text-ink hover:bg-hover')}>
        <Icon className="size-[18px] text-muted" strokeWidth={1.8} />
        {item.label}
      </a>
    );
  }
  return (
    <Link to={item.to} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={clsx(base, active ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'text-ink hover:bg-hover')}>
      <Icon className={clsx('size-[18px] shrink-0', active ? 'text-koraal' : 'text-muted')} strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {!!item.badge && (
        <span className={clsx('grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10.5px] font-bold', item.soft ? 'bg-chip text-accent-text' : 'bg-koraal text-nacht')}>
          {item.badge}
        </span>
      )}
    </Link>
  );
}

function UserMenu() {
  const me = useMe().data!;
  const { t } = useTranslation();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  const role = me.user.isSuperadmin ? t('roles.superadmin') : me.memberships[0] ? t(`roles.${me.memberships[0].role}`) : t('roles.user');
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-hover" aria-expanded={open}>
        <Avatar name={me.user.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold">{me.user.name}</span>
          <span className="block truncate text-xs text-muted">{role}</span>
        </span>
        <ChevronUp className={clsx('size-4 text-muted transition-transform', !open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute right-0 bottom-full left-0 mb-1 overflow-hidden rounded-md border border-line bg-raised py-1 shadow-lg">
          <NavLink to="/profile" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 hover:bg-hover">
            <UserRound className="size-4 text-muted" /> {t('nav.profile')}
          </NavLink>
          <button onClick={() => void logout()} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover">
            <LogOut className="size-4 text-muted" /> {t('auth.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}

interface NavGroup {
  key: string;
  title: string;
  items: NavItem[];
}

const CLOSED_KEY = 'hrs-nav-closed';
function readClosed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Which menu groups the user folded in, remembered in this browser. */
function useClosedGroups() {
  const [closed, setClosed] = useState(readClosed);
  const toggle = (key: string) =>
    setClosed((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
      } catch {
        /* private window: keep it for this visit only */
      }
      return next;
    });
  return { closed, toggle };
}

function GroupHeader({ title, open, onToggle }: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-1.5 rounded-md px-2.5 pt-4 pb-1.5 text-left text-[11px] tracking-[0.08em] text-muted uppercase hover:text-ink">
      <ChevronDown className={clsx('size-3 transition-transform motion-reduce:transition-none', !open && '-rotate-90')} strokeWidth={2.4} />
      {title}
    </button>
  );
}

function NavGroups({ groups, isActive, onNavigate, scope }: { groups: NavGroup[]; isActive: (item: NavItem) => boolean; onNavigate: () => void; scope: string }) {
  const { closed, toggle } = useClosedGroups();
  return (
    <>
      {groups.map((g) => {
        const key = `${scope}:${g.key}`;
        // The group of the page you are on always stays open.
        const open = !g.title || !closed.has(key) || g.items.some(isActive);
        return (
          <div key={g.key} className="flex flex-col gap-0.5">
            {g.title && <GroupHeader title={g.title} open={open} onToggle={() => toggle(key)} />}
            {open && g.items.map((item) => <NavItemLink key={item.to} item={item} onNavigate={onNavigate} active={isActive(item)} />)}
          </div>
        );
      })}
    </>
  );
}

/** The admin menu (phase 19) in five groups. Customers use the top menu (topbar/menu.ts). */
function useMainMenu(): NavGroup[] {
  const me = useMe().data!;
  const { t } = useTranslation();
  const admin = isAdmin(me);
  const pending = useQuery({ queryKey: ['nodes', 'pending'], queryFn: () => api<NodeRegistration[]>('/nodes/pending'), enabled: admin, refetchInterval: 30_000 });
  const alerts = useQuery({ queryKey: ['alerts', 'summary'], queryFn: () => api<AlertSummary>('/alerts/summary'), enabled: admin, refetchInterval: 30_000 });
  const info = useSystemInfo();
  const updateReady = admin && !!info.data?.lastCheck?.updateAvailable;

  if (!admin) return [];
  return [
      {
        key: 'radio',
        title: t('nav.groups.radio'),
        items: [
          { to: '/', label: t('nav.dashboard'), icon: LayoutDashboard },
          { to: '/stations', label: t('nav.stations'), icon: Radio },
          { to: '/customers', label: t('nav.customers'), icon: Building2 },
          { to: '/statistics', label: t('nav.statistics'), icon: BarChart3 },
          { to: '/studio', label: t('nav.studio'), icon: MonitorSmartphone },
        ],
      },
      {
        key: 'network',
        title: t('nav.groups.network'),
        items: [
          { to: '/nodes', label: t('nav.nodes'), icon: Server, badge: pending.data?.length || undefined },
          { to: '/topology', label: t('nav.topology'), icon: Network },
          { to: '/monitoring', label: t('nav.monitoring'), icon: Activity, badge: alerts.data?.open || undefined, soft: !alerts.data?.critical },
          { to: '/nodes/names', label: t('nav.serverNames'), icon: Tag },
          { to: '/settings/dns', label: t('nav.dns'), icon: Cloud },
          { to: '/settings/streaming', label: t('nav.streamingDefaults'), icon: RadioTower },
        ],
      },
      {
        key: 'billing',
        title: t('nav.groups.billing'),
        items: [
          { to: '/billing', label: t('nav.billingOverview'), icon: Receipt },
          { to: '/billing/packages', label: t('nav.packages'), icon: Package },
          { to: '/billing/invoices', label: t('nav.invoices'), icon: FileText },
          { to: '/settings/billing', label: t('nav.billingSettings'), icon: Landmark },
        ],
      },
      {
        key: 'settings',
        title: t('nav.groups.settings'),
        items: [
          { to: '/settings/mail', label: t('nav.mail'), icon: Mail },
          { to: '/settings/web-server', label: t('nav.webServer'), icon: Globe },
          { to: '/settings/statistics', label: t('nav.statisticsSettings'), icon: BarChart3 },
          { to: '/settings/webhooks', label: t('nav.webhooks'), icon: Webhook },
        ],
      },
      {
        key: 'system',
        title: t('nav.groups.system'),
        items: [
          { to: '/users', label: t('nav.users'), icon: Users },
          { to: '/api-keys', label: t('nav.apiKeys'), icon: KeyRound },
          { to: '/settings/backups', label: t('nav.backups'), icon: DatabaseBackup },
          { to: '/settings/updates', label: t('nav.updates'), icon: RefreshCw, badge: updateReady ? 1 : undefined, soft: true },
          { to: '/audit', label: t('nav.auditLog'), icon: ScrollText },
          { to: '/api/docs', label: t('nav.apiDocs'), icon: BookOpen, external: true },
        ],
      },
    ];
}

/** Inside a station the sidebar becomes that station's menu, with a way back to all stations (phase 19). */
function StationMenu({ id, onNavigate }: { id: string; onNavigate: () => void }) {
  const { t } = useTranslation();
  const me = useMe().data!;
  const [params] = useSearchParams();
  const station = useQuery({ queryKey: ['station', id], queryFn: () => api<StationDetail>(`/stations/${id}`) });
  const requests = usePendingRequests(id);
  const status = useQuery({ queryKey: ['station-status', id], queryFn: () => api<StationStatus>(`/stations/${id}/status`), refetchInterval: 5000 });
  const s = station.data;
  if (!s) return null;
  const groups = stationMenu(s, t, requests.data?.pending ?? 0);
  const items = stationTabs(groups);
  const requested = params.get('tab');
  const current = items.some((x) => x.value === requested) ? requested : 'overview';
  const onAir = !!status.data?.mounts.some((m) => m.live);
  const navGroups: NavGroup[] = groups.map((g) => ({
    key: g.key,
    title: g.title ?? '',
    items: g.items.map((i) => ({ to: stationTabHref(id, i.value), label: i.label, icon: i.icon, badge: i.badge })),
  }));
  return (
    <>
      <Link to="/stations" onClick={onNavigate} className="mb-1 flex items-center gap-1.5 px-2.5 py-1 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> {isAdmin(me) ? t('nav.allStations') : t('nav.myStations')}
      </Link>
      <div className="mb-1 flex items-center gap-2.5 border-b border-line px-2.5 pt-1 pb-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-chip text-accent-text">
          <Radio className="size-4" />
        </span>
        <span className="min-w-0">
          <b className="block truncate text-sm leading-tight">{s.name}</b>
          <span className={clsx('text-[11.5px] font-semibold', !s.enabled ? 'text-offline' : onAir ? 'text-online' : 'text-muted')}>
            {!s.enabled ? t('common.disabled') : onAir ? t('stations.onAir') : t('stations.offAir')}
          </span>
        </span>
      </div>
      <NavGroups groups={navGroups} scope="station" onNavigate={onNavigate} isActive={(item) => item.to === stationTabHref(id, current as StationTab)} />
    </>
  );
}

function Sidebar({ onNavigate, onSearch }: { onNavigate: () => void; onSearch: () => void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const groups = useMainMenu();
  const stationMatch = useMatch('/stations/:id');
  const stationId = stationMatch?.params.id;
  // The longest menu path that matches the address wins, so /nodes/names lights up Server names and not Nodes.
  const all = groups.flatMap((g) => g.items).filter((i) => !i.external);
  const best = all
    .filter((i) => (i.to === '/' ? location.pathname === '/' : location.pathname === i.to || location.pathname.startsWith(`${i.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0];

  return (
    <div className="flex h-full flex-col px-3.5 pt-5 pb-4">
      <div className="flex items-center gap-2.5 px-2 pb-4">
        <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-[26px] dark:hidden" />
        <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-[26px] dark:block" />
        <span className="border-l border-line pl-2.5 text-[11px] leading-tight text-muted">
          Hosted Radio
          <br />
          Station
        </span>
      </div>
      <button onClick={onSearch} className="mx-0.5 mb-2 flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-left text-[13px] text-muted hover:text-ink">
        <Search className="size-4" />
        <span className="flex-1 truncate">{t('search.placeholder')}</span>
        <kbd className="rounded border border-line px-1 font-sans text-[10.5px]">Ctrl K</kbd>
      </button>
      <nav className="flex min-h-0 flex-col overflow-y-auto">
        {stationId ? <StationMenu id={stationId} onNavigate={onNavigate} /> : <NavGroups groups={groups} scope="main" onNavigate={onNavigate} isActive={(item) => item === best} />}
      </nav>
      <div className="flex-1" />
      <div className="border-t border-line pt-3">
        <UserMenu />
        <div className="flex items-center justify-between gap-2 px-2 pt-3">
          <InfoButton />
          <ThemeToggle />
        </div>
        <div className="flex items-center justify-between gap-2 px-2 pt-3.5">
          <a href="https://rhis.nl" target="_blank" rel="noreferrer" className="flex items-center gap-2 text-[11px] text-muted hover:text-ink">
            Powered by
            <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-3.5 dark:hidden" />
            <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-3.5 dark:block" />
          </a>
          <LanguageToggle />
        </div>
      </div>
    </div>
  );
}

/** Administrators keep the left menu; customers get the top menu with drop-downs (customer navigation, option A). */
export function Layout() {
  const me = useMe().data!;
  return isAdmin(me) ? <AdminLayout /> : <CustomerShell />;
}

function AdminLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const menu = useMainMenu();
  const location = useLocation();
  const { t, i18n } = useTranslation();
  const me = useMe().data!;
  useEffect(() => setMobileOpen(false), [location.pathname]);
  // Ctrl+K (or Cmd+K) opens the quick search anywhere in the panel.
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
  const openSearch = () => {
    setMobileOpen(false);
    setSearchOpen(true);
  };
  // The language saved on the account wins over the browser language, once per sign-in.
  useEffect(() => {
    if (me.user.locale !== i18n.language) void i18n.changeLanguage(me.user.locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.user.id]);

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-raised lg:block">
        <Sidebar onNavigate={() => {}} onSearch={openSearch} />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-[var(--overlay)]" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-raised shadow-2xl">
            <Sidebar onNavigate={() => setMobileOpen(false)} onSearch={openSearch} />
          </aside>
        </div>
      )}

      <QuickSearch open={searchOpen} onClose={() => setSearchOpen(false)} pages={menu.flatMap((g) => g.items)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line bg-raised px-4 py-3 lg:hidden">
          <button onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 hover:bg-hover" aria-label={t('nav.openMenu')}>
            <Menu className="size-5" />
          </button>
          <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-5 dark:hidden" />
          <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-5 dark:block" />
          <button onClick={openSearch} className="ml-auto rounded-md p-1.5 hover:bg-hover" aria-label={t('search.open')}>
            <Search className="size-5" />
          </button>
        </div>
        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-9 sm:py-7">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
