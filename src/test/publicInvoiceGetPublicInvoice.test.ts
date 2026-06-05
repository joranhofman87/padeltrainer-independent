import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(process.cwd(), 'supabase/functions/get-public-invoice/index.ts'),
  'utf8',
);

describe('get-public-invoice academy payload', () => {
  it('selects invoice_reply_to_email from academy_profiles', () => {
    expect(source).toContain('invoice_reply_to_email');
  });

  it('exposes invoiceReplyToEmail on academy payload', () => {
    expect(source).toContain('invoiceReplyToEmail: academy.invoice_reply_to_email');
  });

  it('does not expose invoice_forward_emails', () => {
    expect(source).not.toContain('invoice_forward_emails');
    expect(source).not.toContain('forwardEmails');
  });

  it('still exposes general contactEmail separately', () => {
    expect(source).toContain('contactEmail: academy.contact_email');
  });
});
