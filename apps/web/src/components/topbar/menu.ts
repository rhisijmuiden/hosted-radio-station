import { BarChart3, Bot, Building2, CalendarDays, CircleDot, Clock, Code2, CreditCard, Disc3, Eye, FileSpreadsheet, Grid3x3, History, KeyRound, ListMusic, ListOrdered, MessageSquare, Mic, MonitorSmartphone, Network, Newspaper, PlayCircle, Plug, Route, Server, Settings, Share2, SquareArrowOutUpRight, Upload, UserRound, Waypoints, type LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { Role, StationDetail } from '../../lib/api';
import { stationTabHref, type StationTab } from '../station/menu';

/** One page in a drop-down of the customer top menu: a title with a one-line explanation. */
export interface TopItem {
  key: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  to: string;
  /** Only a Radio station has it: shown with a lock (and the upgrade button) for a Distribution station. */
  locked?: boolean;
  badge?: number;
}
export interface TopGroup {
  key: string;
  title: string | null;
  items: TopItem[];
}
export type TopKey = 'overview' | 'station' | 'broadcast' | 'network' | 'audience' | 'settings';
export interface TopEntry {
  key: TopKey;
  label: string;
  /** Overview is a plain link; the others open a drop-down. */
  to?: string;
  groups: TopGroup[];
  /** The Radio station menu is the large one, in four columns. */
  mega?: boolean;
}

const rank = { dj: 1, manager: 2, owner: 3, superadmin: 4 } as const;

export interface TopMenuInput {
  station: Pick<StationDetail, 'id' | 'name' | 'edition' | 'role'> | null;
  /** Not a DJ in any customer: sees network, company and API keys. */
  notDj: boolean;
  billed: boolean;
  multiCustomer: boolean;
  /** Number of stations the user sees; the all-stations statistics only help with more than one. */
  stationCount: number;
  pendingRequests?: number;
}

/**
 * The customer top menu (option A of the navigation sketch): Overview, Radio station, Broadcast, My network, Audience
 * and Settings, each with a drop-down of pages and a one-line explanation. The pages of a station follow the station
 * that is picked in the station switcher; what a DJ sees and what only a Radio station has follow its role and edition.
 */
export function topMenu(input: TopMenuInput, t: TFunction): TopEntry[] {
  const { station: s, notDj } = input;
  const role: Role | 'superadmin' = s?.role ?? 'dj';
  const manager = !!s && rank[role] >= rank.manager;
  const dist = s?.edition === 'distribution';
  const tab = (value: StationTab, focus?: string) => (s ? `${stationTabHref(s.id, value)}${focus ? `${value === 'overview' ? '?' : '&'}focus=${focus}` : ''}` : '/');
  const item = (key: string, icon: LucideIcon, to: string, extra: Partial<TopItem> = {}): TopItem => ({ key, icon, to, label: t(`topnav.items.${key}`), hint: t(`topnav.hints.${key}`), ...extra });

  const entries: TopEntry[] = [{ key: 'overview', label: t('topnav.overview'), to: s ? tab('overview') : '/', groups: [] }];

  if (s) {
    entries.push({
      key: 'station',
      label: t('topnav.station'),
      mega: true,
      groups: [
        {
          key: 'programme',
          title: t('topnav.groups.programme'),
          items: [
            item('autodj', Bot, tab('autodj'), { locked: dist }),
            item('clocks', Clock, tab('clocks'), { locked: dist }),
            item('schedule', CalendarDays, tab('schedule'), { locked: dist }),
            item('playlists', ListMusic, tab('playlists'), { locked: dist }),
            item('log', ListOrdered, tab('log'), { locked: dist }),
            item('carts', Grid3x3, tab('carts'), { locked: dist }),
            item('news', Newspaper, tab('news'), { locked: dist }),
          ],
        },
        {
          key: 'media',
          title: t('topnav.groups.media'),
          items: [
            item('library', Disc3, tab('library'), { locked: dist }),
            ...(manager ? [item('upload', Upload, tab('library', 'upload'), { locked: dist }), item('shares', Share2, tab('library', 'sources'), { locked: dist })] : []),
            item('ondemand', PlayCircle, tab('ondemand')),
          ],
        },
        {
          key: 'people',
          title: t('topnav.groups.people'),
          items: [
            manager ? item('accounts', UserRound, tab('accounts')) : item('myAccount', UserRound, tab('accounts')),
            item('live', Mic, tab('connection', 'live')),
            item('requests', MessageSquare, tab('requests'), { badge: input.pendingRequests || undefined }),
            item('studio', MonitorSmartphone, '/studio'),
          ],
        },
        ...(manager
          ? [
              {
                key: 'public',
                title: t('topnav.groups.public'),
                items: [item('public', Eye, tab('public')), item('api', Code2, tab('public', 'api'))],
              },
            ]
          : []),
      ],
    });
    entries.push({
      key: 'broadcast',
      label: t('topnav.broadcast'),
      groups: [
        {
          key: 'broadcast',
          title: null,
          items: [
            item('connection', Plug, tab('connection')),
            ...(manager ? [item('mounts', Waypoints, tab('mounts')), item('outputs', SquareArrowOutUpRight, tab('outputs'))] : []),
            item('history', History, tab('history')),
            ...(manager ? [item('recordings', CircleDot, tab('recordings'))] : []),
          ],
        },
      ],
    });
  }

  if (notDj)
    entries.push({
      key: 'network',
      label: t('topnav.network'),
      groups: [
        {
          key: 'network',
          title: null,
          items: [item('nodes', Server, '/nodes'), ...(manager ? [item('routing', Route, tab('routing'))] : []), item('map', Network, '/topology')],
        },
      ],
    });

  const audience: TopItem[] = [
    ...(manager ? [item('statistics', BarChart3, tab('statistics')), item('reports', FileSpreadsheet, tab('reports'))] : []),
    ...(notDj && input.stationCount > 1 ? [item('allStatistics', BarChart3, '/statistics')] : []),
  ];
  if (audience.length) entries.push({ key: 'audience', label: t('topnav.audience'), groups: [{ key: 'audience', title: null, items: audience }] });

  entries.push({
    key: 'settings',
    label: t('topnav.settings'),
    groups: [
      ...(manager ? [{ key: 'station', title: s!.name, items: [item('stationSettings', Settings, tab('settings'))] }] : []),
      {
        key: 'account',
        title: t('topnav.groups.account'),
        items: [
          ...(notDj ? [item(input.multiCustomer ? 'customers' : 'company', Building2, '/customers')] : []),
          ...(input.billed ? [item('subscription', CreditCard, '/subscription')] : []),
          item('apiKeys', KeyRound, '/api-keys'),
          item('profile', UserRound, '/profile'),
        ],
      },
    ],
  });
  return entries;
}

/** Strips the `focus` hint, so a menu item that scrolls to part of a page still counts as that page. */
function page(href: string) {
  const [path, query = ''] = href.split('?');
  const params = new URLSearchParams(query);
  params.delete('focus');
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}

/** Which top item and which page light up for the current address. */
export function activeIn(entries: TopEntry[], pathname: string, search: string): { top: TopKey | null; item: string | null } {
  const here = page(`${pathname}${search}`);
  // An exact page first (a station tab), then the longest path that contains the address (/nodes/123 → My nodes).
  for (const e of entries) {
    if (e.to && page(e.to) === here) return { top: e.key, item: null };
    for (const g of e.groups) for (const i of g.items) if (!i.locked && i.to === `${pathname}${search}`) return { top: e.key, item: i.key };
  }
  for (const e of entries) for (const g of e.groups) for (const i of g.items) if (!i.locked && page(i.to) === here) return { top: e.key, item: i.key };
  let best: { top: TopKey; item: string; len: number } | null = null;
  for (const e of entries)
    for (const g of e.groups)
      for (const i of g.items) {
        const p = page(i.to).split('?')[0];
        if (p !== '/' && !p.startsWith('/stations/') && (pathname === p || pathname.startsWith(`${p}/`)) && (!best || p.length > best.len)) best = { top: e.key, item: i.key, len: p.length };
      }
  if (best) return { top: best.top, item: best.item };
  if (pathname === '/' || pathname.startsWith('/stations')) return { top: 'overview', item: null };
  return { top: null, item: null };
}
