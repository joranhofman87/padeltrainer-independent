import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Only import the default/fallback language eagerly
import nlCommon from './locales/nl/common.json';
import nlMarketing from './locales/nl/marketing.json';
import nlAuth from './locales/nl/auth.json';
import nlPlayer from './locales/nl/player.json';
import nlTrainer from './locales/nl/trainer.json';
import nlClub from './locales/nl/club.json';
import nlCycles from './locales/nl/cycles.json';
import nlAdmin from './locales/nl/admin.json';
import nlAcademy from './locales/nl/academy.json';
import nlWaitingList from './locales/nl/waitingList.json';
import nlNotifications from './locales/nl/notifications.json';

const SUPPORTED_LANGS = ['en', 'nl', 'es', 'de', 'fr'] as const;
const NAMESPACES = ['common', 'marketing', 'auth', 'player', 'trainer', 'club', 'cycles', 'admin', 'academy', 'waitingList'] as const;

// Lazy loaders for non-default languages
const lazyLoaders: Record<string, () => Promise<Record<string, any>>> = {
  en: async () => {
    const [common, marketing, auth, player, trainer, club, cycles, admin, academy, waitingList, notifications] = await Promise.all([
      import('./locales/en/common.json'),
      import('./locales/en/marketing.json'),
      import('./locales/en/auth.json'),
      import('./locales/en/player.json'),
      import('./locales/en/trainer.json'),
      import('./locales/en/club.json'),
      import('./locales/en/cycles.json'),
      import('./locales/en/admin.json'),
      import('./locales/en/academy.json'),
      import('./locales/en/waitingList.json'),
      import('./locales/en/notifications.json'),
    ]);
    return {
      common: { ...common.default, ...notifications.default },
      marketing: marketing.default,
      auth: auth.default,
      player: player.default,
      trainer: trainer.default,
      club: club.default,
      cycles: cycles.default,
      admin: admin.default,
      academy: academy.default,
      waitingList: waitingList.default,
    };
  },
  es: async () => {
    const [common, marketing, auth, player, trainer, club, cycles, admin, academy, waitingList, notifications] = await Promise.all([
      import('./locales/es/common.json'),
      import('./locales/es/marketing.json'),
      import('./locales/es/auth.json'),
      import('./locales/es/player.json'),
      import('./locales/es/trainer.json'),
      import('./locales/es/club.json'),
      import('./locales/es/cycles.json'),
      import('./locales/es/admin.json'),
      import('./locales/es/academy.json'),
      import('./locales/es/waitingList.json'),
      import('./locales/es/notifications.json'),
    ]);
    return {
      common: { ...common.default, ...notifications.default },
      marketing: marketing.default,
      auth: auth.default,
      player: player.default,
      trainer: trainer.default,
      club: club.default,
      cycles: cycles.default,
      admin: admin.default,
      academy: academy.default,
      waitingList: waitingList.default,
    };
  },
  de: async () => {
    const [common, marketing, auth, player, trainer, club, cycles, admin, academy, waitingList, notifications] = await Promise.all([
      import('./locales/de/common.json'),
      import('./locales/de/marketing.json'),
      import('./locales/de/auth.json'),
      import('./locales/de/player.json'),
      import('./locales/de/trainer.json'),
      import('./locales/de/club.json'),
      import('./locales/de/cycles.json'),
      import('./locales/de/admin.json'),
      import('./locales/de/academy.json'),
      import('./locales/de/waitingList.json'),
      import('./locales/de/notifications.json'),
    ]);
    return {
      common: { ...common.default, ...notifications.default },
      marketing: marketing.default,
      auth: auth.default,
      player: player.default,
      trainer: trainer.default,
      club: club.default,
      cycles: cycles.default,
      admin: admin.default,
      academy: academy.default,
      waitingList: waitingList.default,
    };
  },
  fr: async () => {
    const [common, marketing, auth, player, trainer, club, cycles, admin, academy, waitingList, notifications] = await Promise.all([
      import('./locales/fr/common.json'),
      import('./locales/fr/marketing.json'),
      import('./locales/fr/auth.json'),
      import('./locales/fr/player.json'),
      import('./locales/fr/trainer.json'),
      import('./locales/fr/club.json'),
      import('./locales/fr/cycles.json'),
      import('./locales/fr/admin.json'),
      import('./locales/fr/academy.json'),
      import('./locales/fr/waitingList.json'),
      import('./locales/fr/notifications.json'),
    ]);
    return {
      common: { ...common.default, ...notifications.default },
      marketing: marketing.default,
      auth: auth.default,
      player: player.default,
      trainer: trainer.default,
      club: club.default,
      cycles: cycles.default,
      admin: admin.default,
      academy: academy.default,
      waitingList: waitingList.default,
    };
  },
};

// Track which languages have been loaded
const loadedLanguages = new Set<string>(['nl']);

async function loadLanguage(lng: string): Promise<void> {
  if (loadedLanguages.has(lng) || !lazyLoaders[lng]) return;
  
  const bundles = await lazyLoaders[lng]();
  Object.entries(bundles).forEach(([ns, resources]) => {
    i18n.addResourceBundle(lng, ns, resources, true, true);
  });
  loadedLanguages.add(lng);
}

// Detect initial language before init
const detectLanguage = (): string => {
  // Check path first
  const pathMatch = window.location.pathname.match(/^\/(en|nl|es|de|fr)\b/);
  if (pathMatch) return pathMatch[1];
  
  // Check localStorage
  const stored = localStorage.getItem('i18nextLng');
  if (stored && SUPPORTED_LANGS.includes(stored as any)) return stored;
  
  // Check navigator
  const navLang = navigator.language?.split('-')[0];
  if (navLang && SUPPORTED_LANGS.includes(navLang as any)) return navLang;
  
  return 'nl';
};

const initialLang = detectLanguage();

// Only include NL resources eagerly; load detected language async if different
const resources = {
  nl: {
    common: { ...nlCommon, ...nlNotifications },
    marketing: nlMarketing,
    auth: nlAuth,
    player: nlPlayer,
    trainer: nlTrainer,
    club: nlClub,
    cycles: nlCycles,
    admin: nlAdmin,
    academy: nlAcademy,
    waitingList: nlWaitingList,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'nl',
    defaultNS: 'common',
    ns: [...NAMESPACES],
    detection: {
      order: ['path', 'localStorage', 'navigator'],
      lookupFromPathIndex: 0,
      caches: ['localStorage'],
    },
    interpolation: {
      escapeValue: false,
    },
  });

// Load initial language if not NL
if (initialLang !== 'nl') {
  loadLanguage(initialLang).then(() => {
    if (i18n.language !== initialLang) {
      i18n.changeLanguage(initialLang);
    }
  });
}

// Auto-load language bundles on language change
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
  loadLanguage(lng);
});

export default i18n;
