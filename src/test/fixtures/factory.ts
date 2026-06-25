/**
 * Phase 4 F1 — deterministic test fixtures for the slots/cycles/registrations core.
 *
 * Builders produce minimal-but-realistic rows; every id is a stable sequence (NO Date.now /
 * Math.random) so snapshots/goldens are reproducible. `makeCycleWith(10_000)` is the scale harness
 * the 10k-slot assertions use. Call `resetFactorySeq()` in a beforeEach for stable ids per test.
 */
import type { Cycle, CycleSettings } from '@/lib/cycles';
import type { Registration } from '@/lib/registrations';

let _seq = 0;
const nextId = (prefix: string): string => `${prefix}-${(++_seq).toString().padStart(6, '0')}`;
/** Reset the id counter so ids are stable within a test (call in beforeEach). */
export function resetFactorySeq(): void {
  _seq = 0;
}

// ---- core entities -----------------------------------------------------------------------------

export function makeCycle(over: Partial<Cycle> = {}): Cycle {
  const id = over.id ?? nextId('cyc');
  return {
    id,
    owner_type: 'academy',
    owner_id: 'acad-1',
    name: 'Test cycle',
    description: null,
    start_date: '2026-04-01',
    end_date: '2026-06-24',
    enrollment_deadline: null,
    is_always_open: false,
    settings: {} as CycleSettings,
    status: 'open',
    type: 'cyclus',
    location_id: 'loc-1',
    price_per_session: 20,
    total_price: null,
    currency: 'EUR',
    terms: null,
    price_table: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export function makeRegistration(over: Partial<Registration> = {}): Registration {
  const id = over.id ?? nextId('reg');
  return {
    id,
    source_cycle_id: over.source_cycle_id ?? nextId('cyc'),
    owner_type: 'academy',
    owner_id: 'acad-1',
    format: 'registration',
    name: 'Test registration',
    description: null,
    start_date: '2026-04-01',
    end_date: '2026-06-24',
    enrollment_deadline: null,
    status: 'open',
    total_price: null,
    currency: 'EUR',
    price_table: null,
    location_id: 'loc-1',
    settings: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export interface SlotRow {
  id: string;
  cyclus_id: string | null;
  trainer_id: string | null;
  location_id: string | null;
  start_time: string;
  end_time: string;
  price_per_session: number | null;
  max_participants: number;
  status: string;
  split_payment: boolean | null;
  prices_include_vat: boolean | null;
}

export function makeSlot(over: Partial<SlotRow> = {}): SlotRow {
  const id = over.id ?? nextId('slot');
  return {
    id,
    cyclus_id: 'cyc-000001',
    trainer_id: 'trn-1',
    location_id: 'loc-1',
    start_time: '2026-04-06T17:00:00.000Z',
    end_time: '2026-04-06T18:00:00.000Z',
    price_per_session: 20,
    max_participants: 4,
    status: 'open',
    split_payment: false,
    prices_include_vat: true,
    ...over,
  };
}

export interface BookingRow {
  id: string;
  slot_id: string;
  player_id: string | null;
  guest_player_id: string | null;
  status: string;
  payment_amount: number | null;
  payment_status: string | null;
}

export function makeBooking(over: Partial<BookingRow> = {}): BookingRow {
  const id = over.id ?? nextId('bk');
  return {
    id,
    slot_id: 'slot-000001',
    player_id: 'ply-1',
    guest_player_id: null,
    status: 'confirmed',
    payment_amount: null,
    payment_status: 'unpaid',
    ...over,
  };
}

export interface InvoiceRow {
  id: string;
  cycle_id: string | null;
  registration_id: string | null;
  status: string;
  total: number;
  subtotal: number;
  vat_amount: number;
  vat_rate: number;
  line_items: unknown;
}

export function makeInvoice(over: Partial<InvoiceRow> = {}): InvoiceRow {
  const id = over.id ?? nextId('inv');
  return {
    id,
    cycle_id: null,
    registration_id: null,
    status: 'sent',
    total: 171,
    subtotal: 156.88,
    vat_amount: 14.12,
    vat_rate: 9,
    line_items: [{ description: 'Training', quantity: 1, unit_price: 171 }],
    ...over,
  };
}

// ---- the 10k scale harness ---------------------------------------------------------------------

export interface CycleWithSlots {
  cycle: Cycle;
  slots: SlotRow[];
  bookings: BookingRow[];
}

/**
 * A cycle owning `n` slots — the scale fixture for 10k-slot assertions. Slots are spread one per
 * day from start_time; `bookedRatio` (0..1) of them get one confirmed booking. Fully deterministic.
 */
export function makeCycleWith(
  n: number,
  opts: { bookedRatio?: number; pricePerSession?: number; cycleOver?: Partial<Cycle> } = {},
): CycleWithSlots {
  const { bookedRatio = 0, pricePerSession = 20 } = opts;
  const cycle = makeCycle({ type: 'cyclus', price_per_session: pricePerSession, ...opts.cycleOver });
  const slots: SlotRow[] = [];
  const bookings: BookingRow[] = [];
  const base = Date.UTC(2026, 3, 6, 17, 0, 0); // 2026-04-06 17:00Z, deterministic
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = 0; i < n; i++) {
    const start = base + i * dayMs;
    const slot = makeSlot({
      id: `slot-${(i + 1).toString().padStart(7, '0')}`,
      cyclus_id: cycle.id,
      price_per_session: pricePerSession,
      start_time: new Date(start).toISOString(),
      end_time: new Date(start + 60 * 60 * 1000).toISOString(),
    });
    slots.push(slot);
    if (bookedRatio > 0 && i % Math.max(1, Math.round(1 / bookedRatio)) === 0) {
      bookings.push(makeBooking({ id: `bk-${(i + 1).toString().padStart(7, '0')}`, slot_id: slot.id }));
    }
  }
  return { cycle, slots, bookings };
}
