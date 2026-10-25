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
