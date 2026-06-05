import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PublicInvoicePay from '@/pages/PublicInvoicePay';

const invokeMock = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

vi.mock('@/components/SEO', () => ({
  SEO: () => null,
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/lib/invoicePayTracking', () => ({
  normalizeInvoicePayRecipientType: () => 'academy',
  normalizeInvoicePayStatus: (s: string) => s,
  trackInvoicePayPageLoaded: vi.fn(),
  trackInvoicePayPageLoadFailed: vi.fn(),
  trackInvoicePaymentStarted: vi.fn(),
  trackInvoicePaymentFailed: vi.fn(),
  trackInvoicePaymentRedirect: vi.fn(),
}));

const tMap: Record<string, string> = {
  'invoice.seoTitlePay': 'Pay invoice',
  'invoice.seoDescriptionPay': 'Pay your invoice',
  'invoice.seoTitle': 'Invoice',
  'invoice.open': 'Open',
  'invoice.invoiceDate': 'Date',
  'invoice.dueDate': 'Due',
  'invoice.from': 'From',
  'invoice.description': 'Description',
  'invoice.qty': 'Qty',
  'invoice.price': 'Price',
  'invoice.amount': 'Amount',
  'invoice.subtotal': 'Subtotal',
  'invoice.total': 'Total',
  'invoice.stepReviewDetails': 'Review',
  'invoice.stepPay': 'Pay',
  'invoice.payAmount': 'Pay €{{amount}}',
  'invoice.transferInstruction': 'Transfer',
  'invoice.bankTransferAlt': 'Bank transfer',
  'invoice.bankDetails': 'Bank details',
  'invoice.iban': 'IBAN',
  'invoice.bic': 'BIC',
  'invoice.name': 'Name',
  'invoice.reference': 'Reference',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'object' && fallbackOrOpts != null) {
        if (key === 'invoice.payAmount' && 'amount' in fallbackOrOpts) {
          return `Pay €${fallbackOrOpts.amount}`;
        }
      }
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      return tMap[key] ?? key;
    },
    i18n: { language: 'en' },
  }),
  Trans: ({ values }: { values?: { email?: string } }) => (
    <span>
      Questions? Contact <a href={`mailto:${values?.email}`}>{values?.email}</a>
    </span>
  ),
}));

function baseInvoicePayload(academy: Record<string, unknown>) {
  return {
    data: {
      invoice: {
        id: 'inv-1',
        invoiceNumber: '26000422',
        invoiceDate: '2026-05-01',
        dueDate: '2026-06-01',
        playerName: 'Test Player',
        playerId: null,
        playerEmail: 'player@example.com',
        playerBusinessName: null,
        playerAddress: null,
        playerBtwNumber: null,
        total: 50,
        subtotal: 50,
        vatAmount: 0,
        vatRate: 0,
        lineItems: [{ description: 'Lesson', quantity: 1, unit_price: 50, total: 50 }],
        status: 'sent',
        hasMolliePayment: false,
        hasMollieAccount: true,
        paymentRecipient: 'academy',
      },
      academy,
    },
    error: null,
  };
}

describe('PublicInvoicePay contact footer', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('shows invoice_reply_to_email when present', async () => {
    invokeMock.mockResolvedValueOnce(
      baseInvoicePayload({
        name: 'RL Padel Performance',
        slug: 'rl-padel-performance',
        logoUrl: null,
        bannerColor: null,
        contactEmail: 'info@renelindenbergh.nl',
        invoiceReplyToEmail: 'info@rlpadelperformance.nl',
        businessName: 'RL B.V.',
        businessAddress: null,
        kvkNumber: null,
        btwNumber: null,
        iban: 'NL00TEST0000000000',
        bic: null,
      }),
    );

    render(
      <MemoryRouter initialEntries={['/pay/test-token']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('link', { name: 'info@rlpadelperformance.nl' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'info@renelindenbergh.nl' })).not.toBeInTheDocument();
  });

  it('falls back to contact_email when invoice_reply_to_email is missing', async () => {
    invokeMock.mockResolvedValueOnce(
      baseInvoicePayload({
        name: 'RL Padel Performance',
        slug: 'rl-padel-performance',
        logoUrl: null,
        bannerColor: null,
        contactEmail: 'info@renelindenbergh.nl',
        invoiceReplyToEmail: null,
        businessName: 'RL B.V.',
        businessAddress: null,
        kvkNumber: null,
        btwNumber: null,
        iban: null,
        bic: null,
      }),
    );

    render(
      <MemoryRouter initialEntries={['/pay/fallback-token']}>
        <Routes>
          <Route path="/pay/:token" element={<PublicInvoicePay />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('link', { name: 'info@renelindenbergh.nl' })).toBeInTheDocument();
  });
});
