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
import enWaitingList from './locales/en/waitingList.json';
import enNotifications from './locales/en/notifications.json';

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

import esCommon from './locales/es/common.json';
import esMarketing from './locales/es/marketing.json';
import esAuth from './locales/es/auth.json';
import esPlayer from './locales/es/player.json';
import esTrainer from './locales/es/trainer.json';
import esClub from './locales/es/club.json';
import esCycles from './locales/es/cycles.json';
import esAdmin from './locales/es/admin.json';
import esAcademy from './locales/es/academy.json';
import esWaitingList from './locales/es/waitingList.json';
import esNotifications from './locales/es/notifications.json';

import deCommon from './locales/de/common.json';
import deMarketing from './locales/de/marketing.json';
import deAuth from './locales/de/auth.json';
import dePlayer from './locales/de/player.json';
import deTrainer from './locales/de/trainer.json';
import deClub from './locales/de/club.json';
import deCycles from './locales/de/cycles.json';
import deAdmin from './locales/de/admin.json';
import deAcademy from './locales/de/academy.json';
import deWaitingList from './locales/de/waitingList.json';
import deNotifications from './locales/de/notifications.json';

import frCommon from './locales/fr/common.json';
import frMarketing from './locales/fr/marketing.json';
import frAuth from './locales/fr/auth.json';
import frPlayer from './locales/fr/player.json';
import frTrainer from './locales/fr/trainer.json';
import frClub from './locales/fr/club.json';
import frCycles from './locales/fr/cycles.json';
import frAdmin from './locales/fr/admin.json';
import frAcademy from './locales/fr/academy.json';
import frWaitingList from './locales/fr/waitingList.json';
import frNotifications from './locales/fr/notifications.json';

const resources = {
  en: {
    common: { ...enCommon, ...enNotifications },
    marketing: enMarketing,
    auth: enAuth,
    player: enPlayer,
    trainer: enTrainer,
    club: enClub,
    cycles: enCycles,
    admin: enAdmin,
    academy: enAcademy,
    waitingList: enWaitingList,
  },
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
  es: {
    common: { ...esCommon, ...esNotifications },
    marketing: esMarketing,
    auth: esAuth,
    player: esPlayer,
    trainer: esTrainer,
    club: esClub,
    cycles: esCycles,
    admin: esAdmin,
    academy: esAcademy,
    waitingList: esWaitingList,
  },
  de: {
    common: { ...deCommon, ...deNotifications },
    marketing: deMarketing,
    auth: deAuth,
    player: dePlayer,
    trainer: deTrainer,
    club: deClub,
    cycles: deCycles,
    admin: deAdmin,
    academy: deAcademy,
    waitingList: deWaitingList,
  },
  fr: {
    common: { ...frCommon, ...frNotifications },
    marketing: frMarketing,
    auth: frAuth,
    player: frPlayer,
    trainer: frTrainer,
    club: frClub,
    cycles: frCycles,
    admin: frAdmin,
    academy: frAcademy,
    waitingList: frWaitingList,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'nl',
    defaultNS: 'common',
    ns: ['common', 'marketing', 'auth', 'player', 'trainer', 'club', 'cycles', 'admin', 'academy', 'waitingList'],
    detection: {
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
