import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, MailCheck, Radio } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { Button, Field, Input } from '../components/ui';
import { setLanguage } from '../i18n';
import { api, ApiError, type AuthOptions, type Me } from '../lib/api';
import { useMe } from '../lib/auth';

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const me = useMe();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const ssoError = params.get('sso_error');
  const [error, setError] = useState<string | null>(ssoError ? t(`auth.ssoError.${ssoError}`, { defaultValue: t('auth.ssoError.invalid_response') }) : null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'password' | 'forgot' | 'sso'>('password');
  const [sent, setSent] = useState(false);
  const options = useQuery({ queryKey: ['auth-options'], queryFn: () => api<AuthOptions>('/auth/options'), staleTime: 300_000 });

  const rawNext = params.get('next');
  const next = rawNext?.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  // A direct link like /login?sso=harder-fm goes straight to that customer's identity provider.
  const ssoTenant = params.get('sso');
  useEffect(() => {
    if (ssoTenant && !me.data) window.location.href = `/api/auth/sso/start?tenant=${encodeURIComponent(ssoTenant)}&next=${encodeURIComponent(next)}`;
  }, [ssoTenant, me.data, next]);
  if (me.data) return <Navigate to={next} replace />;

  const fail = (err: unknown) =>
    setError(
      err instanceof ApiError && err.code === 'invalid_credentials'
        ? t('auth.invalid')
        : err instanceof ApiError && err.status === 429
          ? t('auth.tooMany')
          : (err as Error).message,
    );

  async function startSso() {
    try {
      const res = await api<{ url: string }>('/auth/sso/discover', { method: 'POST', body: { email, next } });
      window.location.href = res.url;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'sso_not_found') setError(t('auth.ssoNotFound'));
      else fail(err);
      setLoading(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    if (mode === 'sso') return startSso();
    if (mode === 'forgot') {
      try {
        await api('/auth/forgot', { method: 'POST', body: { email } });
        setSent(true);
      } catch (err) {
        fail(err);
      } finally {
        setLoading(false);
      }
      return;
    }
    try {
      const res = await api<Me>('/auth/login', { method: 'POST', body: { email, password } });
      qc.setQueryData(['me'], res);
      navigate(next, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'sso_required') {
        setError(t('auth.ssoRequired'));
        return startSso();
      }
      fail(err);
    } finally {
      setLoading(false);
    }
  }

  const switchMode = (m: typeof mode) => {
    setMode(m);
    setError(null);
    setSent(false);
  };

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
            {mode !== 'password' && (
              <button type="button" onClick={() => switchMode('password')} className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
                <ArrowLeft className="size-4" /> {t('auth.backToSignIn')}
              </button>
            )}
            <h2 className="display text-[28px] leading-[34px]">
              {mode === 'forgot' ? t('auth.forgotTitle') : mode === 'sso' ? t('auth.ssoTitle') : t('auth.title')}
            </h2>
            <p className="mt-1 mb-7 text-muted">{mode === 'forgot' ? t('auth.forgotText') : mode === 'sso' ? t('auth.ssoText') : t('auth.subtitle')}</p>
            {sent ? (
              <div className="flex gap-3 rounded-md bg-online/10 px-4 py-3 text-[13px]">
                <MailCheck className="mt-0.5 size-5 shrink-0 text-online" />
                <span>{t('auth.forgotSent', { email })}</span>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <Field label={t('fields.email')} htmlFor="email">
                  <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                {mode === 'password' && (
                  <Field
                    label={
                      <span className="flex items-center justify-between">
                        {t('fields.password')}
                        {options.data?.passwordReset && (
                          <button type="button" onClick={() => switchMode('forgot')} className="text-xs font-semibold text-accent-text hover:underline">
                            {t('auth.forgotLink')}
                          </button>
                        )}
                      </span>
                    }
                    htmlFor="password"
                  >
                    <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                  </Field>
                )}
                {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
                <Button type="submit" variant="primary" loading={loading} className="mt-1 w-full">
                  {mode === 'forgot' ? t('auth.forgotSend') : mode === 'sso' ? t('auth.ssoContinue') : t('auth.signIn')}
                </Button>
                {mode === 'password' && options.data?.sso && (
                  <>
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <span className="h-px flex-1 bg-line" /> {t('auth.or')} <span className="h-px flex-1 bg-line" />
                    </div>
                    <Button type="button" className="w-full" onClick={() => switchMode('sso')}>
                      <KeyRound className="size-4" /> {t('auth.ssoButton')}
                    </Button>
                  </>
                )}
                {mode === 'password' && options.data && !options.data.passwordReset && <p className="text-xs text-muted">{t('auth.forgot')}</p>}
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
