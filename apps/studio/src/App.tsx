import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { useViewShortcuts } from './components/LayoutMenu';
import { Shell, type Page } from './components/Shell';
import { Spinner } from './components/ui';
import { startEngineEvents } from './lib/engine';
import { call } from './lib/native';
import { SessionProvider, useSession } from './lib/session';
import { getSettings } from './lib/settings';
import { useTheme } from './lib/theme';
import { ThemeContext } from './lib/theme-context';
import { AssistPage } from './pages/Assist';
import { CartsPage, loadAllCarts, PER_PAGE, triggerCart } from './pages/Carts';
import { LivePage } from './pages/Live';
import { RecordingsPage } from './pages/Recordings';
import { SettingsPage } from './pages/Settings';
import { SignInPage } from './pages/SignIn';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

// The sound card and the cart wall start with the app, also before signing in.
startEngineEvents();
void call('configure_audio', { config: getSettings().audio }).catch(() => undefined);
void call('preview_output', { output: getSettings().preview.output }).catch(() => undefined);
loadAllCarts(getSettings().carts);

function Main() {
  const { me } = useSession();
  const [page, setPage] = useState<Page>('assist');
  useViewShortcuts(() => setPage('assist'));

  // F1–F12 fire the carts of the open cart page, from every screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = /^F(\d{1,2})$/.exec(e.key);
      if (!m || e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number(m[1]);
      if (n < 1 || n > PER_PAGE) return;
      e.preventDefault();
      triggerCart(getSettings().cartPage * PER_PAGE + n - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (me === null) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }
  if (me === false) return <SignInPage />;
  return (
    <Shell page={page} onPage={setPage}>
      {page === 'assist' && <AssistPage />}
      {page === 'live' && <LivePage onPage={setPage} />}
      {page === 'carts' && <CartsPage />}
      {page === 'recordings' && <RecordingsPage />}
      {page === 'settings' && <SettingsPage />}
    </Shell>
  );
}

export function App() {
  const theme = useTheme();
  return (
    <ThemeContext.Provider value={theme}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <Main />
        </SessionProvider>
      </QueryClientProvider>
      <Toaster position="bottom-right" theme={theme.theme} richColors closeButton />
    </ThemeContext.Provider>
  );
}
