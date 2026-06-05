import { describe, it, expect } from 'vitest';
import {
  buildInvoiceEmailEvents,
  filterInvoicesForAcademy,
  mapCampaignEmailEvents,
  mergePlayerEmailHistory,
} from './academyPlayerEmailHistory';

const labels = {
  sent: 'Invoice sent',
  sentWithNumber: (n: string) => `Invoice #${n}`,
};

describe('buildInvoiceEmailEvents', () => {
  it('creates sent event when sent_at exists', () => {
    const events = buildInvoiceEmailEvents(
      [{ id: 'inv-1', invoice_number: '26000421', sent_at: '2026-02-01T10:00:00Z', status: 'sent' }],
      labels,
    );

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Invoice #26000421');
    expect(events[0].href).toBe('/app/academy/invoices/inv-1/edit');
    expect(events[0].status).toBe('sent');
  });

  it('omits invoices without sent_at', () => {
    const events = buildInvoiceEmailEvents(
      [{ id: 'inv-2', invoice_number: '99', sent_at: null, status: 'draft' }],
      labels,
    );
    expect(events).toHaveLength(0);
  });
});

describe('filterInvoicesForAcademy', () => {
  it('keeps invoices for the current academy only', () => {
    const filtered = filterInvoicesForAcademy(
      [
        { id: 'a', invoice_number: '1', sent_at: '2026-01-01', status: 'sent', academy_profile_id: 'ac-1' },
        { id: 'b', invoice_number: '2', sent_at: '2026-01-02', status: 'sent', academy_profile_id: 'ac-2' },
      ],
      'ac-1',
    );
    expect(filtered.map((i) => i.id)).toEqual(['a']);
  });
});

describe('mergePlayerEmailHistory', () => {
  it('sorts campaign and invoice events chronologically (newest first)', () => {
    const campaign = mapCampaignEmailEvents([
      {
        id: 'c1',
        subject: 'Welcome',
        status: 'sent',
        sent_at: '2026-01-10T12:00:00Z',
        created_at: '2026-01-10T11:00:00Z',
      },
    ]);
    const invoice = buildInvoiceEmailEvents(
      [{ id: 'inv-1', invoice_number: '100', sent_at: '2026-02-01T10:00:00Z', status: 'sent' }],
      labels,
    );

    const merged = mergePlayerEmailHistory(campaign, invoice);
    expect(merged[0].source).toBe('invoice');
    expect(merged[1].source).toBe('campaign');
  });
});
