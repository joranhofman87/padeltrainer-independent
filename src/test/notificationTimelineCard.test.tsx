import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// PR 7b: the compact notification timeline card. Everything it shows is already redacted
// server-side (PR 7a), so the assertions below double as a client-side PII guard: the card
// must render the REDACTED address and never a raw one, and it must SELF-HIDE when the
// viewer legitimately sees nothing (a staff viewer on a player whose rows are private).
const rpcMock = vi.fn();
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, def?: string, opts?: Record<string, unknown>) => {
      let s = def ?? _key;
      if (opts) for (const [k, v] of Object.entries(opts)) s = s.replace(`{{${k}}}`, String(v));
      return s;
    },
  }),
}));

import { InvoiceNotificationTimelineCard } from '@/components/notifications/NotificationTimelineCard';

const entry = (over: Record<string, unknown> = {}) => ({
  outbox_id: 'ob-1',
  delivery_event_id: null,
  event_type: 'booking_confirmed_staff',
  channel: 'email',
  status: 'sent',
  skip_reason: null,
  destination_redacted: 'm***@academy.nl',
  public_summary: { event_type: 'booking_confirmed_staff', sessions: 2 },
  created_at: '2027-03-01T10:00:00Z',
  scheduled_for: '2027-03-01T10:00:00Z',
  sent_at: '2027-03-01T10:01:00Z',
  failed_at: null,
  occurred_at: null,
  ...over,
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InvoiceNotificationTimelineCard invoiceId="INV-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => rpcMock.mockReset());

describe('NotificationTimelineCard', () => {
  it('renders a humanized event, its status and the REDACTED destination', async () => {
    rpcMock.mockResolvedValue({ data: [entry()], error: null });
    renderCard();
    expect(await screen.findByTestId('notification-timeline-card')).toBeInTheDocument();
    expect(screen.getByText('New booking')).toBeInTheDocument(); // booking_confirmed_staff humanized
    expect(screen.getByText('sent')).toBeInTheDocument();
    expect(screen.getByText('m***@academy.nl')).toBeInTheDocument();
  });

  it('every rendered address is REDACTED — no un-redacted address reaches the DOM', async () => {
    rpcMock.mockResolvedValue({ data: [entry()], error: null });
    const { container } = renderCard();
    await screen.findByTestId('notification-timeline-card');
    // textContent concatenates sibling nodes, so match loosely and assert the INVARIANT:
    // every address-looking token in the DOM carries the redaction marker.
    const addresses: string[] = container.textContent?.match(/[A-Za-z0-9._%+*-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every((a) => a.includes('***'))).toBe(true);
    expect(screen.getByText('m***@academy.nl')).toBeInTheDocument(); // rendered as its own node
  });

  it('surfaces a skipped row with its reason, so an undelivered notice is visible', async () => {
    rpcMock.mockResolvedValue({
      data: [entry({ status: 'skipped', skip_reason: 'no_email_contact', sent_at: null })],
      error: null,
    });
    renderCard();
    expect(await screen.findByText(/not sent: no email contact/)).toBeInTheDocument();
  });

  it('SELF-HIDES when the viewer sees no rows (no empty-card noise)', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    renderCard();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(screen.queryByTestId('notification-timeline-card')).toBeNull();
  });

  it('SELF-HIDES (never throws) when the RPC is missing — client ahead of the migration', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    renderCard();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(screen.queryByTestId('notification-timeline-card')).toBeNull();
  });

  it('calls the invoice RPC with the invoice id', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    renderCard();
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_invoice_notification_timeline', { p_invoice_id: 'INV-1' }));
  });
});
