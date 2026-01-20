import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from './locales/en/common.json';
import enMarketing from './locales/en/marketing.json';
import enAuth from './locales/en/auth.json';
import enPlayer from './locales/en/player.json';
import enTrainer from './locales/en/trainer.json';
import enClub from './locales/en/club.json';

import nlCommon from './locales/nl/common.json';
import nlMarketing from './locales/nl/marketing.json';
import nlAuth from './locales/nl/auth.json';
import nlPlayer from './locales/nl/player.json';
import nlTrainer from './locales/nl/trainer.json';
import nlClub from './locales/nl/club.json';

const resources = {
  en: {
    common: enCommon,
    marketing: enMarketing,
    auth: enAuth,
    player: enPlayer,
    trainer: enTrainer,
    club: enClub,
  },
  nl: {
    common: nlCommon,
    marketing: nlMarketing,
    auth: nlAuth,
    player: nlPlayer,
    trainer: nlTrainer,
    club: nlClub,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common', 'marketing', 'auth', 'player', 'trainer', 'club'],
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
    interpolation: {
      escapeValue: false,
    },
  });

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});

export default i18n;
