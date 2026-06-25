import type { ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18n from 'i18next';
import enCycles from '@/i18n/locales/en/cycles.json';

/**
 * RTL render helper that loads the real `cycles` namespace, so component tests assert the actual
 * translation keys (not stubs). `common:*` keys fall back to their inline defaults. Used by the
 * Phase-4 editor/slot component tests.
 */
const inst = i18n.createInstance();
void inst.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { cycles: enCycles } },
  ns: ['cycles'],
  defaultNS: 'cycles',
  interpolation: { escapeValue: false },
});

export function renderWithCycles(ui: ReactElement, options?: RenderOptions) {
  return render(<I18nextProvider i18n={inst}>{ui}</I18nextProvider>, options);
}
