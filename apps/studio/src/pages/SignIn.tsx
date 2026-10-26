import { ExternalLink, Loader2, Radio } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Field, Input } from '../components/ui';
import { LanguageToggle, ThemeToggle } from '../components/Toggles';
import { api, ApiError, saveKey } from '../lib/api';
import { openExternal } from '../lib/native';
import { useSession } from '../lib/session';
import { normalizeServer, useSettings } from '../lib/settings';

interface LinkStart {
  code: string;
  deviceSecret: string;
  verifyUrl: string;
  expiresAt: string;
  interval: number;
}
interface LinkPoll {
  state: 'pending' | 'approved' | 'denied' | 'expired';
  apiKey?: string;
}

/** Linking this PC: the user approves the code in the panel in their browser, the client polls for its key. */
export function SignInPage() {
  const { t } = useTranslation();
  const { app, signedIn } = useSession();
  const settings = useSettings();
  const [server, setServer] = useState(settings.server);
  const [link, setLink] = useState<(LinkStart & { server: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const start = async () => {
    const base = normalizeServer(server);
    if (!base) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api<LinkStart>('/studio/link', { method: 'POST', server: base, auth: false, body: { deviceName: app?.hostname || 'Studio PC', clientVersion: app?.version } });
      setLink({ ...res, server: base });
      await openExternal(res.verifyUrl);
      poll({ ...res, server: base });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? t('signIn.notAServer') : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const poll = (l: LinkStart & { server: string }) => {
    timer.current = setTimeout(async () => {
      try {
        const res = await api<LinkPoll>('/studio/link/poll', { method: 'POST', server: l.server, auth: false, body: { deviceSecret: l.deviceSecret } });
        if (res.state === 'approved' && res.apiKey) {
          await saveKey(l.server, res.apiKey);
          await signedIn(l.server, res.apiKey);
          return;
        }
        if (res.state === 'denied' || res.state === 'expired') {
          setLink(null);
          setError(t(`signIn.${res.state}`));
          return;
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setLink(null);
          setError(t('signIn.expired'));
          return;
        }
      }
      poll(l);
    }, l.interval * 1000);
  };

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    setLink(null);
  };

  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-surface p-6">
      <div
        className="pointer-events-none absolute -top-40 -right-40 size-[520px] rounded-full opacity-25 blur-3xl"
        style={{ background: 'radial-gradient(circle, var(--koraal), transparent 70%)' }}
      />
      <div className="absolute top-5 right-5 flex gap-2">
        <LanguageToggle />
        <ThemeToggle />
      </div>
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex items-center gap-3">
          <img src="/brand/rhis-logo.svg" alt="RHIS" className="h-8 dark:hidden" />
          <img src="/brand/rhis-logo-wit.svg" alt="RHIS" className="hidden h-8 dark:block" />
          <span className="border-l border-line pl-3 text-[13px] leading-tight text-muted">
            Studio
            <br />
            {t('app.tagline')}
          </span>
        </div>
        <div className="rounded-lg border border-line bg-raised p-7 shadow-xl">
          {!link ? (
            <form
              className="flex flex-col gap-5"
              onSubmit={(e) => {
                e.preventDefault();
                void start();
              }}
            >
              <div>
                <h1 className="display text-2xl">{t('signIn.title')}</h1>
                <p className="mt-1 text-[13px] text-muted">{t('signIn.subtitle')}</p>
              </div>
              <Field label={t('signIn.server')} hint={t('signIn.serverHint')}>
                <Input required autoFocus value={server} onChange={(e) => setServer(e.target.value)} placeholder="radio.example.com" spellCheck={false} />
              </Field>
              {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
              <Button variant="primary" type="submit" loading={busy} className="w-full">
                <ExternalLink className="size-4" /> {t('signIn.withBrowser')}
              </Button>
            </form>
          ) : (
            <div className="flex flex-col items-center text-center">
              <div className="mb-4 grid size-14 place-items-center rounded-full bg-chip text-accent-text">
                <Radio className="size-7" />
              </div>
              <h1 className="display text-xl">{t('signIn.approveTitle')}</h1>
              <p className="mt-1 text-[13px] text-muted">{t('signIn.approveText')}</p>
              <div className="my-6 rounded-md border border-line bg-surface px-6 py-4 font-mono text-3xl font-bold tracking-[0.25em] text-accent-text">{link.code}</div>
              <div className="mb-5 flex items-center gap-2 text-[13px] text-muted">
                <Loader2 className="size-4 animate-spin" /> {t('signIn.waiting')}
              </div>
              <div className="flex gap-2">
                <Button onClick={cancel}>{t('common.cancel')}</Button>
                <Button variant="dark" onClick={() => void openExternal(link.verifyUrl)}>
                  <ExternalLink className="size-4" /> {t('signIn.openAgain')}
                </Button>
              </div>
            </div>
          )}
        </div>
        <p className="mt-6 text-center text-[11px] text-muted">
          RHIS Studio v{app?.version ?? '…'} · Powered by RHIS
        </p>
      </div>
    </div>
  );
}
