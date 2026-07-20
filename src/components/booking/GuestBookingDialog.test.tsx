import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GuestBookingDialog } from './GuestBookingDialog';
import { CartProvider } from '@/contexts/CartContext';
import type { PublicSlot } from '@/lib/publicAvailability';

const invokeMock = vi.fn();
const toastErrorMock = vi.fn();
// Cyclus sessions + the cycle's public settings row the dialog fetches via supabase.from —
// set per test.
const cyclusSessions: { current: unknown[] } = { current: [] };
const cyclusPublicRow: { current: unknown } = { current: null };

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'order']) q[m] = () => q;
      if (table === 'cycles_public') {
        q.maybeSingle = () => Promise.resolve({ data: cyclusPublicRow.current });
        q.then = (resolve: (v: { data: unknown }) => void) => resolve({ data: cyclusPublicRow.current });
      } else {
        q.then = (resolve: (v: { data: unknown }) => void) => resolve({ data: cyclusSessions.current });
      }
      return q;
    },
  },
}));

const toastSuccessMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastErrorMock(...a),
    success: (...a: unknown[]) => toastSuccessMock(...a),
  },
}));

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
  academy_profile_id: null,
  trainer_name: 'Coach Bo',
  trainer_slug: 'coach-bo',
  price_per_session: 20,
  total_price: null,
  extra_costs: [],
  max_participants: 4,
  allow_single_booking: true,
  whole_slot_booking: false,
  spots_left: 3,
  split_payment: false,
};

