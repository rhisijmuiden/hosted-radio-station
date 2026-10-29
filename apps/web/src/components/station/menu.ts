import { BarChart3, CalendarDays, CircleDot, Clock, Disc3, Eye, Grid3x3, History, LayoutDashboard, ListMusic, ListOrdered, Newspaper, MessageSquare, PlayCircle, Plug, Route, Settings, SquareArrowOutUpRight, UserRound, Bot, Waypoints, type LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { StationDetail } from '../../lib/api';

export type StationTab =
  | 'overview'
  | 'connection'
  | 'routing'
  | 'mounts'
  | 'outputs'
  | 'history'
  | 'autodj'
  | 'library'
  | 'playlists'
  | 'clocks'
  | 'schedule'
  | 'carts'
  | 'news'
  | 'log'
  | 'ondemand'
  | 'recordings'
  | 'requests'
  | 'statistics'
  | 'public'
  | 'accounts'
  | 'settings';

export interface StationMenuItem {
  value: StationTab;
  label: string;
  icon: LucideIcon;
  badge?: number;
}
export interface StationMenuGroup {
  key: string;
  title: string | null;
  items: StationMenuItem[];
}

const rank = { dj: 1, manager: 2, owner: 3, superadmin: 4 } as const;

/**
 * The menu of one station (phase 19), shown in the sidebar instead of a row of tabs: overview, broadcast, programme,
 * audience and settings. What a DJ sees, and what only a Radio station (with AutoDJ) has, follows the station's role
 * and edition.
 */
export function stationMenu(station: Pick<StationDetail, 'role' | 'edition'>, t: TFunction, pendingRequests = 0): StationMenuGroup[] {
  const manager = rank[station.role] >= rank.manager;
  const radio = station.edition === 'station';
  const groups: StationMenuGroup[] = [
    { key: 'overview', title: null, items: [{ value: 'overview', label: t('stations.tabs.overview'), icon: LayoutDashboard }] },
    {
      key: 'broadcast',
      title: t('stations.menu.broadcast'),
      items: [
        { value: 'connection', label: t('stations.tabs.connection'), icon: Plug },
        ...(manager
          ? [
              { value: 'routing' as const, label: t('stations.tabs.routing'), icon: Route },
              { value: 'mounts' as const, label: t('stations.tabs.mounts'), icon: Waypoints },
              { value: 'outputs' as const, label: t('stations.tabs.outputs'), icon: SquareArrowOutUpRight },
            ]
          : []),
        { value: 'history', label: t('stations.tabs.history'), icon: History },
      ],
    },
    {
      key: 'programme',
      title: t('stations.menu.programme'),
      items: [
        ...(radio
          ? [
              { value: 'autodj' as const, label: t('stations.tabs.autodj'), icon: Bot },
              { value: 'library' as const, label: t('stations.tabs.library'), icon: Disc3 },
              { value: 'playlists' as const, label: t('stations.tabs.playlists'), icon: ListMusic },
              { value: 'clocks' as const, label: t('stations.tabs.clocks'), icon: Clock },
              { value: 'schedule' as const, label: t('stations.tabs.schedule'), icon: CalendarDays },
              { value: 'log' as const, label: t('stations.tabs.log'), icon: ListOrdered },
              { value: 'carts' as const, label: t('stations.tabs.carts'), icon: Grid3x3 },
              { value: 'news' as const, label: t('stations.tabs.news'), icon: Newspaper },
            ]
          : []),
        { value: 'ondemand', label: t('stations.tabs.ondemand'), icon: PlayCircle },
        ...(manager ? [{ value: 'recordings' as const, label: t('stations.tabs.recordings'), icon: CircleDot }] : []),
        { value: 'requests', label: t('stations.tabs.requests'), icon: MessageSquare, badge: pendingRequests || undefined },
      ],
    },
    {
      key: 'audience',
      title: t('stations.menu.audience'),
      items: manager
        ? [
            { value: 'statistics', label: t('stations.tabs.statistics'), icon: BarChart3 },
            { value: 'public', label: t('stations.tabs.public'), icon: Eye },
          ]
        : [],
    },
    {
      key: 'settings',
      title: t('stations.menu.settings'),
      items: [
        { value: 'accounts', label: manager ? t('stations.tabs.accounts') : t('stations.tabs.myAccount'), icon: UserRound },
        ...(manager ? [{ value: 'settings' as const, label: t('stations.tabs.settings'), icon: Settings }] : []),
      ],
    },
  ];
  return groups.filter((g) => g.items.length);
}

export function stationTabs(groups: StationMenuGroup[]): StationMenuItem[] {
  return groups.flatMap((g) => g.items);
}

export function stationTabHref(id: string, tab: StationTab) {
  return tab === 'overview' ? `/stations/${id}` : `/stations/${id}?tab=${tab}`;
}
