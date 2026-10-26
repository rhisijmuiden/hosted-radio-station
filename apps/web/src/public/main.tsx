import { Radio } from 'lucide-react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './public.css';
import { PoweredBy } from './components';
import { HistoryEmbed, PlayerEmbed, RequestsEmbed } from './Embeds';
import { LangContext, useAccent, useLanguageState, useNowPlaying, useT, useThemeState } from './lib';
import { StationPage } from './StationPage';

/** /public/<station> is the station page; /public/<station>/embed/<widget> are the widgets for other websites. */
const [, , rawSlug = '', section, widget] = location.pathname.split('/');
const slug = decodeURIComponent(rawSlug).toLowerCase();
const embed = section === 'embed' ? (widget ?? 'player') : null;
if (embed) document.documentElement.classList.add('embed');
if (embed && new URLSearchParams(location.search).get('transparent') === '1') document.documentElement.classList.add('transparent');

function Message({ title, text }: { title: string; text?: string }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <span className="grid size-12 place-items-center rounded-full bg-chip text-accent-text">
          <Radio className="size-6" />
        </span>
        <h1 className="display text-lg">{title}</h1>
        {text && <p className="max-w-sm text-[13px] text-muted">{text}</p>}
        {!embed && <PoweredBy className="mt-4" />}
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="grid h-full place-items-center">
      <span className="size-8 animate-spin rounded-full border-2 border-line border-t-[var(--station)]" />
    </div>
  );
}

function Page() {
  const t = useT();
  const { data, error } = useNowPlaying(slug);
  const { theme, setTheme } = useThemeState(data?.station.theme);
  useAccent(data?.station.accentColor);
  if (error === 404 || !slug) return <Message title={t('notFound')} text={t('notFoundText')} />;
  if (!data) return <Loading />;
  if (embed === 'history') return <HistoryEmbed np={data} />;
  if (embed === 'requests') return <RequestsEmbed np={data} />;
  if (embed) return <PlayerEmbed np={data} />;
  return <StationPage np={data} theme={theme} setTheme={setTheme} />;
}

function Root() {
  const lang = useLanguageState();
  return (
    <LangContext.Provider value={lang}>
      <Page />
    </LangContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
