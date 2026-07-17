import { describe, it, expect, vi, beforeEach } from 'vitest';

// Record builder calls so the pure-profile shape of the direct read is assertable.
const calls: { method: string; args: unknown[] }[] = [];
let bookingsData: unknown[] = [];
let reportsData: { slot_id: string }[] = [];
let linkedRows: unknown[] = [];

function makeChain(table: string) {
  const result = () => ({ data: table === 'bookings' ? bookingsData : reportsData, error: null });
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'gte', 'lt', 'order', 'range', 'limit']) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: `${table}.${m}`, args });
      return chain;
    };
  }
  (chain as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) => resolve(result());
  return chain;
}

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: (table: string) => makeChain(table) },
}));
vi.mock('@/lib/playerBookings', () => ({
  fetchLinkedGuestBookingRows: vi.fn(() => Promise.resolve(linkedRows)),
}));
vi.mock('@/lib/sessionReports', () => ({
  fetchTrainerSlotSummaries: vi.fn(() => Promise.resolve(new Map<string, string>())),
}));

import { fetchPendingPlayerSlots } from './pendingAttendance';

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

const directRow = (id: string, slotId: string, start: string) => ({
  id,
  status: 'confirmed',
  slot_id: slotId,
  availability_slots: { id: slotId, start_time: start, cyclus_name: 'Zomer', location_id: null, locations: { name: 'Club Noord' } },
});
const linkedRow = (id: string, slotId: string, start: string, status = 'confirmed') => ({
  id,
  slot_id: slotId,
  status,
  availability_slots: { start_time: start, cyclus_name: 'Winter', locations: { name: 'Club Zuid' } },
  is_linked_guest: true,
});

beforeEach(() => {
  calls.length = 0;
  bookingsData = [];
  reportsData = [];
  linkedRows = [];
});

describe('fetchPendingPlayerSlots — person-keyed (Phase 3.3-attendance part 2)', () => {
  it('the direct read is PURE-PROFILE: player_id = me AND guest_player_id IS NULL', async () => {
    await fetchPendingPlayerSlots('P1');
    expect(calls.find((c) => c.method === 'bookings.eq')?.args).toEqual(['player_id', 'P1']);
    expect(calls.find((c) => c.method === 'bookings.is')?.args).toEqual(['guest_player_id', null]);
  });

  it('merges guest-side sessions from the frozen RPC into the pending list', async () => {
    bookingsData = [directRow('b1', 's1', daysAgo(3))];
    linkedRows = [linkedRow('b2', 's2', daysAgo(5))];
    const slots = await fetchPendingPlayerSlots('P1');
    expect(slots.map((s) => s.slotId).sort()).toEqual(['s1', 's2']);
    expect(slots.find((s) => s.slotId === 's2')?.locationName).toBe('Club Zuid');
  });

  it('window + status filters apply to the merged guest rows (the direct query filters server-side)', async () => {
    linkedRows = [
      linkedRow('b1', 's1', daysAgo(3)),            // in window → prompts
      linkedRow('b2', 's2', daysAgo(20)),           // too old
      linkedRow('b3', 's3', daysAgo(-1)),           // in the future
      linkedRow('b4', 's4', daysAgo(2), 'cancelled'), // not reportable
    ];
    const slots = await fetchPendingPlayerSlots('P1');
    expect(slots.map((s) => s.slotId)).toEqual(['s1']);
  });

  it('a merged person seated under BOTH keys on one session gets ONE prompt', async () => {
    bookingsData = [directRow('b1', 's1', daysAgo(3))];
    linkedRows = [linkedRow('b2', 's1', daysAgo(3))];
    const slots = await fetchPendingPlayerSlots('P1');
    expect(slots).toHaveLength(1);
    expect(slots[0].slotId).toBe('s1');
  });

  it('already-reported slots are excluded — for guest-side sessions too', async () => {
    linkedRows = [linkedRow('b1', 's1', daysAgo(3)), linkedRow('b2', 's2', daysAgo(4))];
    reportsData = [{ slot_id: 's1' }];
    const slots = await fetchPendingPlayerSlots('P1');
    expect(slots.map((s) => s.slotId)).toEqual(['s2']);
  });

  it('returns [] when there is nothing pending', async () => {
    expect(await fetchPendingPlayerSlots('P1')).toEqual([]);
  });
});
