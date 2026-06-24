import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards slice 2 of the frontend reuse-hardening sprint: the trainer + academy invoice LIST pages
 * must consume the shared list scaffold (useInvoiceListSort / useInvoiceListSelection /
 * InvoiceListPagination / invoiceListPageCount) instead of re-inlining the sort mapping, the
 * selection Set logic, or the windowed pager. If a future edit re-inlines one role, this fails.
 */
const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

const pages = ['pages/trainer/TrainerInvoices.tsx', 'pages/academy/AcademyInvoices.tsx'];

describe.each(pages)('%s uses the shared invoice-list scaffold', (page) => {
  const source = read(page);

  it('uses the shared sort, selection and pagination scaffold', () => {
    expect(source).toContain('useInvoiceListSort');
    expect(source).toContain('useInvoiceListSelection');
    expect(source).toContain('InvoiceListPagination');
    expect(source).toContain('invoiceListPageCount');
  });

  it('uses the shared table, stat tiles and status badge', () => {
    expect(source).toContain('InvoiceListTable');
    expect(source).toContain('InvoiceStatTiles');
    expect(source).toContain('InvoiceListStatusBadge');
  });

  it('no longer imports useTableSort or the raw Pagination/Table primitives directly', () => {
    expect(source).not.toContain('@/hooks/useTableSort');
    expect(source).not.toContain('@/components/ui/pagination');
    expect(source).not.toContain('PaginationPrevious');
    // the desktop table now lives in InvoiceListTable, not hand-rolled in the page.
    // (exact quoted path so it doesn't match @/components/ui/table-toolbar)
    expect(source).not.toContain('"@/components/ui/table"');
    expect(source).not.toContain('dataTableCardContentClass');
  });

  it('no longer re-inlines the selection Set mutation logic', () => {
    expect(source).not.toContain('const toggleSelectAllVisible =');
    expect(source).not.toContain('const toggleSelect =');
  });
});
