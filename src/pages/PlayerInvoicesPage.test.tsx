import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PlayerInvoicesPage from './PlayerInvoicesPage';
import {
  PAID_INVOICE_CLAIM_TOAST_SESSION_KEY,
  SIGNUP_CLAIM_SOURCE_STORAGE_KEY,
} from '@/lib/signupClaimFlow';
import { mockBrowserStorage } from '@/test/signupPageFreeze';

const toastMock = vi.fn();

vi.mock('@/components/player/PlayerInvoicesTab', () => ({
  PlayerInvoicesTab: ({ profileId }: { profileId: string }) => (
    <div data-testid="player-invoices-tab">invoices-tab-{profileId}</div>
  ),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    profile: { id: 'profile-abc' },
    loading: false,
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}));

const trackInvoiceClaimLandedOnInvoicesMock = vi.fn();

vi.mock('@/lib/invoiceClaimTracking', () => ({
  trackInvoiceClaimLandedOnInvoices: () => trackInvoiceClaimLandedOnInvoicesMock(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'invoices.title': 'Invoices',
        'invoices.description': 'View and download invoices for your training sessions.',
        'playerInvoices.claimToast.title': 'Your invoices',
        'playerInvoices.claimToast.description':
          'If you used the same email address as your invoice, your invoices should appear here.',
      };
      return map[key] ?? fallback ?? key;
    },
  }),
}));

describe('PlayerInvoicesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowserStorage();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('renders page header and PlayerInvoicesTab with profile id', () => {
    render(
      <MemoryRouter>
        <PlayerInvoicesPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('page-player-invoices')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByText(/View and download invoices/)).toBeInTheDocument();
    expect(screen.getByTestId('player-invoices-tab')).toHaveTextContent('invoices-tab-profile-abc');
  });

  it('tracks invoice_claim_landed_on_invoices when profile is ready', async () => {
    localStorage.setItem(SIGNUP_CLAIM_SOURCE_STORAGE_KEY, 'paid_invoice');

    render(
      <MemoryRouter>
        <PlayerInvoicesPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(trackInvoiceClaimLandedOnInvoicesMock).toHaveBeenCalledTimes(1);
    });
  });

  it('shows one-time claim toast when arriving from paid invoice flow', async () => {
    localStorage.setItem(SIGNUP_CLAIM_SOURCE_STORAGE_KEY, 'paid_invoice');

    render(
      <MemoryRouter>
        <PlayerInvoicesPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'If you used the same email address as your invoice, your invoices should appear here.',
        }),
      );
    });
    expect(sessionStorage.getItem(PAID_INVOICE_CLAIM_TOAST_SESSION_KEY)).toBe('1');
  });
});
