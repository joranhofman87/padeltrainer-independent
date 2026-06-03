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
        'invoice.seoTitle': 'Invoice',
        'invoice.seoDescription': 'Pay invoice',
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
});
