import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
        'invoice.publicPayCreateAccount': 'Create account',
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
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/app/signup/player');
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/app/auth');
    expect(screen.getByText(/first time using PadelTrainer/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Reset password' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /forgot-password/i })).not.toBeInTheDocument();
    expect(screen.queryByText('INV-')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/i })).not.toBeInTheDocument();
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
  });
});
