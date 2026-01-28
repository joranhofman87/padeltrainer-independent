import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from './locales/en/common.json';
import enMarketing from './locales/en/marketing.json';
import enAuth from './locales/en/auth.json';
import enPlayer from './locales/en/player.json';
import enTrainer from './locales/en/trainer.json';
import enClub from './locales/en/club.json';
import enCycles from './locales/en/cycles.json';
import enAdmin from './locales/en/admin.json';
import enAcademy from './locales/en/academy.json';

import nlCommon from './locales/nl/common.json';
import nlMarketing from './locales/nl/marketing.json';
import nlAuth from './locales/nl/auth.json';
import nlPlayer from './locales/nl/player.json';
import nlTrainer from './locales/nl/trainer.json';
import nlClub from './locales/nl/club.json';
import nlCycles from './locales/nl/cycles.json';
import nlAdmin from './locales/nl/admin.json';
import nlAcademy from './locales/nl/academy.json';

const resources = {
  en: {
    common: enCommon,
    marketing: enMarketing,
    auth: enAuth,
    player: enPlayer,
    trainer: enTrainer,
    club: enClub,
    cycles: enCycles,
    admin: enAdmin,
    academy: enAcademy,
  },
  nl: {
    common: nlCommon,
    marketing: nlMarketing,
    auth: nlAuth,
    player: nlPlayer,
    trainer: nlTrainer,
    club: nlClub,
    cycles: nlCycles,
    admin: nlAdmin,
    academy: nlAcademy,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'nl', // Default to Dutch for Netherlands-focused service
    defaultNS: 'common',
    ns: ['common', 'marketing', 'auth', 'player', 'trainer', 'club', 'cycles', 'admin', 'academy'],
    detection: {
      // For marketing pages, URL takes precedence; for app pages, localStorage
      order: ['path', 'localStorage', 'navigator'],
      lookupFromPathIndex: 0,
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
