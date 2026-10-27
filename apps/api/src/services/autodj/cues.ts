/** Cue points of a library track, in seconds from the start of the file; null = not set. */
export interface Cues {
  cueIn: number | null;
  cueIntro: number | null;
  cueSegue: number | null;
  cueFadeOut: number | null;
  cueOut: number | null;
}

export const CUE_KEYS = ['cueIn', 'cueIntro', 'cueSegue', 'cueFadeOut', 'cueOut'] as const;

/** Longest overlap with the next track a segue may ask for; the crossfade buffers this much of the track. */
export const MAX_SEGUE_SECONDS = 30;

/** Why these cue points cannot be used together, or null when they fit. */
export function cueProblem(c: Cues, duration: number | null): string | null {
  for (const k of CUE_KEYS) {
    const v = c[k];
    if (v == null) continue;
    if (v < 0) return 'Cue points cannot be negative';
    if (duration != null && v > duration + 0.5) return 'A cue point lies after the end of the track';
  }
  const start = c.cueIn ?? 0;
  const end = c.cueOut ?? duration;
  if (end != null && end - start < 1) return 'Cue out must be at least a second after cue in';
  for (const k of ['cueIntro', 'cueSegue', 'cueFadeOut'] as const) {
    const v = c[k];
    if (v == null) continue;
    if (v < start || (end != null && v > end)) return 'Intro, segue and fade-out must lie between cue in and cue out';
  }
  if (c.cueSegue != null && end != null && end - c.cueSegue > MAX_SEGUE_SECONDS) return `The segue can start at most ${MAX_SEGUE_SECONDS} seconds before cue out`;
  return null;
}

/**
 * Seconds from the moment a track starts until the next one starts: up to its segue, or to its end less the crossfade.
 * Null when the length of the file is unknown and no cue point says it.
 */
export function playSeconds(m: Pick<Cues, 'cueIn' | 'cueSegue' | 'cueOut'> & { durationSeconds: number | null }, fade: number): number | null {
  const start = m.cueIn ?? 0;
  if (m.cueSegue != null) return Math.max(0, m.cueSegue - start);
  const end = m.cueOut ?? m.durationSeconds;
  return end == null ? null : Math.max(0, end - start - fade);
}

/**
 * Liquidsoap annotations for the cue points: cue in and out cut the request, the segue sets how long before the end
 * the crossfade begins (without crossfade the track simply stops there), the fade-out how long the track fades.
 */
export function cueAnnotations(m: Cues & { durationSeconds: number | null }, fade: number): Record<string, string> {
  const n = (v: number) => v.toFixed(3);
  const meta: Record<string, string> = {};
  if (m.cueIn != null && m.cueIn > 0) meta.liq_cue_in = n(m.cueIn);
  const end = m.cueOut ?? m.durationSeconds;
  let out = m.cueOut;
  if (m.cueSegue != null && end != null) {
    if (fade > 0) meta.liq_cross_duration = n(Math.min(MAX_SEGUE_SECONDS, Math.max(0.1, end - m.cueSegue)));
    else out = m.cueSegue;
  }
  if (out != null) meta.liq_cue_out = n(out);
  if (fade > 0 && m.cueFadeOut != null && end != null && end - m.cueFadeOut > 0) meta.liq_fade_out = n(end - m.cueFadeOut);
  return meta;
}
