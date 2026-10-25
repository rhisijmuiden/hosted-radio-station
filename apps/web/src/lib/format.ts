import i18n from '../i18n';

export function formatDate(value: string | null | undefined, withTime = true) {
  if (!value) return '—';
  const d = new Date(value);
  return new Intl.DateTimeFormat(i18n.language, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(d);
}

export function shortCommit(sha: string | null | undefined) {
  return sha ? sha.slice(0, 7) : '—';
}
