import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, type ClockItem, type Playlist, type SchedulerView } from './api';

export const useScheduler = (id: string | undefined) =>
  useQuery({ queryKey: ['scheduler', id], queryFn: () => api<SchedulerView>(`/stations/${id}/scheduler`), enabled: !!id, refetchInterval: 30_000 });

export const usePlaylists = (id: string | undefined) =>
  useQuery({ queryKey: ['playlists', id], queryFn: () => api<Playlist[]>(`/stations/${id}/playlists`), enabled: !!id, staleTime: 30_000 });

/** Colours a station can give its clocks (RHIS palette first), the same as in the web panel. */
export const CLOCK_COLORS = ['#FF6B57', '#14213D', '#9CC3FF', '#1C8A57', '#A86B00', '#8B5CF6', '#E11D74', '#0EA5E9'];
/** Nacht disappears on a dark background: it is drawn in the ink colour, which follows the theme. */
export const paint = (color: string) => (color.toUpperCase() === '#14213D' ? 'var(--ink)' : color);
/** Colours of the items on the dial; music from the queues takes the clock's own colour. */
const ITEM_COLORS = ['var(--ink)', '#9CC3FF', '#A86B00', '#8B5CF6', '#1C8A57', '#E11D74', '#0EA5E9'];
/** Length of a track when nothing better is known. */
const TRACK_SECONDS = 210;
/** Expected length of a news bulletin on the dial. */
const NEWS_SECONDS = 180;
const NEWS_COLOR = '#B79CFF';

export const newItemId = () => Math.random().toString(36).slice(2, 10);
const anchorOf = (items: ClockItem[], i: number) => items[i]?.at ?? (i === 0 ? 0 : null);
const isFill = (item: ClockItem) => item.kind === 'rotation' || (item.kind === 'playlist' && item.count === 0);
export const minuteLabel = (m: number) => `:${String(Math.floor(m)).padStart(2, '0')}`;

export interface Segment {
  item: ClockItem;
  index: number;
  start: number;
  end: number;
}

/** Where every item roughly falls in the hour (minutes), for the dial and the list; the same sums as the web panel. */
export function clockLayout(items: ClockItem[], seconds: (item: ClockItem) => number): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  items.forEach((item, index) => {
    const a = anchorOf(items, index);
    const start = Math.min(60, a ?? cursor);
    let end: number;
    if (isFill(item)) {
      let next = 60;
      for (let j = index + 1; j < items.length; j++) {
        const n = anchorOf(items, j);
        if (n !== null) {
          next = n;
          break;
        }
      }
      end = Math.max(start, next);
    } else end = start + (seconds(item) * (item.kind === 'track' || item.kind === 'news' ? 1 : Math.max(1, item.count))) / 60;
    out.push({ item, index, start, end: Math.min(60, end) });
    cursor = end;
  });
  return out;
}

export type TrackInfo = { id: string; title: string; artist: string; durationSeconds: number | null };

/** Names, lengths and colours of clock items, from the playlists and the tracks the clocks use. */
export function useItemInfo(playlists: Playlist[] | undefined, tracks: TrackInfo[], extra: Record<string, TrackInfo>) {
  return useMemo(() => {
    const lists = new Map((playlists ?? []).map((p) => [p.id, p]));
    const media = new Map<string, TrackInfo>(tracks.map((t) => [t.id, t]));
    for (const m of Object.values(extra)) media.set(m.id, m);
    const palette = new Map<string, string>();
    (playlists ?? []).forEach((p, i) => palette.set(p.id, ITEM_COLORS[i % ITEM_COLORS.length]!));
    return {
      playlist: (id: string | null) => (id ? lists.get(id) : undefined),
      track: (id: string | null) => (id ? media.get(id) : undefined),
      seconds: (item: ClockItem) =>
        item.kind === 'news'
          ? NEWS_SECONDS
          : item.kind === 'track'
            ? (media.get(item.mediaId ?? '')?.durationSeconds ?? TRACK_SECONDS)
            : (lists.get(item.playlistId ?? '')?.averageSeconds ?? TRACK_SECONDS),
      color: (item: ClockItem, clockColor: string) =>
        item.kind === 'rotation' ? paint(clockColor) : item.kind === 'news' ? NEWS_COLOR : item.kind === 'track' ? '#4F5B73' : (palette.get(item.playlistId ?? '') ?? '#4F5B73'),
    };
  }, [playlists, tracks, extra]);
}
