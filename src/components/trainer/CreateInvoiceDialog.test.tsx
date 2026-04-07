import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback || key,
    i18n: { language: 'nl' },
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mockInsert = vi.fn().mockReturnValue({
  select: () => ({
    single: () => Promise.resolve({ data: { id: 'inv-1', invoice_number: 'INV-2026-0001' }, error: null }),
  }),
});

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          like: () => ({
            order: () => ({
              limit: () => ({
                single: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
        }),
      }),
      insert: mockInsert,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { CreateInvoiceDialog } from './CreateInvoiceDialog';

const defaultBusinessInfo = {
  business_name: 'Padel Academy BV',
  business_address: 'Main St 1, Amsterdam',
  kvk_number: '12345678',
  btw_number: 'NL123456789B01',
  iban: 'NL91ABNA0417164300',
  bic: 'ABNANL2A',
  payment_terms_days: 14,
  invoice_prefix: 'INV',
};

const defaultBooking = {
  id: 'booking-1',
  lessonTitle: 'Private Lesson',
  playerName: 'John Player',
  playerEmail: 'john@test.com',
  playerId: 'player-1',
  date: '2026-04-10',
  time: '10:00',
  price: 50,
};

const renderDialog = (props = {}) =>
  render(
    <CreateInvoiceDialog
      open={true}
      onOpenChange={() => {}}
      booking={defaultBooking}
      trainerId="trainer-1"
      trainerBusinessInfo={defaultBusinessInfo}
      defaultVatRate={21}
      onInvoiceCreated={vi.fn()}
      {...props}
    />
  );

describe('CreateInvoiceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with booking data pre-filled', () => {
    renderDialog();
    // Player name should be pre-filled
    const playerInput = screen.getByDisplayValue('John Player');
    expect(playerInput).toBeInTheDocument();
  });

  it('renders line item from booking', () => {
    renderDialog();
    expect(screen.getByDisplayValue('Private Lesson')).toBeInTheDocument();
  });

  it('shows VAT rate options', () => {
    renderDialog();
    // Default VAT rate 21 should be selected
    expect(screen.getByText(/21%/)).toBeInTheDocument();
  });

  it('renders add line item button', () => {
    renderDialog();
    // There should be an add button (Plus icon)
    const addButtons = screen.getAllByRole('button');
    const addButton = addButtons.find(btn => btn.textContent?.includes('Regel toevoegen') || btn.querySelector('svg'));
    expect(addButton).toBeTruthy();
  });

  it('shows business info warning when incomplete', () => {
    renderDialog({
      trainerBusinessInfo: {
        ...defaultBusinessInfo,
        business_name: null,
        kvk_number: null,
      },
    });
    // Should show warning about missing business info
    expect(screen.getByText(/bedrijfsgegevens/i)).toBeInTheDocument();
  });

  it('renders total calculation', () => {
    renderDialog();
    // With a €50 line item at 21% VAT (inclusive):
    // Total = €50.00
    expect(screen.getByText(/€\s*50[.,]00/)).toBeInTheDocument();
  });
});
