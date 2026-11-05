import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import './i18n';
import './styles.css';
import { App } from './App';
import { ReportersWindowApp } from './components/Reporters';
import { useTheme } from './lib/theme';
import { ThemeContext } from './lib/theme-context';

// No browser context menu in the app (right-click is not a feature of the studio screens).
if ('__TAURI_INTERNALS__' in window) window.addEventListener('contextmenu', (e) => e.preventDefault());

/** The reporters window (second screen): the same build, another view. */
function ReportersRoot() {
  const theme = useTheme();
  return (
    <ThemeContext.Provider value={theme}>
      <ReportersWindowApp />
      <Toaster position="bottom-right" theme={theme.theme} richColors closeButton />
    </ThemeContext.Provider>
  );
}

const view = new URLSearchParams(window.location.search).get('view');

createRoot(document.getElementById('root')!).render(<StrictMode>{view === 'reporters' ? <ReportersRoot /> : <App />}</StrictMode>);
