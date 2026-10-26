import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'hrs-theme';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function savedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/** Light/dark choice. Follows the system until the user picks one; the choice is remembered in this browser. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => savedTheme() ?? systemTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (savedTheme()) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setThemeState(systemTheme());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setTheme = (t: Theme) => {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private mode */
    }
    setThemeState(t);
  };
  return { theme, setTheme };
}
