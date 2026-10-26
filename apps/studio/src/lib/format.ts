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