const renderDialog = () =>
  render(<GuestBookingDialog slot={slot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);

const fillValid = () => {
  fireEvent.change(screen.getByLabelText('Voornaam'), { target: { value: 'Jan' } });
  fireEvent.change(screen.getByLabelText('Achternaam'), { target: { value: 'de Vries' } });
  fireEvent.change(screen.getByLabelText('E-mailadres'), { target: { value: 'jan@x.nl' } });
  fireEvent.change(screen.getByLabelText('Telefoon'), { target: { value: '0612345678' } });
};

const cyclusSlot: PublicSlot = { ...slot, cyclus_id: 'cyc-1', cyclus_name: 'Beginners A' };
const twoSessions = [
  { id: 's1', start_time: '2026-09-01T10:00:00Z', end_time: '2026-09-01T11:00:00Z', price_per_session: 20 },
  { id: 's2', start_time: '2026-09-08T10:00:00Z', end_time: '2026-09-08T11:00:00Z', price_per_session: 20 },
];

beforeEach(() => {
  invokeMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  cyclusSessions.current = [];
  // Default: a normal OPEN cycle visible via cycles_public (series sellable).
  // null models a cycle OUTSIDE the view (draft/closed) — series must not be offered.
  cyclusPublicRow.current = { settings: {} };
  localStorage.clear();
});

describe('GuestBookingDialog', () => {
  it('disables checkout until first name, last name, valid email AND phone are all filled', () => {
    renderDialog();
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/app/auth');
    const payBtn = screen.getByRole('button', { name: /Afrekenen/ });
    expect(payBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Voornaam'), { target: { value: 'Jan' } });
    fireEvent.change(screen.getByLabelText('Achternaam'), { target: { value: 'de Vries' } });
    fireEvent.change(screen.getByLabelText('E-mailadres'), { target: { value: 'jan@x.nl' } });
    expect(payBtn).toBeDisabled(); // phone still required

    fireEvent.change(screen.getByLabelText('Telefoon'), { target: { value: '0612345678' } });
    expect(payBtn).toBeEnabled();
  });

  it('submits the single slot (firstName + lastName + phone) and redirects to the checkout URL', async () => {
    invokeMock.mockResolvedValue({ data: { checkoutUrl: 'https://mollie.test/checkout/abc', token: 'tok-1' }, error: null });
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { hostname: 'localhost', set href(v: string) { hrefSetter(v); } } });

    renderDialog();
    fillValid();
    fireEvent.click(screen.getByRole('button', { name: /Afrekenen/ }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('create-guest-slot-payment', {
      body: { slotId: 'slot-1', firstName: 'Jan', lastName: 'de Vries', email: 'jan@x.nl', phone: '0612345678', notes: undefined, whatsappOptIn: false },
    });
    await waitFor(() => expect(hrefSetter).toHaveBeenCalledWith('https://mollie.test/checkout/abc'));
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('a cyclus slot DEFAULTS to booking the WHOLE cyclus', async () => {
    cyclusSessions.current = twoSessions;
    invokeMock.mockResolvedValue({ data: { checkoutUrl: 'https://mollie.test/c/xyz' }, error: null });
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { hostname: 'localhost', set href(v: string) { hrefSetter(v); } } });

    render(<GuestBookingDialog slot={cyclusSlot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);
    fillValid();
    const payBtn = screen.getByRole('button', { name: /Afrekenen/ });
    await waitFor(() => expect(payBtn).toBeEnabled()); // sessions loaded (whole-cyclus mode not blocked)
    fireEvent.click(payBtn);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('create-guest-cyclus-payment', {
      body: { cyclusId: 'cyc-1', firstName: 'Jan', lastName: 'de Vries', email: 'jan@x.nl', phone: '0612345678', notes: undefined, whatsappOptIn: false },
    });
    await waitFor(() => expect(hrefSetter).toHaveBeenCalledWith('https://mollie.test/c/xyz'));
  });

  it('toggling to "This session only" books the single slot instead', async () => {
    cyclusSessions.current = twoSessions;
    invokeMock.mockResolvedValue({ data: { checkoutUrl: 'https://mollie.test/s/1' }, error: null });
    Object.defineProperty(window, 'location', { configurable: true, value: { hostname: 'localhost', set href(_v: string) {} } });

    render(<GuestBookingDialog slot={cyclusSlot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);
    fireEvent.click(await screen.findByRole('button', { name: /Alleen deze sessie/ }));
    fillValid();
    fireEvent.click(screen.getByRole('button', { name: /Afrekenen/ }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('create-guest-slot-payment', {
      body: { slotId: 'slot-1', firstName: 'Jan', lastName: 'de Vries', email: 'jan@x.nl', phone: '0612345678', notes: undefined, whatsappOptIn: false },
    });
  });

  it('hides the "This session only" option when the owner disabled individual-session booking', async () => {
    // allow_single_booking=false (e.g. a split_payment whole-series cyclus): the single-session
    // toggle must NOT be offered — booking is forced to the whole cyclus.
    cyclusSessions.current = twoSessions;
    invokeMock.mockResolvedValue({ data: { checkoutUrl: 'https://mollie.test/c/split' }, error: null });
    Object.defineProperty(window, 'location', { configurable: true, value: { hostname: 'localhost', set href(_v: string) {} } });

    const wholeSeriesSlot: PublicSlot = { ...cyclusSlot, allow_single_booking: false, split_payment: true };
    render(<GuestBookingDialog slot={wholeSeriesSlot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);

    // No single-session toggle rendered.
    expect(screen.queryByRole('button', { name: /Alleen deze sessie/ })).toBeNull();

    // Submitting books the WHOLE cyclus (single path is unreachable).
    fillValid();
    const payBtn = screen.getByRole('button', { name: /Afrekenen/ });
    await waitFor(() => expect(payBtn).toBeEnabled());
    fireEvent.click(payBtn);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('create-guest-cyclus-payment', {
      body: { cyclusId: 'cyc-1', firstName: 'Jan', lastName: 'de Vries', email: 'jan@x.nl', phone: '0612345678', notes: undefined, whatsappOptIn: false },
    });
  });

  it('cycle invisible in cycles_public (draft/closed): fails CLOSED — no whole-series option', async () => {
    // The RL Padel report: DRAFT cycles with public whole-slot sessions. The cycle is
    // not in cycles_public (status='open' only), so the series option must be hidden —
    // the old fail-open default showed AND preselected it, then checkout 403'd
    // cyclus_not_bookable at payment.
    cyclusSessions.current = twoSessions;
    cyclusPublicRow.current = null;
    const rlPadelSlot: PublicSlot = { ...cyclusSlot, allow_single_booking: false, whole_slot_booking: true, price_per_session: 76.5 };
    render(<GuestBookingDialog slot={rlPadelSlot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);

    await waitFor(() => expect(screen.queryByRole('button', { name: /Hele cyclus/ })).toBeNull());
    expect(screen.queryByRole('button', { name: /Alleen deze sessie/ })).toBeNull();
    // Single-session (whole-court) booking stays available at the session price.
    expect(screen.getByRole('button', { name: /Afrekenen/ })).toBeInTheDocument();
    expect(screen.getAllByText(/76[.,]50/).length).toBeGreaterThan(0);
  });

  it('slots-only cyclus (allow_cyclus_booking=false): hides the whole-series option and books the single slot', async () => {
    // RL Padel model: the cycle sells individual sessions ONLY. No mode choice at all —
    // the dialog goes straight to single-session; the whole-series path is never offered.
    cyclusSessions.current = twoSessions;
    cyclusPublicRow.current = { settings: { allow_single_booking: true, allow_cyclus_booking: false } };
    invokeMock.mockResolvedValue({ data: { checkoutUrl: 'https://mollie.test/s/only' }, error: null });
    Object.defineProperty(window, 'location', { configurable: true, value: { hostname: 'localhost', set href(_v: string) {} } });

    render(<GuestBookingDialog slot={cyclusSlot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);

    // The flag loads async: the mode choice must disappear once settings arrive.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Hele cyclus/ })).toBeNull());
    expect(screen.queryByRole('button', { name: /Alleen deze sessie/ })).toBeNull();

    fillValid();
    fireEvent.click(screen.getByRole('button', { name: /Afrekenen/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('create-guest-slot-payment', {
      body: { slotId: 'slot-1', firstName: 'Jan', lastName: 'de Vries', email: 'jan@x.nl', phone: '0612345678', notes: undefined, whatsappOptIn: false },
    });
  });

  it('misconfigured cyclus (BOTH booking modes off) falls back to whole-cyclus so the server guard answers', async () => {
    // Never silently offer the single path the owner disabled; the edge fn refuses
    // cyclus_not_bookable and the guest gets the notBookable toast.
    cyclusSessions.current = twoSessions;
    cyclusPublicRow.current = { settings: { allow_cyclus_booking: false } };
    invokeMock.mockResolvedValue({
      data: null,
      error: { context: { json: async () => ({ error: 'cyclus_not_bookable' }) } },
    });

    const lockedSlot: PublicSlot = { ...cyclusSlot, allow_single_booking: false };
    render(<GuestBookingDialog slot={lockedSlot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);
    fillValid();
    const payBtn = screen.getByRole('button', { name: /Afrekenen/ });
    await waitFor(() => expect(payBtn).toBeEnabled());
    fireEvent.click(payBtn);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('create-guest-cyclus-payment', expect.anything()));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Deze training kan niet meer geboekt worden.'));
  });

  it('offers "add another session" inside a CartProvider: click parks the slot in the cart and closes', async () => {
    const onOpenChange = vi.fn();
    // future slot so the cart's hydration guard keeps it
    const futureSlot: PublicSlot = { ...slot, start_time: '2027-09-01T10:00:00Z', end_time: '2027-09-01T11:00:00Z' };
    render(
      <CartProvider>
        <GuestBookingDialog slot={futureSlot} open onOpenChange={onOpenChange} timezone="Europe/Amsterdam" />
      </CartProvider>,
    );

    const addBtn = screen.getByRole('button', { name: /Meerdere sessies boeken/ });
    fireEvent.click(addBtn);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem('bookingCart:v1') ?? '[]') as { id: string }[];
    expect(stored.map((s) => s.id)).toEqual(['slot-1']);
    // no payment call — checkout happens later via the cart flow
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('hides "add another session" for non-cartable slots and without a CartProvider', async () => {
    // split slot inside a provider → not cartable
    const splitSlot: PublicSlot = { ...slot, split_payment: true };
    const { unmount } = render(
      <CartProvider>
        <GuestBookingDialog slot={splitSlot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />
      </CartProvider>,
    );
    expect(screen.queryByRole('button', { name: /Meerdere sessies boeken/ })).toBeNull();
    unmount();

    // cartable slot but NO provider (embed/test contexts) → affordance simply absent
    render(<GuestBookingDialog slot={slot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);
    expect(screen.queryByRole('button', { name: /Meerdere sessies boeken/ })).toBeNull();
  });

  it('whole-slot cyclus session (allow_single=false, whole_slot=true): single option offered at FULL price', async () => {
    cyclusSessions.current = twoSessions;
    invokeMock.mockResolvedValue({ data: { checkoutUrl: 'https://mollie.test/ws' }, error: null });
    Object.defineProperty(window, 'location', { configurable: true, value: { hostname: 'localhost', set href(_v: string) {} } });

    const wholeSlot: PublicSlot = { ...cyclusSlot, allow_single_booking: false, whole_slot_booking: true, price_per_session: 76.5, max_participants: 4 };
    render(<GuestBookingDialog slot={wholeSlot} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);

    // the single-session mode is offered (whole-slot unlock) …
    fireEvent.click(await screen.findByRole('button', { name: /Alleen deze sessie/ }));
    // … at the FULL session price (€76.50 — never ÷ max_participants)
    expect(screen.getByText(/Prijs:/).textContent).toMatch(/76[.,]50/);

    fillValid();
    fireEvent.click(screen.getByRole('button', { name: /Afrekenen/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('create-guest-slot-payment', expect.anything()));
  });

  it('whole-slot unlock NEVER applies to split sessions (#352 stays closed)', async () => {
    cyclusSessions.current = twoSessions;
    invokeMock.mockResolvedValue({ data: { checkoutUrl: 'https://mollie.test/x' }, error: null });
    Object.defineProperty(window, 'location', { configurable: true, value: { hostname: 'localhost', set href(_v: string) {} } });

    const splitWhole: PublicSlot = { ...cyclusSlot, allow_single_booking: false, whole_slot_booking: true, split_payment: true };
    render(<GuestBookingDialog slot={splitWhole} open onOpenChange={() => {}} timezone="Europe/Amsterdam" />);
    expect(screen.queryByRole('button', { name: /Alleen deze sessie/ })).toBeNull();
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

  it('posts whatsappOptIn=false unless the guest ticks it, and true when they do', async () => {
    // The box is the ONLY thing the client contributes to consent — the tenant it is scoped to
    // is read off the slot server-side. So the one property worth pinning here is that an
    // untouched form never claims consent.
    renderDialog();
    fillValid();
    fireEvent.click(screen.getByTestId('whatsapp-optin'));
    fireEvent.click(screen.getByRole('button', { name: /Afrekenen/ }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock.mock.calls[0][1].body).toMatchObject({ whatsappOptIn: true });
  });
});
