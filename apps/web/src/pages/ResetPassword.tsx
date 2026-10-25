import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button, Field, Input, Spinner } from '../components/ui';
import { setLanguage } from '../i18n';
import { api, type Me } from '../lib/api';

/** Choosing a password from a reset or invitation link. Signs in right after. */
export function ResetPasswordPage() {
  const { t, i18n } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const info = useQuery({
    queryKey: ['reset-token', token],
    queryFn: () => api<{ email: string; name: string; purpose: 'reset' | 'invite' }>(`/auth/reset/${encodeURIComponent(token)}`),
    enabled: token.length >= 10,
    retry: false,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== repeat) return setError(t('profile.mismatch'));
    setError(null);
    setLoading(true);
    try {
      const me = await api<Me>('/auth/reset', { method: 'POST', body: { token, password } });
      qc.setQueryData(['me'], me);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const lang = i18n.language.startsWith('nl') ? 'nl' : 'en';
  const invite = info.data?.purpose === 'invite';

  return (
    <div className="flex min-h-full flex-col px-6 py-8 sm:px-12">
      <div className="flex items-center justify-between">
        <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-7 dark:hidden" />
        <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-7 dark:block" />
        <button onClick={() => void setLanguage(lang === 'nl' ? 'en' : 'nl', false)} className="rounded-full border border-line px-3 py-1 text-xs font-semibold hover:bg-hover">
          {lang === 'nl' ? 'English' : 'Nederlands'}
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-sm">
          <div className="mb-5 grid size-12 place-items-center rounded-full bg-chip text-accent-text">
            <ShieldCheck className="size-6" />
          </div>
          {info.isPending && token ? (
            <Spinner />
          ) : !info.data ? (
            <>
              <h1 className="display text-[28px] leading-[34px]">{t('reset.titleReset')}</h1>
              <p className="mt-3 rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{t('reset.invalid')}</p>
              <Link to="/login" className="mt-5 inline-block text-[13px] font-semibold text-accent-text hover:underline">
                {t('reset.requestNew')}
              </Link>
            </>
          ) : (
            <form onSubmit={submit}>
              <h1 className="display text-[28px] leading-[34px]">{invite ? t('reset.titleInvite') : t('reset.titleReset')}</h1>
              <p className="mt-1 mb-7 text-muted">
                {invite ? t('reset.textInvite', { name: info.data.name, email: info.data.email }) : t('reset.textReset', { email: info.data.email })}
              </p>
              <div className="flex flex-col gap-4">
                <input type="email" autoComplete="username" value={info.data.email} readOnly hidden />
                <Field label={t('reset.password')} hint={t('profile.newHint')}>
                  <Input type="password" autoComplete="new-password" required minLength={10} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
                <Field label={t('reset.repeat')}>
                  <Input type="password" autoComplete="new-password" required minLength={10} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
                </Field>
                {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
                <Button type="submit" variant="primary" loading={loading} className="w-full">
                  {invite ? t('reset.submitInvite') : t('reset.submitReset')}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
