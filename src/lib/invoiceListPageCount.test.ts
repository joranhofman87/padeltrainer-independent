import { describe, it, expect } from 'vitest';
import { INVOICE_PAGE_SIZE, invoiceListPageCount } from './invoicesList';

describe('invoiceListPageCount', () => {
  it('returns at least 1 even when empty', () => {
    expect(invoiceListPageCount(0)).toBe(1);
  });

  it('returns 1 for a partial single page', () => {
    expect(invoiceListPageCount(1)).toBe(1);
    expect(invoiceListPageCount(INVOICE_PAGE_SIZE)).toBe(1);
  });

  it('rolls to the next page one row over a page boundary', () => {
    expect(invoiceListPageCount(INVOICE_PAGE_SIZE + 1)).toBe(2);
  });

  it('ceils to whole pages', () => {
    expect(invoiceListPageCount(INVOICE_PAGE_SIZE * 3)).toBe(3);
    expect(invoiceListPageCount(INVOICE_PAGE_SIZE * 3 + 1)).toBe(4);
  });
});
