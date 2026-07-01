import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GuestBookingDialog } from './GuestBookingDialog';
import type { PublicSlot } from '@/lib/publicAvailability';

const invokeMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invokeMock(...args) } },
}));

vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastErrorMock(...a) } }));

// Return the inline default (2nd arg), interpolating {{amount}} from the 3rd arg.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, dflt?: string, opts?: Record<string, unknown>) => {
      const base = typeof dflt === 'string' ? dflt : _key;
      return opts ? base.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts[k] ?? '')) : base;
    },
    i18n: { language: 'nl' },
  }),
}));

const slot: PublicSlot = {
  id: 'slot-1',
  start_time: '2026-09-01T10:00:00Z',
  end_time: '2026-09-01T11:00:00Z',
  cyclus_id: null,
  cyclus_name: null,
  court_type: null,
  location_name: 'Court 1',
  trainer_id: 'tr-1',
  trainer_name: 'Coach Bo',
  trainer_slug: 'coach-bo',
  price_per_session: 20,
  total_price: null,
  extra_costs: [],
  max_participants: 4,
  allow_single_booking: true,
  spots_left: 3,
  split_payment: false,
};

const renderDialog = () =>
  render(<GuestBookingDialog slot={slot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);

const fillValid = () => {
  fireEvent.change(screen.getByLabelText('Naam'), { target: { value: 'Jan de Vries' } });
  fireEvent.change(screen.getByLabelText('E-mailadres'), { target: { value: 'jan@x.nl' } });
};

beforeEach(() => {
  invokeMock.mockReset();
  toastErrorMock.mockReset();
});

describe('GuestBookingDialog', () => {
  it('shows the slot summary and disables checkout until name + valid email', () => {
    renderDialog();
    expect(screen.getByText('Coach Bo')).toBeInTheDocument();
    // Passive login link (no email lookup / enumeration).
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/app/auth');
    const payBtn = screen.getByRole('button', { name: /Afrekenen/ });
    expect(payBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Naam'), { target: { value: 'Jan' } });
    fireEvent.change(screen.getByLabelText('E-mailadres'), { target: { value: 'not-an-email' } });
    expect(payBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText('E-mailadres'), { target: { value: 'jan@x.nl' } });
    expect(payBtn).toBeEnabled();
  });

  it('submits the server-derived booking (slotId + guest details, no amount) and redirects to the checkout URL', async () => {
    invokeMock.mockResolvedValue({ data: { checkoutUrl: 'https://mollie.test/checkout/abc', token: 'tok-1' }, error: null });
    // Intercept the redirect without navigating jsdom.
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { set href(v: string) { hrefSetter(v); } },
    });

    renderDialog();
    fillValid();
    fireEvent.click(screen.getByRole('button', { name: /Afrekenen/ }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('create-guest-slot-payment', {
      body: { slotId: 'slot-1', fullName: 'Jan de Vries', email: 'jan@x.nl', phone: undefined, notes: undefined },
    });
    await waitFor(() => expect(hrefSetter).toHaveBeenCalledWith('https://mollie.test/checkout/abc'));
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('books the WHOLE cyclus (create-guest-cyclus-payment + cyclusId) for a cyclus slot', async () => {
    invokeMock.mockResolvedValue({ data: { checkoutUrl: 'https://mollie.test/c/xyz', token: 'tok-c' }, error: null });
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { set href(v: string) { hrefSetter(v); } } });

    const cyclusSlot: PublicSlot = { ...slot, cyclus_id: 'cyc-1', cyclus_name: 'Beginners A', total_price: 200 };
    render(<GuestBookingDialog slot={cyclusSlot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);
    fillValid();
    fireEvent.click(screen.getByRole('button', { name: /Afrekenen/ }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('create-guest-cyclus-payment', {
      body: { cyclusId: 'cyc-1', fullName: 'Jan de Vries', email: 'jan@x.nl', phone: undefined, notes: undefined },
    });
    await waitFor(() => expect(hrefSetter).toHaveBeenCalledWith('https://mollie.test/c/xyz'));
  });

  it('shows a toast (no redirect) when the slot is full', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { context: { json: async () => ({ error: 'slot_full' }) } },
    });
    renderDialog();
    fillValid();
    fireEvent.click(screen.getByRole('button', { name: /Afrekenen/ }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).toHaveBeenCalledWith('Deze plek is net volgeboekt. Kies een ander moment.');
  });
});
