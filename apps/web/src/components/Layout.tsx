import clsx from 'clsx';
import {
  BookOpen,
  Building2,
  ChevronUp,
  DatabaseBackup,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Moon,
  RefreshCw,
  ScrollText,
  Sun,
  UserRound,
  Users,
  Globe,
  Radio,
  RadioTower,
  type LucideIcon,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation } from 'react-router';
import type { Me } from '../lib/api';
import { isAdmin, useLogout, useMe } from '../lib/auth';
import { useThemeContext } from '../lib/theme-context';
import { setLanguage } from '../i18n';
import { InfoButton } from './InfoDialog';
import { Avatar } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  external?: boolean;
}

function NavItemLink({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
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
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      className={({ isActive }) => clsx(base, isActive ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'text-ink hover:bg-hover')}
    >
      {({ isActive }) => (
        <>
          <Icon className={clsx('size-[18px]', isActive ? 'text-koraal' : 'text-muted')} strokeWidth={1.8} />
          {item.label}
        </>
      )}
    </NavLink>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useThemeContext();
  const { t } = useTranslation();
  const options = [
    { value: 'light' as const, icon: Sun, label: t('theme.light') },
    { value: 'dark' as const, icon: Moon, label: t('theme.dark') },
  ];
  return (
    <div className="flex rounded-full border border-line p-0.5" role="radiogroup" aria-label={t('theme.label')}>
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          role="radio"
          aria-checked={theme === value}
          title={label}
          onClick={() => setTheme(value)}
          className={clsx('grid h-6 w-7 place-items-center rounded-full transition-colors', theme === value ? 'bg-[var(--nav-active-bg)]' : 'hover:bg-hover')}
        >
          <Icon className={clsx('size-3.5', theme === value ? 'text-koraal' : 'text-muted')} strokeWidth={2} />
        </button>
      ))}
    </div>
  );
}

function LanguageToggle() {
  const { i18n, t } = useTranslation();
  const qc = useQueryClient();
  const current = i18n.language.startsWith('nl') ? 'nl' : 'en';
  const choose = async (lng: 'en' | 'nl') => {
    await setLanguage(lng);
    qc.setQueryData<Me>(['me'], (old) => (old ? { ...old, user: { ...old.user, locale: lng } } : old));
  };
  return (
    <div className="flex rounded-full border border-line p-0.5 text-[11px] font-semibold" role="radiogroup" aria-label={t('language.label')}>
      {(['en', 'nl'] as const).map((lng) => (
        <button
          key={lng}
          role="radio"
          aria-checked={current === lng}
          onClick={() => void choose(lng)}
          className={clsx('h-6 rounded-full px-2 uppercase transition-colors', current === lng ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'text-muted hover:bg-hover')}
        >
          {lng}
        </button>
      ))}
    </div>
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

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const me = useMe().data!;
  const { t } = useTranslation();
  const admin = isAdmin(me);

  const main: NavItem[] = [
    { to: '/', label: t('nav.dashboard'), icon: LayoutDashboard },
    { to: '/stations', label: t('nav.stations'), icon: Radio },
    { to: '/customers', label: admin ? t('nav.customers') : t('nav.myCustomers'), icon: Building2 },
  ];
  const administration: NavItem[] = admin
    ? [
        { to: '/users', label: t('nav.users'), icon: Users },
        { to: '/api-keys', label: t('nav.apiKeys'), icon: KeyRound },
        { to: '/settings/mail', label: t('nav.mail'), icon: Mail },
        { to: '/settings/web-server', label: t('nav.webServer'), icon: Globe },
        { to: '/settings/streaming', label: t('nav.streaming'), icon: RadioTower },
        { to: '/settings/backups', label: t('nav.backups'), icon: DatabaseBackup },
        { to: '/audit', label: t('nav.auditLog'), icon: ScrollText },
        { to: '/settings/updates', label: t('nav.updates'), icon: RefreshCw },
        { to: '/api/docs', label: t('nav.apiDocs'), icon: BookOpen, external: true },
      ]
    : [
        { to: '/api-keys', label: t('nav.apiKeys'), icon: KeyRound },
        { to: '/api/docs', label: t('nav.apiDocs'), icon: BookOpen, external: true },
      ];

  return (
    <div className="flex h-full flex-col px-3.5 pt-5 pb-4">
      <div className="flex items-center gap-2.5 px-2 pb-5">
        <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-[26px] dark:hidden" />
        <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-[26px] dark:block" />
        <span className="border-l border-line pl-2.5 text-[11px] leading-tight text-muted">
          Hosted Radio
          <br />
          Station
        </span>
      </div>
      <nav className="flex flex-col gap-0.5 overflow-y-auto">
        {main.map((item) => (
          <NavItemLink key={item.to} item={item} onNavigate={onNavigate} />
        ))}
        <div className="px-2.5 pt-4 pb-1.5 text-[11px] tracking-[0.08em] text-muted uppercase">{admin ? t('nav.administration') : t('nav.developer')}</div>
        {administration.map((item) => (
          <NavItemLink key={item.to} item={item} onNavigate={onNavigate} />
        ))}
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

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { t, i18n } = useTranslation();
  const me = useMe().data!;
  useEffect(() => setMobileOpen(false), [location.pathname]);
  // The language saved on the account wins over the browser language, once per sign-in.
  useEffect(() => {
    if (me.user.locale !== i18n.language) void i18n.changeLanguage(me.user.locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.user.id]);

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-raised lg:block">
        <Sidebar onNavigate={() => {}} />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-[var(--overlay)]" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-raised shadow-2xl">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line bg-raised px-4 py-3 lg:hidden">
          <button onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 hover:bg-hover" aria-label={t('nav.openMenu')}>
            <Menu className="size-5" />
          </button>
          <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-5 dark:hidden" />
          <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-5 dark:block" />
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
