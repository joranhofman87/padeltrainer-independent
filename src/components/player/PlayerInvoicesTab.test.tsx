import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PlayerInvoicesTab } from './PlayerInvoicesTab';
import { SIGNUP_CLAIM_SOURCE_STORAGE_KEY } from '@/lib/signupClaimFlow';
import { mockSessionStorage, mockSignupLocalStorage } from '@/test/signupPageFreeze';

const fromMock = vi.fn();
// Phase 3.5a: the component fetches via the person-keyed get_my_invoices RPC first
// (falling back to the direct query when the RPC errors).
const rpcMock = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

const trackEventMock = vi.fn();

vi.mock('@/lib/tracking', () => ({
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrParams?: string | Record<string, unknown>) => {
      const map: Record<string, string> = {
        'playerInvoices.empty.title': 'No invoices',
        'playerInvoices.empty.description': 'Default empty description',
        'playerInvoices.empty.claimLead': 'No invoices found yet.',
        'playerInvoices.empty.claimStep1':
          'Make sure you created your account using the same email address that was used on your invoice.',
        'playerInvoices.empty.claimStep2':
          'If you used another email address, log out and create an account using the invoice email address, or contact your trainer or academy.',
        'playerInvoices.loadError': 'Load error',
        'playerInvoices.status.draft': 'Draft',
        'playerInvoices.status.sent': 'Sent',
        'playerInvoices.status.paid': 'Paid',
        'playerInvoices.status.overdue': 'Overdue',
        'playerInvoices.labels.date': 'Date',
        'playerInvoices.labels.due': 'Due',
        'playerInvoices.labels.paid': 'Paid',
        'playerInvoices.labels.vatIncluded': 'VAT',
      };
      if (map[key]) return map[key];
      if (typeof fallbackOrParams === 'string') return fallbackOrParams;
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('PlayerInvoicesTab empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackEventMock.mockClear();
    mockSignupLocalStorage();
    mockSessionStorage();
    localStorage.clear();
    sessionStorage.clear();
    rpcMock.mockResolvedValue({ data: [], error: null });
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          neq: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    });
  });

  it('shows default empty copy for normal users', async () => {
    render(<PlayerInvoicesTab profileId="profile-1" />);
    await waitFor(() => {
      expect(screen.getByText('Default empty description')).toBeInTheDocument();
    });
    expect(trackEventMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('player-invoices-empty-claim')).not.toBeInTheDocument();
  });

  it('shows claim-specific empty copy when paid invoice claim flow', async () => {
    localStorage.setItem(SIGNUP_CLAIM_SOURCE_STORAGE_KEY, 'paid_invoice');
    render(<PlayerInvoicesTab profileId="profile-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('player-invoices-empty-claim')).toBeInTheDocument();
    });
    expect(trackEventMock).toHaveBeenCalledWith(
      'invoice_claim_no_invoices_found',
      expect.objectContaining({ invoice_count_bucket: '0' }),
    );
    expect(screen.getByText(/same email address that was used on your invoice/i)).toBeInTheDocument();
    expect(screen.getByText(/contact your trainer or academy/i)).toBeInTheDocument();
    expect(screen.queryByText('Default empty description')).not.toBeInTheDocument();
  });

  it('tracks linked outcome when claim flow has invoices', async () => {
    localStorage.setItem(SIGNUP_CLAIM_SOURCE_STORAGE_KEY, 'paid_invoice');
    const invoiceRow = {
      id: 'inv-1',
      invoice_number: 'INV-1',
      invoice_date: '2026-01-01',
      due_date: '2026-02-01',
      player_name: 'Test',
      player_business_name: null,
      player_address: null,
      player_btw_number: null,
      subtotal: 100,
      vat_rate: 21,
      vat_amount: 21,
      total: 121,
      status: 'paid',
      pdf_url: null,
      sent_at: null,
      paid_at: '2026-01-10',
      notes: null,
    };
    rpcMock.mockResolvedValue({ data: [{ ...invoiceRow, can_edit_billing: true }], error: null });
    render(<PlayerInvoicesTab profileId="profile-1" />);
    await waitFor(() => {
      expect(trackEventMock).toHaveBeenCalledWith(
        'invoice_claim_linked_invoices_found',
        expect.objectContaining({ invoice_count_bucket: '1' }),
      );
    });
    expect(rpcMock).toHaveBeenCalledWith('get_my_invoices');
  });

  it('falls back to the legacy direct query when the RPC is unavailable (pre-deploy congruence)', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'function get_my_invoices() does not exist' } });
    const invoiceRow = {
      id: 'inv-legacy',
      invoice_number: 'INV-9',
      invoice_date: '2026-01-01',
      due_date: '2026-02-01',
      player_name: 'Test',
      player_business_name: null,
      player_address: null,
      player_btw_number: null,
      subtotal: 100,
      vat_rate: 21,
      vat_amount: 21,
      total: 121,
      status: 'sent',
      pdf_url: null,
      sent_at: null,
      paid_at: null,
      notes: null,
    };
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          neq: () => ({
            order: () => Promise.resolve({ data: [invoiceRow], error: null }),
          }),
        }),
      }),
    });
    render(<PlayerInvoicesTab profileId="profile-1" />);
    await waitFor(() => {
      expect(screen.getByText('INV-9')).toBeInTheDocument();
    });
    // Legacy rows have no can_edit_billing → the edit button stays available (old behavior).
    expect(screen.getByLabelText('Edit billing details')).toBeInTheDocument();
  });
});
