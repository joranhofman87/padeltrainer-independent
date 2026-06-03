import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/components/settings/ExtraCostPresetPicker', () => ({
  ExtraCostPresetPicker: () => null,
}));

vi.mock('@/components/invoices/InvoiceRecipientCard', () => ({
  InvoiceRecipientCard: () => <div data-testid="recipient-card" />,
}));

vi.mock('@/components/invoices/InvoiceSourceCard', () => ({
  InvoiceSourceCard: () => <div data-testid="source-card" />,
}));

const invoice = {
  id: 'inv-2',
  invoice_number: 'INV-002',
  player_name: 'Trainer Client',
  player_id: null,
  guest_player_id: 'guest-1',
  booking_ids: null,
  trainer_id: 'trainer-1',
  line_items: [{ description: 'Court', quantity: 1, unit_price: 30, amount: 30 }],
  vat_rate: 21,
  due_date: '2026-06-01',
  notes: null,
  status: 'draft',
  subtotal: 24.79,
  vat_amount: 5.21,
  total: 30,
  prices_include_vat: true,
};

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'invoices') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: invoice, error: null }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) };
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

import TrainerEditInvoice from './TrainerEditInvoice';

describe('TrainerEditInvoice detail cards', () => {
  it('renders recipient and source cards without broken profile route in page wiring', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/app/trainer/invoices/inv-2/edit']}>
          <Routes>
            <Route path="/app/trainer/invoices/:invoiceId/edit" element={<TrainerEditInvoice />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('recipient-card')).toBeInTheDocument();
    expect(screen.getByTestId('source-card')).toBeInTheDocument();
  });
});
