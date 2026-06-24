import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards Slice 1 of the frontend reuse-hardening sprint: the four invoice form pages must consume
 * the shared `InvoiceLineItemsEditor` / `InvoiceTotalsSummary` components and the shared
 * `invoiceFormTotals` math, instead of re-inlining the line-items grid or the VAT useMemo. If a
 * future (AI) edit re-inlines one role's form, one of these assertions fails.
 */
const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

const createPages = [
  'pages/trainer/TrainerCreateInvoice.tsx',
  'pages/academy/AcademyCreateInvoice.tsx',
];
const editPages = [
  'pages/trainer/TrainerEditInvoice.tsx',
  'pages/academy/AcademyEditInvoice.tsx',
];

describe.each([...createPages, ...editPages])('%s uses the shared invoice form components', (page) => {
  const source = read(page);

  it('renders the shared line-items editor', () => {
    expect(source).toContain('InvoiceLineItemsEditor');
  });

  it('renders the shared totals summary', () => {
    expect(source).toContain('InvoiceTotalsSummary');
  });

  it('does not re-inline the line-items grid template', () => {
    expect(source).not.toContain('grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem]');
  });
});

describe.each(createPages)('%s uses the shared create-invoice math', (page) => {
  const source = read(page);
  it('calls computeCreateInvoiceTotals and not an inline useMemo', () => {
    expect(source).toContain('computeCreateInvoiceTotals');
    expect(source).not.toContain('hasMultipleRates');
  });
});

describe.each(editPages)('%s uses the shared edit-invoice math', (page) => {
  const source = read(page);
  it('calls computeEditInvoiceTotals and not an inline useMemo', () => {
    expect(source).toContain('computeEditInvoiceTotals');
    expect(source).not.toContain('hasPerItemVat');
  });
});
