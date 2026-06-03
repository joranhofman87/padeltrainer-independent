/** Fields required before sending or sharing invoices (matches InvoiceSettingsCardBase). */
export type InvoiceSettingsSnapshot = {
  business_name?: string | null;
  business_address?: string | null;
  kvk_number?: string | null;
  iban?: string | null;
};

export type InvoiceSettingsFieldKey =
  | 'business_name'
  | 'business_address'
  | 'kvk_number'
  | 'iban';

const REQUIRED_FIELDS: InvoiceSettingsFieldKey[] = [
  'business_name',
  'business_address',
  'kvk_number',
  'iban',
];

export function getMissingInvoiceSettingsFields(
  settings: InvoiceSettingsSnapshot | null | undefined,
): InvoiceSettingsFieldKey[] {
  if (!settings) return [...REQUIRED_FIELDS];
  return REQUIRED_FIELDS.filter((key) => {
    const value = settings[key];
    return typeof value !== 'string' || value.trim() === '';
  });
}

export function isInvoiceSettingsComplete(
  settings: InvoiceSettingsSnapshot | null | undefined,
): boolean {
  return getMissingInvoiceSettingsFields(settings).length === 0;
}

/** Whether a public /pay/:token link may be copied or opened by recipients. */
export function canSharePublicPaymentLink(invoice: {
  status: string;
  sent_at: string | null;
  public_token?: string | null;
}): boolean {
  if (invoice.status === 'draft' || invoice.status === 'paid' || invoice.status === 'cancelled') {
    return false;
  }
  if (!invoice.public_token) return false;
  return !!invoice.sent_at || invoice.status === 'sent';
}

export function isDraftInvoiceStatus(status: string): boolean {
  return status === 'draft';
}
