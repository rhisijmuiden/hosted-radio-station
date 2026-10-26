import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { nl } from './nl';

const KEY = 'rhis-studio-lang';

function initial(): 'en' | 'nl' {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'nl') return saved;
  } catch {
    /* private mode */
  }
  return navigator.language.toLowerCase().startsWith('nl') ? 'nl' : 'en';
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, nl: { translation: nl } },
  lng: initial(),
  fallbackLng: 'en',
  supportedLngs: ['en', 'nl'],
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});
document.documentElement.lang = i18n.language;

export async function setLanguage(lng: 'en' | 'nl') {
  await i18n.changeLanguage(lng);
  try {
    localStorage.setItem(KEY, lng);
  } catch {
    /* private mode */
  }
}

export default i18n;
