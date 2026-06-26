import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabaseMock, setMockData } from './fixtures/supabaseMock';

vi.mock('@/lib/supabaseClient', () => ({ supabase: supabaseMock }));
// getCycle is reused + has its own coverage; mock it so this test isolates the slot/roster aggregation.
vi.mock('@/lib/cycles', () => ({ getCycle: vi.fn(() => Promise.resolve({ id: 'cy1', name: 'Zomer 2026' })) }));

import { getCycleDetail } from '@/lib/cycleDetail';

beforeEach(() =>
  setMockData({
    availability_slots: [
      { id: 's1', cyclus_id: 'cy1', start_time: '2026-07-06T09:00:00Z', end_time: '2026-07-06T10:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: true, cyclus_name: 'Zomer' },
      { id: 's2', cyclus_id: 'cy1', start_time: '2026-07-06T10:00:00Z', end_time: '2026-07-06T11:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: true, cyclus_name: 'Zomer' },
      { id: 's3', cyclus_id: 'cy1', start_time: '2026-07-06T11:00:00Z', end_time: '2026-07-06T12:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: false, cyclus_name: 'Zomer' },
      { id: 's9', cyclus_id: 'cy2', start_time: '2026-07-06T09:00:00Z', end_time: '2026-07-06T10:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: true, cyclus_name: 'Andere' },
    ],
    bookings: [
      { slot_id: 's1', player_id: 'PA', guest_player_id: null, status: 'confirmed', payment_status: 'paid', paid_externally: null },
      { slot_id: 's1', player_id: 'PB', guest_player_id: null, status: 'confirmed', payment_status: 'paid', paid_externally: null },
      { slot_id: 's1', player_id: 'PC', guest_player_id: null, status: 'cancelled', payment_status: null, paid_externally: null }, // excluded (not occupying)
      { slot_id: 's2', player_id: 'PA', guest_player_id: null, status: 'confirmed', payment_status: 'paid', paid_externally: null },
      { slot_id: 's2', player_id: null, guest_player_id: 'G1', status: 'pending', payment_status: 'pending', paid_externally: null }, // unpaid
      { slot_id: 's3', player_id: 'PD', guest_player_id: null, status: 'pending_approval', payment_status: null, paid_externally: null }, // occupying but NOT payment-active
      { slot_id: 's9', player_id: 'PE', guest_player_id: null, status: 'confirmed', payment_status: 'paid', paid_externally: null }, // other cycle
    ],
    profiles: [
      { id: 'PA', full_name: 'Alice' },
      { id: 'PB', full_name: 'Bob' },
      { id: 'PD', full_name: 'Dave' },
    ],
    guest_players: [{ id: 'G1', full_name: 'Charlie' }],
  }),
);

describe('getCycleDetail (Slice 9 data layer)', () => {
  it('returns only the requested cycle\'s slots, with per-slot players + booked count', async () => {
    const d = await getCycleDetail('cy1');
    expect(d.totalSlots).toBe(3); // s9 (cy2) excluded
    expect(d.slots.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(d.slots[0]).toMatchObject({ playerNames: ['Alice', 'Bob'], bookedCount: 2 });
    expect(d.slots[1]).toMatchObject({ playerNames: ['Alice', 'Charlie'], bookedCount: 2 }); // guest name resolved
    expect(d.slots[2]).toMatchObject({ playerNames: ['Dave'], bookedCount: 1 }); // pending_approval still occupies
  });

  it('per-slot payment status: all_paid / has_unpaid / no_players (pending_approval is not payment-active)', async () => {
    const d = await getCycleDetail('cy1');
    expect(d.slots[0].paymentStatus).toBe('all_paid'); // PA+PB confirmed+paid
    expect(d.slots[1].paymentStatus).toBe('has_unpaid'); // guest pending+unpaid
    expect(d.slots[2].paymentStatus).toBe('no_players'); // only a pending_approval booking → no ACTIVE booking
  });

  it('roster: distinct players across the cycle, session count desc then name', async () => {
    const d = await getCycleDetail('cy1');
    expect(d.totalPlayers).toBe(4);
    expect(d.roster).toEqual([
      { name: 'Alice', sessionCount: 2 }, // s1 + s2
      { name: 'Bob', sessionCount: 1 },
      { name: 'Charlie', sessionCount: 1 },
      { name: 'Dave', sessionCount: 1 },
    ]);
  });

  it('carries the cycle (via getCycle) + empty roster for a slotless cycle', async () => {
    const d = await getCycleDetail('cy1');
    expect(d.cycle?.name).toBe('Zomer 2026');
    setMockData({ availability_slots: [], bookings: [] });
    const empty = await getCycleDetail('cy-empty');
    expect(empty.totalSlots).toBe(0);
    expect(empty.roster).toEqual([]);
  });
});
