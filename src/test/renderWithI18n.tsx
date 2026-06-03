import type { ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enPlayer from '@/i18n/locales/en/player.json';

const testI18n = i18n.createInstance();

void testI18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { player: enPlayer } },
  ns: ['player'],
  defaultNS: 'player',
  interpolation: { escapeValue: false },
});

export function renderWithI18n(ui: ReactElement, options?: RenderOptions) {
  return render(<I18nextProvider i18n={testI18n}>{ui}</I18nextProvider>, options);
}
