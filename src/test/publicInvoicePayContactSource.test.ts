import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const paySource = readFileSync(
  resolve(process.cwd(), 'src/pages/PublicInvoicePay.tsx'),
  'utf8',
);

describe('PublicInvoicePay contact source', () => {
  it('uses resolvePublicInvoiceContactEmail for footer', () => {
    expect(paySource).toContain('resolvePublicInvoiceContactEmail');
    expect(paySource).toContain('publicContactEmail');
    expect(paySource).not.toMatch(/questionsContact[\s\S]{0,200}academy\.contactEmail/);
  });

  it('types academy with invoiceReplyToEmail', () => {
    expect(paySource).toContain('invoiceReplyToEmail: string | null');
  });
});
