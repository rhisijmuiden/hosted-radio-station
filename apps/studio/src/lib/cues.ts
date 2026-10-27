import type { Cues } from './api';

export type CueKey = keyof Required<Cues>;

/** The cue points in playing order, with their colour on the waveform. */
export const CUE_POINTS: { key: CueKey; color: string }[] = [
  { key: 'cueIn', color: 'var(--status-online)' },
  { key: 'cueIntro', color: 'var(--lucht)' },
  { key: 'cueSegue', color: 'var(--koraal)' },
  { key: 'cueFadeOut', color: 'var(--status-warning)' },
  { key: 'cueOut', color: 'var(--status-offline)' },
];

type Track = Cues & { durationSeconds: number | null };

/** How long the track plays, from cue in to cue out. */
export function trackLength(m: Track): number | null {
  const end = m.cueOut ?? m.durationSeconds;
  return end == null ? null : Math.max(0, end - (m.cueIn ?? 0));
}

/** Seconds from the start of the track until the next one starts: its segue, or its end less the crossfade. */
export function playLength(m: Track, fade: number): number | null {
  if (m.cueSegue != null) return Math.max(0, m.cueSegue - (m.cueIn ?? 0));
  const length = trackLength(m);
  return length == null ? null : Math.max(0, length - fade);
}

/** Seconds of intro left after `elapsed` seconds of playing; null when the track has no intro point or it passed. */
export function introLeft(m: Track, elapsed: number): number | null {
  if (m.cueIntro == null) return null;
  const left = m.cueIntro - (m.cueIn ?? 0) - elapsed;
  return left > 0 ? left : null;
}
