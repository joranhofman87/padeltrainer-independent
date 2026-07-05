// Guest cart UI flow (cart PR 6): the PublicSlotRow toggle → drawer → one-payment
// checkout → stale-item prune. Drives the REAL CartProvider; only the network edges
// (supabase invoke) and toasts are mocked — same seams as GuestBookingDialog.test.tsx.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CartProvider } from '@/contexts/CartContext';
import { PublicSlotRow } from './PublicSlotRow';
import { BookingCartDrawer } from './BookingCartDrawer';
import type { PublicSlot } from '@/lib/publicAvailability';

const invokeMock = vi.fn();
const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invokeMock(...args) } },
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastErrorMock(...a),
    success: (...a: unknown[]) => toastSuccessMock(...a),
  },
}));

// Return the inline default (2nd arg), interpolating {{x}} from the 3rd arg.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, dflt?: string, opts?: Record<string, unknown>) => {
      const base = typeof dflt === 'string' ? dflt : _key;
      return opts ? base.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts[k] ?? '')) : base;
    },
    i18n: { language: 'nl' },
  }),
}));

let seq = 0;
const FUTURE_A = '2027-09-01T10:00:00Z';

function slot(overrides: Partial<PublicSlot> = {}): PublicSlot {
  seq += 1;
  return {
    id: `slot-${seq}`,
    start_time: FUTURE_A,
    end_time: '2027-09-01T11:00:00Z',
    cyclus_id: null,
    cyclus_name: null,
    court_type: null,
    location_name: 'Hal 1',
    trainer_id: 'tr-1',
    academy_profile_id: 'ac-1',
    trainer_name: 'Coach Bo',
    trainer_slug: 'coach-bo',
    price_per_session: 20,
    total_price: null,
    extra_costs: [],
    max_participants: 4,
    allow_single_booking: true,
    whole_slot_booking: false,
    spots_left: 4,
    split_payment: false,
    ...overrides,
  };
}

const TZ = 'Europe/Amsterdam';

function renderFlow(slots: PublicSlot[]) {
  return render(
    <CartProvider>
      {slots.map((s) => (
        <PublicSlotRow key={s.id} slot={s} timezone={TZ} onSelect={() => {}} />
      ))}
      <BookingCartDrawer timezone={TZ} />
    </CartProvider>,
  );
}

async function fillContactForm() {
  fireEvent.change(screen.getByLabelText('Voornaam'), { target: { value: 'Gast' } });
  fireEvent.change(screen.getByLabelText('Achternaam'), { target: { value: 'Speler' } });
  fireEvent.change(screen.getByLabelText('E-mailadres'), { target: { value: 'gast@example.com' } });
  fireEvent.change(screen.getByLabelText('Telefoon'), { target: { value: '0612345678' } });
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
});

describe('PublicSlotRow cart affordance', () => {
  it('shows the add-to-cart toggle only for cartable slots', () => {
    renderFlow([slot(), slot({ split_payment: true }), slot({ cyclus_id: 'cyc-1', allow_single_booking: false })]);
    // 1 cartable slot → exactly one add button; split + locked-cyclus rows get none
    expect(screen.getAllByLabelText('Voeg toe aan selectie')).toHaveLength(1);
  });

  it('whole-slot cyclus sessions are cartable; split+whole-slot are not', () => {
    renderFlow([
      slot({ cyclus_id: 'cyc-1', allow_single_booking: false, whole_slot_booking: true }),
      slot({ cyclus_id: 'cyc-1', allow_single_booking: false, whole_slot_booking: true, split_payment: true }),
    ]);
    expect(screen.getAllByLabelText('Voeg toe aan selectie')).toHaveLength(1);
  });

  it('adding toggles the control and surfaces the floating cart button with a count', () => {
    renderFlow([slot(), slot()]);
    const addButtons = screen.getAllByLabelText('Voeg toe aan selectie');
    fireEvent.click(addButtons[0]);
    fireEvent.click(addButtons[1]);
    expect(toastSuccessMock).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Open je selectie (2)')).toBeInTheDocument();
    // toggled rows now offer removal
    expect(screen.getAllByLabelText('Verwijder uit selectie').length).toBeGreaterThanOrEqual(2);
  });

  it('explains a cross-provider add instead of adding it', () => {
    renderFlow([slot(), slot({ trainer_id: 'tr-2', academy_profile_id: null })]);
    const addButtons = screen.getAllByLabelText('Voeg toe aan selectie');
    fireEvent.click(addButtons[0]);
    fireEvent.click(addButtons[1]);
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining('één aanbieder'));
    expect(screen.getByLabelText('Open je selectie (1)')).toBeInTheDocument();
  });
});

describe('cart drawer + checkout', () => {
  it('checks out all selected sessions in ONE payment call and redirects to Mollie', async () => {
    invokeMock.mockResolvedValue({ data: { checkoutUrl: 'https://mollie.test/checkout' }, error: null });
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { ...original, href: '' }, writable: true });

    const s1 = slot();
    const s2 = slot();
    renderFlow([s1, s2]);
    for (const b of screen.getAllByLabelText('Voeg toe aan selectie')) fireEvent.click(b);
    fireEvent.click(screen.getByLabelText('Open je selectie (2)'));
    fireEvent.click(screen.getByRole('button', { name: 'Afrekenen' }));

    await fillContactForm();
    fireEvent.click(screen.getByRole('button', { name: /Afrekenen · / }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('create-guest-cart-payment', {
      body: expect.objectContaining({
        slotIds: [s1.id, s2.id],
        firstName: 'Gast',
        lastName: 'Speler',
        email: 'gast@example.com',
        phone: '0612345678',
      }),
    });
    await waitFor(() => expect(window.location.href).toBe('https://mollie.test/checkout'));
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });

  it('marks the offending session on slot_full ({error, slotIds}) and prunes it on request', async () => {
    const s1 = slot();
    const s2 = slot();
    invokeMock.mockResolvedValue({
      data: null,
      error: { context: new Response(JSON.stringify({ error: 'slot_full', slotIds: [s2.id] }), { status: 409 }) },
    });

    renderFlow([s1, s2]);
    for (const b of screen.getAllByLabelText('Voeg toe aan selectie')) fireEvent.click(b);
    fireEvent.click(screen.getByLabelText('Open je selectie (2)'));
    fireEvent.click(screen.getByRole('button', { name: 'Afrekenen' }));
    await fillContactForm();
    fireEvent.click(screen.getByRole('button', { name: /Afrekenen · / }));

    // refused → warning names the stale item, checkout is blocked until pruned
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Niet alle sessies zijn nog beschikbaar');
    expect(screen.getByRole('button', { name: 'Afrekenen' })).toBeDisabled();

    fireEvent.click(within(alert).getByRole('button', { name: 'Verwijder en ga verder' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    // the stale item is gone, the healthy one remains, checkout unblocks
    expect(screen.getByLabelText('Open je selectie (1)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Afrekenen' })).toBeEnabled();
  });

  it('clearing the selection hides the floating button entirely', () => {
    renderFlow([slot()]);
    fireEvent.click(screen.getByLabelText('Voeg toe aan selectie'));
    fireEvent.click(screen.getByLabelText('Open je selectie (1)'));
    fireEvent.click(screen.getByRole('button', { name: 'Selectie leegmaken' }));
    expect(screen.queryByLabelText(/Open je selectie/)).not.toBeInTheDocument();
  });
});
