import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { canSharePublicPaymentLink } from '@/lib/invoiceSettingsComplete';
import { checkInvoiceSettingsGate, buildInvoiceSettingsLabels } from '@/lib/invoiceShareGuards';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

describe('Academy invoice share rules', () => {
  const t = (key: string, fallback?: string) => fallback ?? key;
  const labels = buildInvoiceSettingsLabels(t as never, 'academy');

  it('draft invoice is not public-shareable', () => {
    expect(
      canSharePublicPaymentLink({
        status: 'draft',
        sent_at: null,
        public_token: 'abc',
      }),
    ).toBe(false);
  });

  it('sent invoice with token is public-shareable', () => {
    expect(
      canSharePublicPaymentLink({
        status: 'sent',
        sent_at: '2026-01-01',
        public_token: 'abc',
      }),
    ).toBe(true);
  });

  it('incomplete settings block send/share gate', () => {
    const gate = checkInvoiceSettingsGate(
      { business_name: 'Academy', business_address: '', kvk_number: '', iban: '' },
      labels,
      'Complete your invoice settings before sending this invoice. Missing:',
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.message).toContain('Complete your invoice settings');
      expect(gate.missing).toContain('business_address');
    }
  });
});

/** Minimal UI: draft row must not offer copy-link menu item label. */
describe('Share dropdown copy link visibility', () => {
  function ShareMenuPreview({
    invoice,
  }: {
    invoice: { status: string; sent_at: string | null; public_token: string };
  }) {
    const shareable = canSharePublicPaymentLink(invoice);
    const isDraft = invoice.status === 'draft';
    return (
      <div>
        {shareable ? <button type="button">Copy payment link</button> : null}
        {isDraft && !shareable ? <span>Draft share hint</span> : null}
      </div>
    );
  }

  it('draft invoice row does not render copy payment link', () => {
    render(
      <ShareMenuPreview
        invoice={{ status: 'draft', sent_at: null, public_token: 'tok' }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Copy payment link' })).not.toBeInTheDocument();
    expect(screen.getByText('Draft share hint')).toBeInTheDocument();
  });

  it('sent invoice row renders copy payment link', () => {
    render(
      <ShareMenuPreview
        invoice={{ status: 'sent', sent_at: '2026-01-01', public_token: 'tok' }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Copy payment link' })).toBeInTheDocument();
  });
});
