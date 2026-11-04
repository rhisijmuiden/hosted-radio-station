import clsx from 'clsx';
import { Moon, Sun } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Me } from '../lib/api';
import { useThemeContext } from '../lib/theme-context';
import { setLanguage } from '../i18n';

export function ThemeToggle() {
  const { theme, setTheme } = useThemeContext();
  const { t } = useTranslation();
  const options = [
    { value: 'light' as const, icon: Sun, label: t('theme.light') },
    { value: 'dark' as const, icon: Moon, label: t('theme.dark') },
  ];
  return (
    <div className="flex rounded-full border border-line p-0.5" role="radiogroup" aria-label={t('theme.label')}>
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          role="radio"
          aria-checked={theme === value}
          title={label}
          onClick={() => setTheme(value)}
          className={clsx('grid h-6 w-7 place-items-center rounded-full transition-colors', theme === value ? 'bg-[var(--nav-active-bg)]' : 'hover:bg-hover')}
        >
          <Icon className={clsx('size-3.5', theme === value ? 'text-koraal' : 'text-muted')} strokeWidth={2} />
        </button>
      ))}
    </div>
  );
}

export function LanguageToggle() {
  const { i18n, t } = useTranslation();
  const qc = useQueryClient();
  const current = i18n.language.startsWith('nl') ? 'nl' : 'en';
  const choose = async (lng: 'en' | 'nl') => {
    await setLanguage(lng);
    qc.setQueryData<Me>(['me'], (old) => (old ? { ...old, user: { ...old.user, locale: lng } } : old));
  };
  return (
    <div className="flex rounded-full border border-line p-0.5 text-[11px] font-semibold" role="radiogroup" aria-label={t('language.label')}>
      {(['en', 'nl'] as const).map((lng) => (
        <button
          key={lng}
          role="radio"
          aria-checked={current === lng}
          onClick={() => void choose(lng)}
          className={clsx('h-6 rounded-full px-2 uppercase transition-colors', current === lng ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'text-muted hover:bg-hover')}
        >
          {lng}
        </button>
      ))}
    </div>
  );
}

