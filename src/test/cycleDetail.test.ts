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
      { name: 'Alice', sessionCount: 2, playerId: 'PA', guestPlayerId: null, personId: null, refs: [{ playerId: 'PA', guestPlayerId: null }] }, // s1 + s2
      { name: 'Bob', sessionCount: 1, playerId: 'PB', guestPlayerId: null, personId: null, refs: [{ playerId: 'PB', guestPlayerId: null }] },
      { name: 'Charlie', sessionCount: 1, playerId: null, guestPlayerId: 'G1', personId: null, refs: [{ playerId: null, guestPlayerId: 'G1' }] },
      { name: 'Dave', sessionCount: 1, playerId: 'PD', guestPlayerId: null, personId: null, refs: [{ playerId: 'PD', guestPlayerId: null }] },
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

  it('FAM-02: a dual-keyed booking is the GUEST person — own name, XOR entry, separate from the parent', async () => {
    setMockData({
      availability_slots: [
        { id: 's1', cyclus_id: 'cy1', start_time: '2026-07-06T09:00:00Z', end_time: '2026-07-06T10:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: true, cyclus_name: 'Zomer' },
      ],
      bookings: [
        // The parent's own seat + the linked child's dual-keyed seat (signup-linker backfill) on ONE slot.
        { slot_id: 's1', player_id: 'PA', guest_player_id: null, status: 'confirmed', payment_status: 'paid', paid_externally: null },
        { slot_id: 's1', player_id: 'PA', guest_player_id: 'G1', status: 'confirmed', payment_status: 'paid', paid_externally: null },
      ],
      profiles: [{ id: 'PA', full_name: 'Parent' }],
      guest_players: [{ id: 'G1', full_name: 'Kid' }],
    });
    const d = await getCycleDetail('cy1');
    // Two people occupy two seats: bookedCount and the roster AGREE (M-17 dual-key mismatch fixed).
    expect(d.slots[0].bookedCount).toBe(2);
    expect(d.slots[0].playerNames.sort()).toEqual(['Kid', 'Parent']); // child shows their OWN name
    expect(d.totalPlayers).toBe(2);
    expect(d.roster).toEqual([
      { name: 'Kid', sessionCount: 1, playerId: null, guestPlayerId: 'G1', personId: null, refs: [{ playerId: null, guestPlayerId: 'G1' }] }, // XOR — guest person
      { name: 'Parent', sessionCount: 1, playerId: 'PA', guestPlayerId: null, personId: null, refs: [{ playerId: 'PA', guestPlayerId: null }] },
    ]);
  });

  it('FAM-02: a dual-keyed booking with a blank guest name falls back to the profile name', async () => {
    setMockData({
      availability_slots: [
        { id: 's1', cyclus_id: 'cy1', start_time: '2026-07-06T09:00:00Z', end_time: '2026-07-06T10:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: true, cyclus_name: 'Zomer' },
      ],
      bookings: [
        { slot_id: 's1', player_id: 'PA', guest_player_id: 'G1', status: 'confirmed', payment_status: 'paid', paid_externally: null },
      ],
      profiles: [{ id: 'PA', full_name: 'Parent' }],
      guest_players: [{ id: 'G1', full_name: null }],
    });
    const d = await getCycleDetail('cy1');
    expect(d.roster).toEqual([
      { name: 'Parent', sessionCount: 1, playerId: null, guestPlayerId: 'G1', personId: null, refs: [{ playerId: null, guestPlayerId: 'G1' }] }, // still the guest's entry
    ]);
  });
});

