/** Number of station line colours; a station takes colour `index % STATION_COLORS` (styles.css --station-N). */
export const STATION_COLORS = 8;

/** The line colour of a station (or of a customer block) as a CSS value, for the 2D view and the legend. */
export const stationVar = (index: number | undefined) => `var(--station-${(index ?? 0) % STATION_COLORS})`;

/** The same colour as a hex value, for the 3D view (WebGL cannot use CSS variables). */
export function stationHex(index: number | undefined) {
  const css = getComputedStyle(document.documentElement);
  return css.getPropertyValue(`--station-${(index ?? 0) % STATION_COLORS}`).trim() || '#FF6B57';
}

/** A line carrying more stations than this is drawn as one line in the brand colour. */
export const MAX_SPLIT = 6;

/**
 * The stations on one line as parallel lines next to each other: each with its colour, its width and its offset across
 * the line (px or scene units, centred on the line).
 */
export function splitLine<T extends { id: string }>(stations: T[] | undefined, colorOf: (id: string) => number | undefined, width: (s: T) => number, gap: number) {
  if (!stations?.length || stations.length > MAX_SPLIT) return null;
  const widths = stations.map(width);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (stations.length - 1);
  let at = -total / 2;
  return stations.map((s, i) => {
    const offset = at + widths[i]! / 2;
    at += widths[i]! + gap;
    return { station: s, color: colorOf(s.id), width: widths[i]!, offset };
  });
}
