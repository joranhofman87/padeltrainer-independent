import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InvoiceListStatusBadge } from './InvoiceListStatusBadge';

// Stub the heavy children (the tooltip lazily fires a query; the canonical badge has its own i18n).
vi.mock('./InvoiceStatusBadge', () => ({
  InvoiceStatusBadge: ({ status }: { status: string }) => <span data-testid="canonical-badge">{status}</span>,
}));
vi.mock('./InvoiceStatusBadgeTooltip', () => ({
  InvoiceStatusBadgeTooltip: ({ invoiceId, children }: { invoiceId: string; children: React.ReactNode }) => (
    <span data-testid="tooltip" data-invoice={invoiceId}>
      {children}
    </span>
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}));

describe('InvoiceListStatusBadge', () => {
  it('routes a canonical status through the shared InvoiceStatusBadge', () => {
    render(<InvoiceListStatusBadge invoiceId="inv-1" status="paid" />);
    expect(screen.getByTestId('canonical-badge')).toHaveTextContent('paid');
    // and it is wrapped in the audit-trail tooltip for that invoice.
    expect(screen.getByTestId('tooltip')).toHaveAttribute('data-invoice', 'inv-1');
  });

  it('renders the academy-only "open" state as a plain badge, not via the canonical set', () => {
    render(<InvoiceListStatusBadge invoiceId="inv-2" status="open" />);
    expect(screen.queryByTestId('canonical-badge')).not.toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('always wraps the badge in the audit-trail tooltip', () => {
    render(<InvoiceListStatusBadge invoiceId="inv-3" status="overdue" />);
    expect(screen.getByTestId('tooltip')).toBeInTheDocument();
  });
});
