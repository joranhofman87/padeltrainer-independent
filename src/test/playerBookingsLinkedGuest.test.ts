import { describe, it, expect, beforeEach, vi } from 'vitest';
import { supabaseMock, setMockData } from './fixtures/supabaseMock';

vi.mock('@/lib/supabaseClient', () => ({ supabase: supabaseMock }));
// Isolate the merge/paid logic from trainer-name resolution (its own coverage).
vi.mock('@/lib/trainerDisplayNames', () => ({
  fetchTrainerDisplayNamesByProfileIds: vi.fn(() => Promise.resolve(new Map<string, string>())),
}));

import {
  fetchPlayerBookings,
  fetchLinkedGuestBookingRows,
  selectFutureActiveGuestRows,
  selectPastGuestRows,
  type RawBookingRow,
} from '@/lib/playerBookings';

const slot = (start: string) => ({
  start_time: start,
  end_time: start,
  trainer_id: 'tr1',
  price_per_session: 10,
  cyclus_name: 'Maandag',
  locations: { name: 'Court 1' },
});

const guestRow = (id: string, start: string | null, status = 'confirmed', created = '2026-01-01T00:00:00Z'): RawBookingRow => ({
  id,
  slot_id: `slot-${id}`,
  status,
  payment_status: 'pending',
  paid_externally: null,
  notes: null,
  created_at: created,
  availability_slots: start ? slot(start) : null,
});

const NOW = '2026-06-01T00:00:00Z';
const FUTURE = '2026-09-01T00:00:00Z';
const PAST = '2026-01-15T00:00:00Z';

beforeEach(() => setMockData({}));

describe('selectFutureActiveGuestRows', () => {
  it('keeps only not-cancelled rows with a future slot', () => {
    const rows = [
      guestRow('future', FUTURE),
      guestRow('past', PAST),
      guestRow('cancelledFuture', FUTURE, 'cancelled'),
      guestRow('noSlot', null),
    ];
    expect(selectFutureActiveGuestRows(rows, NOW).map((r) => r.id)).toEqual(['future']);
  });
});

describe('selectPastGuestRows', () => {
  it('keeps everything NOT upcoming (cancelled / past / no-slot), minus excludeIds', () => {
    const rows = [
      guestRow('future', FUTURE), // upcoming → dropped
      guestRow('past', PAST),
      guestRow('cancelledFuture', FUTURE, 'cancelled'),
      guestRow('noSlot', null),
      guestRow('alreadyShown', PAST),
    ];
    expect(selectPastGuestRows(rows, NOW, ['alreadyShown']).map((r) => r.id).sort()).toEqual([
      'cancelledFuture',
      'noSlot',
      'past',
    ]);
  });
});

describe('fetchLinkedGuestBookingRows', () => {
  it('returns [] when the RPC is not deployed (PGRST202) — never blanks the page', async () => {
    setMockData({}, { get_my_linked_guest_bookings: () => ({ error: { code: 'PGRST202' } }) });
    expect(await fetchLinkedGuestBookingRows()).toEqual([]);
  });

  it('returns [] on any other RPC error (best-effort supplementary rows)', async () => {
    setMockData({}, { get_my_linked_guest_bookings: () => ({ error: { code: 'XYZ', message: 'boom' } }) });
    expect(await fetchLinkedGuestBookingRows()).toEqual([]);
  });

  it('returns the RPC rows on success', async () => {
    setMockData({}, { get_my_linked_guest_bookings: () => ({ data: [guestRow('g1', FUTURE)] }) });
    expect((await fetchLinkedGuestBookingRows()).map((r) => r.id)).toEqual(['g1']);
  });
});

describe('fetchPlayerBookings — merges linked-guest rows + guest-aware paid override', () => {
  it('merges player_id + linked-guest bookings, sorts newest-created first, overrides paid', async () => {
    setMockData(
      {
        bookings: [
          { id: 'p1', player_id: 'me', slot_id: 's1', status: 'confirmed', payment_status: 'pending', paid_externally: null, notes: null, created_at: '2026-01-02T00:00:00Z', availability_slots: slot(FUTURE) },
        ],
      },
      {
        // a guest-keyed booking (newer) that the player_id query can't see, covered by a paid invoice
        get_my_linked_guest_bookings: () => ({ data: [guestRow('g1', FUTURE, 'confirmed', '2026-01-03T00:00:00Z')] }),
        get_my_paid_booking_ids: () => ({ data: [{ booking_id: 'g1' }] }),
      },
    );
    const res = await fetchPlayerBookings('me');
    expect(res.map((r) => r.id)).toEqual(['g1', 'p1']); // created_at desc
    expect(res.find((r) => r.id === 'g1')?.payment_status).toBe('paid'); // RPC marked it paid
    expect(res.find((r) => r.id === 'p1')?.payment_status).toBe('pending'); // untouched
    // The linked-guest row is flagged read-only (player can't cancel it → UI hides Cancel).
    expect(res.find((r) => r.id === 'g1')?.is_linked_guest).toBe(true);
    expect(res.find((r) => r.id === 'p1')?.is_linked_guest).toBe(false);
  });

  it('falls back to the legacy player_id invoices read for paid ids when the RPC is absent (PGRST202)', async () => {
    setMockData(
      {
        bookings: [
          { id: 'p1', player_id: 'me', slot_id: 's1', status: 'pending', payment_status: 'pending', paid_externally: null, notes: null, created_at: '2026-01-02T00:00:00Z', availability_slots: slot(FUTURE) },
        ],
        invoices: [{ player_id: 'me', status: 'paid', booking_ids: ['p1'], paid_at: '2026-01-05T00:00:00Z' }],
      },
      {
        get_my_linked_guest_bookings: () => ({ data: [] }),
        get_my_paid_booking_ids: () => ({ error: { code: 'PGRST202' } }),
      },
    );
    const res = await fetchPlayerBookings('me');
    expect(res).toHaveLength(1);
    expect(res[0].payment_status).toBe('paid'); // fallback invoices read applied the override
    expect(res[0].status).toBe('confirmed'); // pending → confirmed once effectively paid
  });
});
