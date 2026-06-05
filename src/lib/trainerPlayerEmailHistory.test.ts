import { describe, it, expect } from 'vitest';
import {
  buildTrainerInvoiceEmailEvents,
  filterInvoicesForTrainer,
} from './trainerPlayerEmailHistory';

const labels = {
  sent: 'Invoice sent',
  sentWithNumber: (n: string) => `Invoice #${n}`,
};

describe('filterInvoicesForTrainer', () => {
  it('keeps invoices for the current trainer only', () => {
    const filtered = filterInvoicesForTrainer(
      [
        { id: 'a', invoice_number: '1', sent_at: '2026-01-01', status: 'sent', trainer_id: 'tr-1' },
        { id: 'b', invoice_number: '2', sent_at: '2026-01-02', status: 'sent', trainer_id: 'tr-2' },
      ],
      'tr-1',
    );
    expect(filtered.map((i) => i.id)).toEqual(['a']);
  });
});

describe('buildTrainerInvoiceEmailEvents', () => {
  it('links invoice sent events to trainer invoice edit page', () => {
    const events = buildTrainerInvoiceEmailEvents(
      [{ id: 'inv-1', invoice_number: '26000421', sent_at: '2026-02-01T10:00:00Z', status: 'sent', trainer_id: 'tr-1' }],
      labels,
    );

    expect(events).toHaveLength(1);
    expect(events[0].href).toBe('/app/trainer/invoices/inv-1/edit');
    expect(events[0].title).toBe('Invoice #26000421');
  });
});
