import i18n from '../i18n';

export function formatDate(value: string | null | undefined, withTime = true) {
  if (!value) return '—';
  const d = new Date(value);
  return new Intl.DateTimeFormat(i18n.language, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(d);
}

export function shortCommit(sha: string | null | undefined) {
  return sha ? sha.slice(0, 7) : '—';
}

export function formatBytes(n: number | null | undefined) {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** "in 3 hours" / "5 minutes ago", in the interface language. */
export function formatRelative(value: string | null | undefined) {
  if (!value) return '—';
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

/** "1:02:03" or "4:05" for a duration between two moments (to now when there is no end). */
export function formatDuration(from: string, to?: string | null) {
  const s = Math.max(0, Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "4:05" or "1:02:03" for a number of seconds. */
export function formatSeconds(total: number | null | undefined) {
  if (total == null || !Number.isFinite(total)) return '—';
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "€ 12,10" from cents, in the interface language. */
export function formatMoney(cents: number | null | undefined, currency = 'EUR') {
  if (cents == null) return '—';
  return new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(cents / 100);
}
