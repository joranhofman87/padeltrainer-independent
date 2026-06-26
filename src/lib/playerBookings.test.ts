import { describe, it, expect, vi, beforeEach } from 'vitest';

// Record every query-builder call so we can assert the filters each fetch applies.
const calls: { method: string; args: unknown[] }[] = [];
let bookingsData: unknown[] = [];

function makeChain(getData: () => unknown[]) {
  const result = () => ({ data: getData(), error: null });
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'not', 'gte', 'order', 'range']) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }
  // Thenable: awaiting the chain at any terminal point resolves to { data, error }.
  (chain as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) => resolve(result());
  return chain;
}

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] });
      return makeChain(() => (table === 'bookings' ? bookingsData : []));
    },
  },
}));
vi.mock('@/lib/trainerDisplayNames', () => ({
  fetchTrainerDisplayNamesByProfileIds: vi.fn().mockResolvedValue(new Map()),
}));

import { fetchUpcomingPlayerBookings, fetchPlayerBookingsPage } from './playerBookings';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  slot_id: 's1',
  status: 'confirmed',
  payment_status: 'pending',
  paid_externally: false,
  notes: null,
  created_at: '2026-01-01T00:00:00Z',
  availability_slots: {
    start_time: '2026-07-01T18:00:00Z',
    end_time: '2026-07-01T19:00:00Z',
    trainer_id: 't1',
    price_per_session: 30,
    cyclus_name: 'C',
    locations: { name: 'Court' },
  },
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  bookingsData = [];
});

describe('fetchUpcomingPlayerBookings', () => {
  it('filters to future, non-cancelled, inner-joined slots', async () => {
    await fetchUpcomingPlayerBookings('p1');
    const neq = calls.find((c) => c.method === 'neq');
    const gte = calls.find((c) => c.method === 'gte');
    expect(neq?.args).toEqual(['status', 'cancelled']);
    expect(gte?.args[0]).toBe('availability_slots.start_time'); // filters the inner-joined slot
  });
});

describe('fetchPlayerBookingsPage', () => {
  it('hasMore=true on a full page; excludes upcoming ids at the DB + ranges the offset', async () => {
    bookingsData = [row({ id: 'b0' }), row({ id: 'b1' }), row({ id: 'b2' })];
    const res = await fetchPlayerBookingsPage('p1', 3, 0, ['u1', 'u2']);
    expect(res.hasMore).toBe(true); // raw page length === limit
    expect(calls.find((c) => c.method === 'not')?.args).toEqual(['id', 'in', '(u1,u2)']);
    expect(calls.find((c) => c.method === 'range')?.args).toEqual([0, 2]);
    expect(res.bookings[0].trainer_name).toBe('Trainer'); // empty name map → fallback
  });

  it('hasMore=false on a partial page; no exclusion filter when excludeIds is empty', async () => {
    bookingsData = [row()];
    const res = await fetchPlayerBookingsPage('p1', 3, 24, []);
    expect(res.hasMore).toBe(false);
    expect(calls.find((c) => c.method === 'not')).toBeUndefined();
    expect(calls.find((c) => c.method === 'range')?.args).toEqual([24, 26]);
  });
});
