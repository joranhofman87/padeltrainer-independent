import type { TFunction } from 'i18next';
import {
  getMissingInvoiceSettingsFields,
  isInvoiceSettingsComplete,
  type InvoiceSettingsFieldKey,
  type InvoiceSettingsSnapshot,
} from '@/lib/invoiceSettingsComplete';

export type InvoiceSettingsLabels = Record<InvoiceSettingsFieldKey, string>;

export function buildInvoiceSettingsLabels(
  t: TFunction,
  namespace: 'academy' | 'trainer',
): InvoiceSettingsLabels {
  const prefix = namespace === 'academy' ? 'invoiceSettings' : 'invoices.settings';
  return {
    business_name: t(`${prefix}.businessName`, 'Business name'),
    business_address: t(`${prefix}.businessAddress`, 'Business address'),
    kvk_number: t(`${prefix}.kvkNumber`, 'KvK number'),
    iban: t(`${prefix}.iban`, 'IBAN'),
  };
}

/** Trainer invoice settings card labels (invoices.* keys). */
export function buildTrainerInvoiceSettingsLabels(t: TFunction): InvoiceSettingsLabels {
  return {
    business_name: t('invoices.businessName', 'Business name'),
    business_address: t('invoices.businessAddress', 'Business address'),
    kvk_number: t('invoices.kvkNumber', 'KvK number'),
    iban: t('invoices.iban', 'IBAN'),
  };
}

export function formatMissingSettingsMessage(
  missing: InvoiceSettingsFieldKey[],
  labels: InvoiceSettingsLabels,
): string {
  return missing.map((key) => labels[key]).join(', ');
}

export type InvoiceSettingsGateResult =
  | { ok: true }
  | { ok: false; missing: InvoiceSettingsFieldKey[]; message: string };

export function checkInvoiceSettingsGate(
  settings: InvoiceSettingsSnapshot | null | undefined,
  labels: InvoiceSettingsLabels,
  warningMessage: string,
): InvoiceSettingsGateResult {
  if (isInvoiceSettingsComplete(settings)) {
    return { ok: true };
  }
  const missing = getMissingInvoiceSettingsFields(settings);
  const fields = formatMissingSettingsMessage(missing, labels);
  return {
    ok: false,
    missing,
    message: `${warningMessage} ${fields}`,
  };
}
