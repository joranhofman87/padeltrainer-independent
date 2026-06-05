import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const settingsBase = readFileSync(
  resolve(process.cwd(), 'src/components/invoices/InvoiceSettingsCardBase.tsx'),
  'utf8',
);
const academyCard = readFileSync(
  resolve(process.cwd(), 'src/components/academy/AcademyInvoiceSettingsCard.tsx'),
  'utf8',
);
const enAcademy = readFileSync(
  resolve(process.cwd(), 'src/i18n/locales/en/academy.json'),
  'utf8',
);

describe('academy invoice settings invoice_reply_to_email', () => {
  it('loads invoice_reply_to_email in settings card', () => {
    expect(settingsBase).toContain('invoice_reply_to_email');
    expect(settingsBase).toContain('setReplyToEmail(d.invoice_reply_to_email');
  });

  it('saves invoice_reply_to_email to academy_profiles', () => {
    expect(settingsBase).toContain(
      'invoice_reply_to_email: replyToEmail.trim() ? replyToEmail.trim().toLowerCase() : null',
    );
    expect(academyCard).toContain('table="academy_profiles"');
  });

  it('labels reply-to separately from forward emails', () => {
    expect(academyCard).toContain('invoiceSettings.replyToEmail');
    expect(academyCard).toContain('invoiceSettings.replyToEmailDescription');
    expect(academyCard).toContain('invoiceSettings.forwardEmails');
    expect(enAcademy).toContain('Invoice reply-to email');
    expect(enAcademy).toContain('public contact email on invoice payment pages');
  });
});
