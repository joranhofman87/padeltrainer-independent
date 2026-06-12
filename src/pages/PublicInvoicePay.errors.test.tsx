import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PublicInvoicePay from './PublicInvoicePay';
import { resolvePublicInvoiceLoadError } from '@/lib/publicInvoiceFetch';

const invokeMock = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
  },
}));

vi.mock('@/components/SEO', () => ({
  SEO: () => null,
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

const trackInvoiceClaimStartedMock = vi.fn();
const trackInvoicePayPageLoadedMock = vi.fn();
const trackInvoicePayPageLoadFailedMock = vi.fn();
const trackInvoicePaymentStartedMock = vi.fn();
const trackInvoicePaymentRedirectMock = vi.fn();
const trackInvoicePaymentFailedMock = vi.fn();

vi.mock('@/lib/invoiceClaimTracking', () => ({
  trackInvoiceClaimStarted: () => trackInvoiceClaimStartedMock(),
}));

vi.mock('@/lib/invoicePayTracking', () => ({
  normalizeInvoicePayRecipientType: (r: string | null | undefined) =>
    r === 'academy' ? 'academy' : r === 'trainer' ? 'trainer' : 'unknown',
  normalizeInvoicePayStatus: (s: string) =>
    ['sent', 'paid', 'cancelled', 'draft'].includes(s) ? s : 'unknown',
  trackInvoicePayPageLoaded: (...args: unknown[]) => trackInvoicePayPageLoadedMock(...args),
  trackInvoicePayPageLoadFailed: (...args: unknown[]) => trackInvoicePayPageLoadFailedMock(...args),
  trackInvoicePaymentStarted: (...args: unknown[]) => trackInvoicePaymentStartedMock(...args),
  trackInvoicePaymentRedirect: (...args: unknown[]) => trackInvoicePaymentRedirectMock(...args),
  trackInvoicePaymentFailed: (...args: unknown[]) => trackInvoicePaymentFailedMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'invoice.pageUnavailable': 'Payment page unavailable',
        'invoice.pageUnavailableDescription': 'Unavailable description',
        'invoice.draftNotSent': 'Invoice not sent yet',
        'invoice.draftNotSentDescription': 'Draft description',
        'invoice.invoiceNotFound': 'Invoice not found',
        'invoice.invoiceNotFoundDescription': 'Not found description',
        'invoice.paymentReceived': 'Payment received',
        'invoice.paymentReceivedDescription': 'Thank you. This invoice has been paid successfully.',
        'invoice.paidPrivacyMessage': 'Privacy message',
        'invoice.publicPayLogIn': 'Log in',
        'invoice.publicPayClaimAccount': 'Create account to view invoices',
        'invoice.publicPaySignupHelper':
          'If this is your first time using PadelTrainer, create an account with the email address used for your booking or invoice. We will link your invoices after signup when the email matches.',
        'invoice.publicPayForgotPasswordNote':
          'Already have an account but forgot your password? Use the password reset option on the login page.',
        'invoice.invoiceCancelledTitle': 'Invoice cancelled',
        'invoice.invoiceCancelledDescription': 'Cancelled description',
        'invoice.seoTitle': 'Invoice',
        'invoice.seoDescription': 'Pay invoice',
        'invoice.onlinePaymentUnavailableAcademy':
          'Online payment is not available for this invoice. Please contact the academy.',
        'invoice.onlinePaymentUnavailableTrainer':
          'Online payment is not available for this invoice. Please contact the trainer.',
        'invoice.payAmount': 'Pay €{{amount}}',
        'invoice.transferInstruction': 'Please transfer',
        'invoice.from': 'From',
        'invoice.open': 'Open',
        'invoice.stepReviewDetails': 'Review',
        'invoice.stepPay': 'Pay',
        'invoice.invoiceDate': 'Date',
        'invoice.dueDate': 'Due',
        'invoice.description': 'Description',
        'invoice.qty': 'Qty',
        'invoice.price': 'Price',
        'invoice.amount': 'Amount',
        'invoice.subtotal': 'Subtotal',
        'invoice.total': 'Total',
        'invoice.paymentProcessing': 'Payment Processing',
        'invoice.paymentProcessingDescription': 'Your payment is being processed.',
        'invoice.publicPaySignupHelper': 'Use the same email as on your invoice.',
        'invoice.publicPayForgotPasswordNote':
          'Already have an account but forgot your password? Use the password reset option on the login page.',
        'invoice.createAccountToViewInvoices': 'Create account to view invoices',
        'invoice.goToMyAccount': 'Go to my account',
      };
      return map[key] ?? fallback ?? key;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

describe('resolvePublicInvoiceLoadError', () => {
  it('401 maps to unavailable', () => {
    expect(resolvePublicInvoiceLoadError(null, { context: { status: 401 } })).toBe('unavailable');
  });
});

describe('PublicInvoicePay error UI', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    trackInvoiceClaimStartedMock.mockClear();
    trackInvoicePayPageLoadedMock.mockClear();
    trackInvoicePayPageLoadFailedMock.mockClear();
    trackInvoicePaymentStartedMock.mockClear();
    trackInvoicePaymentRedirectMock.mockClear();
    trackInvoicePaymentFailedMock.mockClear();
  });

  it('shows unavailable message on 401 invoke error', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { context: { status: 401 }, message: 'Unauthorized' },
    });

    render(
      <MemoryRouter initialEntries={['/pay/test-token']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Payment page unavailable' })).toBeInTheDocument();
    expect(screen.getByText('Unavailable description')).toBeInTheDocument();
  });

  it('shows draft not sent message when API returns draft_invoice', async () => {
    invokeMock.mockResolvedValue({
      data: { error: 'draft_invoice' },
      error: { context: { status: 403 } },
    });

    render(
      <MemoryRouter initialEntries={['/pay/draft-token']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Invoice not sent yet' })).toBeInTheDocument();
    expect(screen.getByText('Draft description')).toBeInTheDocument();
  });

  it('shows paid state with no invoice details when status is paid', async () => {
    invokeMock.mockResolvedValue({
      data: { status: 'paid' },
      error: null,
    });

    render(
      <MemoryRouter initialEntries={['/pay/paid-token']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Payment received' })).toBeInTheDocument();
    expect(screen.getByText('Thank you. This invoice has been paid successfully.')).toBeInTheDocument();
    expect(screen.getByText('Privacy message')).toBeInTheDocument();
    const claimLink = screen.getByRole('link', { name: 'Create account to view invoices' });
    expect(claimLink).toHaveAttribute(
      'href',
      '/app/signup/player?source=paid_invoice&redirect=%2Fapp%2Fplayer%2Finvoices',
    );
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/app/auth');
    expect(screen.getByText(/Use the same email as on your invoice/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Reset password' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /forgot-password/i })).not.toBeInTheDocument();
    expect(screen.queryByText('INV-')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/i })).not.toBeInTheDocument();
  });

  it('PostPaymentCTA uses paid invoice claim signup path without email prefill', async () => {
    invokeMock.mockResolvedValue({
      data: {
        invoice: {
          id: 'inv-1',
          invoiceNumber: 'INV-1',
          invoiceDate: '2025-01-15',
          dueDate: '2025-01-29',
          playerName: 'Guest Player',
          playerId: null,
          playerEmail: 'guest@example.com',
          total: 1,
          subtotal: 1,
          vatAmount: 0,
          vatRate: 0,
          lineItems: [{ description: 'Lesson', quantity: 1, unit_price: 1, total: 1 }],
          status: 'sent',
          hasMolliePayment: false,
          hasMollieAccount: false,
          paymentRecipient: 'trainer',
        },
        trainer: {
          businessName: 'Coach',
          businessAddress: 'Street 1',
          kvkNumber: '123',
          btwNumber: null,
          iban: 'NL00TEST0000000000',
          bic: null,
        },
        academy: null,
      },
      error: null,
    });

    render(
      <MemoryRouter initialEntries={['/pay/processing-token?status=success']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Payment Processing' })).toBeInTheDocument();
    const signupLink = screen.getByRole('link', { name: 'Create account to view invoices' });
    expect(signupLink).toHaveAttribute(
      'href',
      '/app/signup/player?source=paid_invoice&redirect=%2Fapp%2Fplayer%2Finvoices',
    );
    expect(signupLink.getAttribute('href')).not.toContain('email=');
    expect(signupLink.getAttribute('href')).not.toContain('name=');
  });

  it('tracks invoice_claim_started when claim CTA is clicked', async () => {
    invokeMock.mockResolvedValue({
      data: { status: 'paid' },
      error: null,
    });

    render(
      <MemoryRouter initialEntries={['/pay/paid-token']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Payment received' });
    fireEvent.click(screen.getByTestId('public-pay-claim-account'));
    expect(trackInvoiceClaimStartedMock).toHaveBeenCalledTimes(1);
  });

  it('shows cancelled state with no invoice details', async () => {
    invokeMock.mockResolvedValue({
      data: { status: 'cancelled' },
      error: null,
    });

    render(
      <MemoryRouter initialEntries={['/pay/cancelled-token']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Invoice cancelled' })).toBeInTheDocument();
    expect(screen.getByText('Cancelled description')).toBeInTheDocument();
    expect(screen.queryByText('INV-')).not.toBeInTheDocument();
  });

  it('shows a retryable error on network failure and recovers on retry', async () => {
    invokeMock
      .mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
      .mockResolvedValueOnce({ data: { status: 'paid' }, error: null });

    render(
      <MemoryRouter initialEntries={['/pay/flaky-token']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { name: 'Factuur kon niet geladen worden' }),
    ).toBeInTheDocument();
    expect(trackInvoicePayPageLoadFailedMock).toHaveBeenCalledWith('transient');
    // Network failures must never render the "not found / expired" dead end.
    expect(screen.queryByText('Invoice not found')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(await screen.findByRole('heading', { name: 'Payment received' })).toBeInTheDocument();
  });

  it('shows not found for 404-style errors', async () => {
    invokeMock.mockResolvedValue({
      data: { error: 'Invoice not found' },
      error: null,
    });

    render(
      <MemoryRouter initialEntries={['/pay/missing']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Invoice not found' })).toBeInTheDocument();
  });

  it('hides Pay button when hasMollieAccount is false', async () => {
    invokeMock.mockResolvedValue({
      data: {
        invoice: {
          id: 'inv-1',
          invoiceNumber: 'INV-001',
          invoiceDate: '2025-01-15',
          dueDate: '2025-01-29',
          playerName: 'Test Player',
          playerId: null,
          playerEmail: 'test@example.com',
          total: 1,
          subtotal: 1,
          vatAmount: 0,
          vatRate: 0,
          lineItems: [{ description: 'Lesson', quantity: 1, unit_price: 1, total: 1 }],
          status: 'sent',
          hasMolliePayment: false,
          hasMollieAccount: false,
          paymentRecipient: 'academy',
          paymentUnavailableReason: 'missing_access_token',
        },
        academy: {
          name: 'RL Padel',
          slug: 'rl-padel-performance',
          logoUrl: null,
          bannerColor: null,
          contactEmail: 'pay@example.com',
          businessName: 'RL B.V.',
          businessAddress: 'Street 1',
          kvkNumber: '123',
          btwNumber: null,
          iban: 'NL00TEST0000000000',
          bic: null,
        },
      },
      error: null,
    });

    render(
      <MemoryRouter initialEntries={['/pay/academy-token']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(
        'Online payment is not available for this invoice. Please contact the academy.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay €/i })).not.toBeInTheDocument();
    expect(trackInvoicePayPageLoadedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        has_mollie_account: false,
        recipient_type: 'academy',
        status: 'sent',
      }),
    );
    const loadedProps = trackInvoicePayPageLoadedMock.mock.calls[0][0] as Record<string, unknown>;
    expect(loadedProps).not.toHaveProperty('invoice_id');
    expect(loadedProps).not.toHaveProperty('amount');
  });

  it('tracks invoice_pay_page_load_failed without PII', async () => {
    invokeMock.mockResolvedValue({
      data: { error: 'Invoice not found' },
      error: null,
    });

    render(
      <MemoryRouter initialEntries={['/pay/missing']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Invoice not found' });
    expect(trackInvoicePayPageLoadFailedMock).toHaveBeenCalledWith('not_found');
    const props = trackInvoicePayPageLoadFailedMock.mock.calls[0] as unknown[];
    expect(props).toHaveLength(1);
  });

  const molliePayableInvoicePayload = {
    invoice: {
      id: 'inv-secret',
      invoiceNumber: 'INV-SECRET',
      invoiceDate: '2025-01-15',
      dueDate: '2025-01-29',
      playerName: 'Secret Player',
      playerId: null,
      playerEmail: 'secret@example.com',
      total: 99,
      subtotal: 99,
      vatAmount: 0,
      vatRate: 0,
      lineItems: [{ description: 'Lesson', quantity: 1, unit_price: 99, total: 99 }],
      status: 'sent',
      hasMolliePayment: false,
      hasMollieAccount: true,
      paymentRecipient: 'trainer',
    },
    academy: null,
  };

  it('tracks payment started and redirect without PII', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/pay/pay-token', href: 'http://localhost/pay/pay-token' },
    });

    invokeMock
      .mockResolvedValueOnce({ data: molliePayableInvoicePayload, error: null })
      .mockResolvedValueOnce({ data: { paymentUrl: 'https://mollie.test/pay' }, error: null });

    render(
      <MemoryRouter initialEntries={['/pay/pay-token']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Pay €/i }));

    await waitFor(() => {
      expect(trackInvoicePaymentStartedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          has_mollie_account: true,
          recipient_type: 'trainer',
          status: 'sent',
        }),
      );
      expect(trackInvoicePaymentRedirectMock).toHaveBeenCalledWith(
        expect.objectContaining({ recipient_type: 'trainer', status: 'sent' }),
      );
    });
    for (const mock of [trackInvoicePaymentStartedMock, trackInvoicePaymentRedirectMock]) {
      const callProps = mock.mock.calls[0][0] as Record<string, unknown>;
      expect(callProps).not.toHaveProperty('invoice_id');
      expect(callProps).not.toHaveProperty('amount');
    }
  });

  it('tracks payment failed with error_code only', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/pay/fail-token', href: 'http://localhost/pay/fail-token' },
    });

    invokeMock
      .mockResolvedValueOnce({ data: molliePayableInvoicePayload, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: JSON.stringify({ error: 'no_mollie_account' }) },
      });

    render(
      <MemoryRouter initialEntries={['/pay/fail-token']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Pay €/i }));
    await waitFor(() => {
      expect(trackInvoicePaymentFailedMock).toHaveBeenCalledWith('no_mollie_account');
    });
    const failedProps = trackInvoicePaymentFailedMock.mock.calls[0] as unknown[];
    expect(failedProps).toEqual(['no_mollie_account']);
  });
});
