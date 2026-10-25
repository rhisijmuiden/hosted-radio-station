import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { nl } from './nl';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, nl: { translation: nl } },
    fallbackLng: 'en',
    supportedLngs: ['en', 'nl'],
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: { order: ['localStorage', 'navigator'], lookupLocalStorage: 'hrs-lang', caches: ['localStorage'] },
  });

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});

/** Switches the interface language and, when signed in, remembers it on the account. */
export async function setLanguage(lng: 'en' | 'nl', saveToAccount = true) {
  await i18n.changeLanguage(lng);
  if (saveToAccount) {
    await fetch('/api/auth/me', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: lng }),
    }).catch(() => undefined);
  }
}

export default i18n;
