import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { api } from './api';
import { useSession } from './session';
import { getSettings, updateSettings, useSettings } from './settings';

/** What the big countdown of the dashboard counts down to. */
export type Countdown = 'block' | 'track' | 'timer';
export type OmniPanel = 'history' | 'single' | 'news' | 'jingles' | 'stationCarts' | 'dashboard' | 'library';

/**
 * The layout of Assist in the DJ profile: the same on every studio PC. Classic is the layout Studio had so far; OmniPlayer
 * has players A/B with the log under them on the left, and the panels next to them. Panels go on or off; the width
 * of the left column is dragged.
 */
export interface StudioLayout {
  assist: 'classic' | 'omni';
  panels: Record<OmniPanel, boolean>;
  /** Width of the column with players A/B and the log, in pixels. */
  deckWidth: number;
  countdown: Countdown;
  /** Length of the DJ's own timer, in seconds. */
  timerSeconds: number;
}

export const DECK_WIDTH = { min: 440, max: 900, default: 560 };

export const defaultLayout: StudioLayout = {
  assist: 'classic',
  panels: { history: true, single: true, news: true, jingles: true, stationCarts: true, dashboard: true, library: true },
  deckWidth: DECK_WIDTH.default,
  countdown: 'block',
  timerSeconds: 180,
};

/** A saved layout with every field checked: it may come from an older or newer client. */
function parse(raw: unknown): StudioLayout {
  const l = (raw && typeof raw === 'object' ? raw : {}) as Partial<StudioLayout>;
  const panels = { ...defaultLayout.panels };
  for (const k of Object.keys(panels) as OmniPanel[]) if (typeof l.panels?.[k] === 'boolean') panels[k] = l.panels[k];
  const width = typeof l.deckWidth === 'number' ? Math.round(l.deckWidth) : DECK_WIDTH.default;
  return {
    assist: l.assist === 'omni' ? 'omni' : 'classic',
    panels,
    deckWidth: Math.min(DECK_WIDTH.max, Math.max(DECK_WIDTH.min, width)),
    countdown: l.countdown === 'track' || l.countdown === 'timer' ? l.countdown : 'block',
    timerSeconds: typeof l.timerSeconds === 'number' && l.timerSeconds >= 10 && l.timerSeconds <= 5940 ? Math.round(l.timerSeconds) : defaultLayout.timerSeconds,
  };
}

interface Profile {
  layout: Record<string, unknown>;
}

/**
 * The layout and a function to change it. It lives in the DJ profile on the server (servers with the `profile` feature) and is
 * kept on this PC as well, for an older server and to start without waiting. Changes are saved after a short pause, so dragging a
 * width sends one request.
 */
export function useLayout(): [StudioLayout, (patch: Partial<StudioLayout>) => void] {
  const { supports, me } = useSession();
  const qc = useQueryClient();
  const local = useSettings().layout;
  const enabled = !!me && supports('profile');
  const key = ['profile', me ? me.user.id : null];
  const profile = useQuery({ queryKey: key, queryFn: () => api<Profile>('/studio/profile'), enabled, staleTime: 60_000, retry: 1 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // An empty profile (never saved) keeps what this PC had.
  const fromServer = profile.data && Object.keys(profile.data.layout).length ? profile.data.layout : null;
  const layout = parse(fromServer ?? local);
  const update = (patch: Partial<StudioLayout>) => {
    const next = { ...layout, ...patch };
    updateSettings({ layout: next });
    if (!enabled) return;
    qc.setQueryData<Profile>(key, { layout: next as unknown as Record<string, unknown> });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void api('/studio/profile', { method: 'PUT', body: { layout: getSettings().layout } }).catch(() => undefined), 600);
  };
  return [layout, update];
}
