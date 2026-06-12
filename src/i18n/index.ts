import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Eagerly import NL + EN (fallback) common for instant rendering.
// The heavy marketing namespace (~80KB raw per language) is lazy-loaded
// on demand via loadMarketingNamespace() — only marketing routes need it.
import nlCommon from './locales/nl/common.json';
import nlNotifications from './locales/nl/notifications.json';
import enCommon from './locales/en/common.json';
import enNotifications from './locales/en/notifications.json';

// Shipping en + nl only. Other languages were dropped (incomplete translations).
const SUPPORTED_LANGS = ['en', 'nl'] as const;
const NAMESPACES = ['common', 'marketing', 'auth', 'player', 'trainer', 'club', 'cycles', 'admin', 'academy', 'waitingList', 'onboarding'] as const;

async function loadOnboardingBundle(lang: string) {
  try {
    return (await import(`./locales/${lang}/onboarding.json`)).default;
  } catch {
    return (await import('./locales/en/onboarding.json')).default;
  }
}

// Full lazy loader for all namespaces of a language (marketing excluded — on demand only)
function createLazyLoader(lang: string) {
  return async () => {
    const [common, auth, player, trainer, club, cycles, admin, academy, waitingList, notifications, onboarding] =
      await Promise.all([
      import(`./locales/${lang}/common.json`),
      import(`./locales/${lang}/auth.json`),
      import(`./locales/${lang}/player.json`),
      import(`./locales/${lang}/trainer.json`),
      import(`./locales/${lang}/club.json`),
      import(`./locales/${lang}/cycles.json`),
      import(`./locales/${lang}/admin.json`),
      import(`./locales/${lang}/academy.json`),
      import(`./locales/${lang}/waitingList.json`),
      import(`./locales/${lang}/notifications.json`),
      loadOnboardingBundle(lang),
    ]);
    return {
      common: { ...common.default, ...notifications.default },
      auth: auth.default,
      player: player.default,
      trainer: trainer.default,
      club: club.default,
      cycles: cycles.default,
      admin: admin.default,
      academy: academy.default,
      waitingList: waitingList.default,
      onboarding,
    };
  };
}

// Lazy loader for NL non-critical namespaces only
async function loadNlExtended() {
  const [auth, player, trainer, club, cycles, admin, academy, waitingList, onboarding] = await Promise.all([
    import('./locales/nl/auth.json'),
    import('./locales/nl/player.json'),
    import('./locales/nl/trainer.json'),
    import('./locales/nl/club.json'),
    import('./locales/nl/cycles.json'),
    import('./locales/nl/admin.json'),
    import('./locales/nl/academy.json'),
    import('./locales/nl/waitingList.json'),
    loadOnboardingBundle('nl'),
  ]);
  i18n.addResourceBundle('nl', 'auth', auth.default, true, true);
  i18n.addResourceBundle('nl', 'player', player.default, true, true);
  i18n.addResourceBundle('nl', 'trainer', trainer.default, true, true);
  i18n.addResourceBundle('nl', 'club', club.default, true, true);
  i18n.addResourceBundle('nl', 'cycles', cycles.default, true, true);
  i18n.addResourceBundle('nl', 'admin', admin.default, true, true);
  i18n.addResourceBundle('nl', 'academy', academy.default, true, true);
  i18n.addResourceBundle('nl', 'waitingList', waitingList.default, true, true);
  i18n.addResourceBundle('nl', 'onboarding', onboarding, true, true);
}

// Lazy loaders for non-default languages
const lazyLoaders: Record<string, () => Promise<Record<string, any>>> = {
  en: createLazyLoader('en'),
};

// Marketing namespace loads on demand (marketing routes only), one promise per language
const marketingLoads: Record<string, Promise<void>> = {};

export function loadMarketingNamespace(lng?: string): Promise<void> {
  const base = (lng ?? i18n.language ?? 'en').split('-')[0];
  const lang = (SUPPORTED_LANGS as readonly string[]).includes(base) ? base : 'en';
  if (!marketingLoads[lang]) {
    marketingLoads[lang] = import(`./locales/${lang}/marketing.json`)
      .catch(() => import('./locales/en/marketing.json'))
      .then((bundle) => {
        i18n.addResourceBundle(lang, 'marketing', bundle.default, true, true);
      });
  }
  return marketingLoads[lang];
}

// Track which languages have had ALL namespaces loaded
// NL and EN start with only common eagerly loaded — extended namespaces are lazy
const loadedLanguages = new Set<string>();
let nlExtendedLoaded = false;
let enExtendedLoaded = false;

async function loadLanguage(lng: string): Promise<void> {
  if (lng === 'nl') {
    if (!nlExtendedLoaded) {
      nlExtendedLoaded = true;
      await loadNlExtended();
    }
    return;
  }
  if (lng === 'en') {
    if (!enExtendedLoaded) {
      enExtendedLoaded = true;
      const bundles = await lazyLoaders['en']!();
      Object.entries(bundles).forEach(([ns, resources]) => {
        i18n.addResourceBundle('en', ns, resources, true, true);
      });
    }
    return;
  }
  if (loadedLanguages.has(lng) || !lazyLoaders[lng]) return;
  
  const bundles = await lazyLoaders[lng]();
  Object.entries(bundles).forEach(([ns, resources]) => {
    i18n.addResourceBundle(lng, ns, resources, true, true);
  });
  loadedLanguages.add(lng);
}

// Detect initial language before init
const detectLanguage = (): string => {
  const pathMatch = window.location.pathname.match(/^\/(en|nl)\b/);
  if (pathMatch) return pathMatch[1];
  
  const stored = localStorage.getItem('i18nextLng');
  if (stored && SUPPORTED_LANGS.includes(stored as any)) return stored;
  
  const navLang = navigator.language?.split('-')[0];
  if (navLang && SUPPORTED_LANGS.includes(navLang as any)) return navLang;
  
  return 'en';
};

const initialLang = detectLanguage();

// Only eagerly include NL + EN common (critical path); marketing is on demand
const resources = {
  nl: {
    common: { ...nlCommon, ...nlNotifications },
  },
  en: {
    common: { ...enCommon, ...enNotifications },
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
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
    react: {
      // Re-render translated components when lazy bundles arrive (addResourceBundle)
      bindI18nStore: 'added',
    },
  });

// Load initial language (including NL extended namespaces)
// Load extended namespaces for initial language
loadLanguage(initialLang).then(() => {
  if (i18n.language !== initialLang) {
    i18n.changeLanguage(initialLang);
  }
});

// Deferred load of NL and EN extended namespaces after initial render
const deferredLangs = ['nl', 'en'].filter(l => l !== initialLang);
const loadDeferred = () => deferredLangs.forEach(l => loadLanguage(l));
if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
  (window as any).requestIdleCallback(loadDeferred);
} else {
  setTimeout(loadDeferred, 500);
}

// Auto-load language bundles on language change
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
  loadLanguage(lng);
});

export default i18n;
