export function duration(seconds: number | null | undefined) {
  if (seconds == null || !isFinite(seconds)) return '–:––';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function bytes(n: number) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const toDb = (v: number) => (v <= 0.00001 ? -100 : 20 * Math.log10(v));

/** Compares x.y.z[-test.n] like the server does. */
export function compareVersions(a: string, b: string) {
  const parse = (v: string) => {
    const [core, pre] = v.split('-test.');
    return [...core!.split('.').map(Number), pre === undefined ? Number.MAX_SAFE_INTEGER : Number(pre)];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** The Camelot code of a key ("Am" → "8A"), for mixing in key; empty when the key is unknown. */
export function camelot(key: string | null | undefined) {
  const m = /^([A-G])(#|b)?(m)?$/.exec(key ?? '');
  if (!m) return '';
  const root = (SEMITONE[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return m[3] ? `${CAMELOT_MINOR[root]}A` : `${CAMELOT_MAJOR[root]}B`;
}