describe('getCycleDetail — Phase 3.1 person-keyed roster', () => {
  it('a MERGED person\'s seats under BOTH old keys collapse into ONE entry carrying both refs', async () => {
    setMockData({
      availability_slots: [
        { id: 's1', cyclus_id: 'cy1', start_time: '2026-07-06T09:00:00Z', end_time: '2026-07-06T10:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: true, cyclus_name: 'Zomer' },
        { id: 's2', cyclus_id: 'cy1', start_time: '2026-07-13T09:00:00Z', end_time: '2026-07-13T10:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: true, cyclus_name: 'Zomer' },
      ],
      bookings: [
        // one human: a guest-keyed seat on s1 and a profile-keyed seat on s2 — same person_id
        { slot_id: 's1', player_id: null, guest_player_id: 'G1', person_id: 'PERSON1', status: 'confirmed', payment_status: 'paid', paid_externally: null },
        { slot_id: 's2', player_id: 'PA', guest_player_id: null, person_id: 'PERSON1', status: 'confirmed', payment_status: 'paid', paid_externally: null },
      ],
      profiles: [{ id: 'PA', full_name: 'Mark Jan (profiel)' }],
      guest_players: [{ id: 'G1', full_name: 'Mark Jan (gast)' }],
      persons: [{ id: 'PERSON1', full_name: 'Mark Jan Alewijn' }],
    });
    const d = await getCycleDetail('cy1');
    expect(d.totalPlayers).toBe(1); // one human, one entry
    expect(d.roster).toHaveLength(1);
    const entry = d.roster[0];
    expect(entry.personId).toBe('PERSON1');
    expect(entry.name).toBe('Mark Jan Alewijn'); // the person's own merged name wins
    expect(entry.sessionCount).toBe(2);
    expect(entry.guestPlayerId).toBe('G1'); // primary ref guest-preferred
    expect(entry.refs).toHaveLength(2);     // both old-world refs — writes must cover both
  });

  it('unstamped rows of DIFFERENT people never collapse (fallback keeps FAM-02)', async () => {
    setMockData({
      availability_slots: [
        { id: 's1', cyclus_id: 'cy1', start_time: '2026-07-06T09:00:00Z', end_time: '2026-07-06T10:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: true, cyclus_name: 'Zomer' },
      ],
      bookings: [
        { slot_id: 's1', player_id: 'PA', guest_player_id: null, person_id: null, status: 'confirmed', payment_status: 'paid', paid_externally: null },
        { slot_id: 's1', player_id: null, guest_player_id: 'G1', person_id: null, status: 'confirmed', payment_status: 'paid', paid_externally: null },
      ],
      profiles: [{ id: 'PA', full_name: 'Parent' }],
      guest_players: [{ id: 'G1', full_name: 'Kid' }],
    });
    const d = await getCycleDetail('cy1');
    expect(d.totalPlayers).toBe(2);
  });
});

describe('getCycleDetail — merged-person edge shapes (verification pins)', () => {
  it('same-slot DUPLICATE seats of a merged person: names listed per seat, counts honest, refs both', async () => {
    setMockData({
      availability_slots: [
        { id: 's1', cyclus_id: 'cy1', start_time: '2026-07-06T09:00:00Z', end_time: '2026-07-06T10:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: true, cyclus_name: 'Zomer' },
      ],
      bookings: [
        { slot_id: 's1', player_id: null, guest_player_id: 'G1', person_id: 'PERSON1', status: 'confirmed', payment_status: 'paid', paid_externally: null },
        { slot_id: 's1', player_id: 'PA', guest_player_id: null, person_id: 'PERSON1', status: 'confirmed', payment_status: 'paid', paid_externally: null },
      ],
      profiles: [{ id: 'PA', full_name: 'Mark Jan (profiel)' }],
      guest_players: [{ id: 'G1', full_name: 'Mark Jan (gast)' }],
      persons: [{ id: 'PERSON1', full_name: 'Mark Jan Alewijn' }],
    });
    const d = await getCycleDetail('cy1');
    // the duplicate seat is surfaced HONESTLY: two seats, the same name twice, one roster entry
    expect(d.slots[0].bookedCount).toBe(2);
    expect(d.slots[0].playerNames).toEqual(['Mark Jan Alewijn', 'Mark Jan Alewijn']);
    expect(d.roster).toHaveLength(1);
    expect(d.roster[0].sessionCount).toBe(2);
    expect(d.roster[0].refs).toHaveLength(2);
  });

  it('primary ref promotes to the guest side regardless of booking ORDER (profile row first)', async () => {
    setMockData({
      availability_slots: [
        { id: 's1', cyclus_id: 'cy1', start_time: '2026-07-06T09:00:00Z', end_time: '2026-07-06T10:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: true, cyclus_name: 'Zomer' },
        { id: 's2', cyclus_id: 'cy1', start_time: '2026-07-13T09:00:00Z', end_time: '2026-07-13T10:00:00Z', trainer_id: 'tr1', max_participants: 4, is_public: true, cyclus_name: 'Zomer' },
      ],
      bookings: [
        // profile-keyed row FIRST — the guest ref arrives second and must still become primary
        { slot_id: 's1', player_id: 'PA', guest_player_id: null, person_id: 'PERSON1', status: 'confirmed', payment_status: 'paid', paid_externally: null },
        { slot_id: 's2', player_id: null, guest_player_id: 'G1', person_id: 'PERSON1', status: 'confirmed', payment_status: 'paid', paid_externally: null },
      ],
      profiles: [{ id: 'PA', full_name: 'Mark Jan (profiel)' }],
      guest_players: [{ id: 'G1', full_name: 'Mark Jan (gast)' }],
      persons: [{ id: 'PERSON1', full_name: 'Mark Jan Alewijn' }],
    });
    const d = await getCycleDetail('cy1');
    expect(d.roster).toHaveLength(1);
    expect(d.roster[0].guestPlayerId).toBe('G1'); // promoted — bookable side wins as primary
    expect(d.roster[0].playerId).toBeNull();
    expect(d.roster[0].refs).toHaveLength(2);
  });
});
