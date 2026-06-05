import { describe, it, expect } from 'vitest';
import {
  buildAcademyInvoiceEditPath,
  buildAcademyInvoicesListPath,
} from './academyPlayerDetailNavigation';

describe('academyPlayerDetailNavigation', () => {
  it('builds academy invoice edit path', () => {
    expect(buildAcademyInvoiceEditPath('inv-uuid-1')).toBe(
      '/app/academy/invoices/inv-uuid-1/edit',
    );
  });

  it('builds academy invoices list fallback path', () => {
    expect(buildAcademyInvoicesListPath()).toBe('/app/academy/invoices');
  });
});
