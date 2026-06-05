import { describe, it, expect } from 'vitest';
import { buildTrainerInvoiceEditPath } from './trainerPlayerDetailNavigation';

describe('buildTrainerInvoiceEditPath', () => {
  it('builds trainer invoice edit route', () => {
    expect(buildTrainerInvoiceEditPath('inv-abc')).toBe('/app/trainer/invoices/inv-abc/edit');
  });
});
