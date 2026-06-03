import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/components/academy/AcademyLayout', () => ({
  useAcademyContext: () => ({ activeAcademy: { id: 'academy-1' } }),
}));

vi.mock('@/components/settings/ExtraCostPresetPicker', () => ({
  ExtraCostPresetPicker: () => null,
}));

vi.mock('@/components/invoices/InvoiceRecipientCard', () => ({
  InvoiceRecipientCard: (props: { playerName: string }) => (
    <div data-testid="recipient-card">{props.playerName}</div>
  ),
}));

vi.mock('@/components/invoices/InvoiceSourceCard', () => ({
  InvoiceSourceCard: () => <div data-testid="source-card" />,
}));

const invoice = {
  id: 'inv-1',
  invoice_number: 'INV-001',
  player_name: 'Test Player',
  player_id: 'profile-1',
  guest_player_id: null,
  booking_ids: ['b1'],
  line_items: [{ description: 'Lesson', quantity: 1, unit_price: 50, amount: 50 }],
  vat_rate: 21,
  due_date: '2026-06-01',
  notes: null,
  status: 'draft',
  subtotal: 41.32,
  vat_amount: 8.68,
  total: 50,
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

import AcademyEditInvoice from './AcademyEditInvoice';

describe('AcademyEditInvoice detail cards', () => {
  it('renders recipient and source cards on edit page', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/app/academy/invoices/inv-1/edit']}>
          <Routes>
            <Route path="/app/academy/invoices/:invoiceId/edit" element={<AcademyEditInvoice />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('recipient-card')).toHaveTextContent('Test Player');
    expect(screen.getByTestId('source-card')).toBeInTheDocument();
  });
});
