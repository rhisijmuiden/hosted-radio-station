import { useQueryClient } from '@tanstack/react-query';
import { Radio } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { Button, Field, Input } from '../components/ui';
import { setLanguage } from '../i18n';
import { api, ApiError, type Me } from '../lib/api';
import { useMe } from '../lib/auth';

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const me = useMe();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/';
  if (me.data) return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api<Me>('/auth/login', { method: 'POST', body: { email, password } });
      qc.setQueryData(['me'], res);
      navigate(next, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_credentials'
          ? t('auth.invalid')
          : err instanceof ApiError && err.status === 429
            ? t('auth.tooMany')
            : (err as Error).message,
      );
    } finally {
      setLoading(false);
    }
  }

  const lang = i18n.language.startsWith('nl') ? 'nl' : 'en';

  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-nacht p-12 text-white lg:flex">
        <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="h-9 self-start" />
        <img src="/brand/rhis-antenne.svg" alt="" className="pointer-events-none absolute -right-20 -bottom-24 h-[420px] opacity-[0.08]" />
        <div className="relative max-w-md">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-lucht/15 px-3 py-1 text-xs font-semibold text-lucht">
            <Radio className="size-3.5" /> Hosted Radio Station
          </div>
          <h1 className="display text-[40px] leading-[44px]">{t('auth.heroTitle')}</h1>
          <p className="mt-4 text-[16px] leading-[26px] text-white/75">{t('auth.heroText')}</p>
        </div>
        <div className="relative text-xs text-white/50">Powered by RHIS</div>
      </div>

      <div className="flex flex-col px-6 py-8 sm:px-12">
        <div className="flex items-center justify-between">
          <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-7 lg:invisible dark:hidden" />
          <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-7 lg:invisible dark:block" />
          <button onClick={() => void setLanguage(lang === 'nl' ? 'en' : 'nl')} className="rounded-full border border-line px-3 py-1 text-xs font-semibold hover:bg-hover">
            {lang === 'nl' ? 'English' : 'Nederlands'}
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <form onSubmit={submit} className="w-full max-w-sm">
            <h2 className="display text-[28px] leading-[34px]">{t('auth.title')}</h2>
            <p className="mt-1 mb-7 text-muted">{t('auth.subtitle')}</p>
            <div className="flex flex-col gap-4">
              <Field label={t('fields.email')} htmlFor="email">
                <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label={t('fields.password')} htmlFor="password">
                <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
              <Button type="submit" variant="primary" loading={loading} className="mt-1 w-full">
                {t('auth.signIn')}
              </Button>
              <p className="text-xs text-muted">{t('auth.forgot')}</p>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
