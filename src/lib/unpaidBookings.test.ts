import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sortBookingsBySlotStartTime,
  mapUnpaidBookingRow,
  fetchUnpaidBookingsData,
  UNPAID_BOOKINGS_SELECT,
  unpaidBookingsQueryOptions,
  calculateOutstandingAmount,
  getUnpaidBookingGroupKey,
  groupUnpaidBookingsByPaymentObligation,
  buildUnpaidReminderSessionsHtml,
  markUnpaidBookingsPaid,
  setUnpaidBookingsReminderSent,
  type UnpaidBookingRow,
} from './unpaidBookings';
import { logger } from '@/lib/logger';

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/trainerDisplayNames', () => ({
  fetchTrainerDisplayNamesByProfileIds: vi.fn(),
}));

import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';

const fetchTrainerNamesMock = vi.mocked(fetchTrainerDisplayNamesByProfileIds);

function slot(overrides: Partial<UnpaidBookingRow['availability_slots']> & { start_time: string }) {
  return {
    end_time: '2026-06-10T11:00:00Z',
    trainer_id: 'trainer-1',
    cyclus_id: null as string | null,
    cyclus_name: null as string | null,
    price_per_session: 25,
    ...overrides,
  };
}

function row(overrides: Partial<UnpaidBookingRow> & { id: string }): UnpaidBookingRow {
  const base = {
    slot_id: 'slot-1',
    payment_amount: 20 as number | null,
    reminder_sent_at: null as string | null,
    player_id: 'player-1',
    guest_player_id: null,
    profiles: { full_name: 'Alex', email: 'alex@example.com' },
    guest_players: null,
    availability_slots: slot({ start_time: '2026-06-10T10:00:00Z' }),
  };
  return { ...base, ...overrides };
}

function mapLines(rows: UnpaidBookingRow[]) {
  const nameMap = new Map([['trainer-1', 'Coach Sam']]);
  return rows
    .map((r) => mapUnpaidBookingRow(r, nameMap))
    .filter((l): l is NonNullable<ReturnType<typeof mapUnpaidBookingRow>> => l != null);
}

function createMockClient(handlers: {
  academyTrainers?: { data: { trainer_profile_id: string }[] | null };
  bookings?: { data: unknown[] | null; error: { message: string; code?: string; details?: string; hint?: string } | null };
  bookingsUpdate?: { error: { message: string } | null };
}) {
  const bookingsFrom = vi.fn();
  const bookingsSelect = vi.fn(() => ({
    in: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockResolvedValue(handlers.bookings ?? { data: [], error: null }),
  }));
  const bookingsUpdateIn = vi.fn().mockResolvedValue(handlers.bookingsUpdate ?? { error: null });

  bookingsFrom.mockReturnValue({
    select: bookingsSelect,
    update: vi.fn(() => ({ in: bookingsUpdateIn })),
  });

  const client = {
    from: vi.fn((table: string) => {
      if (table === 'academy_trainers') {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => handlers.academyTrainers ?? { data: [], error: null },
            }),
          }),
        };
      }
      if (table === 'bookings') {
        bookingsFrom();
        return {
          select: bookingsSelect,
          update: vi.fn(() => ({ in: bookingsUpdateIn })),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  return { client: client as never, bookingsFrom, bookingsSelect, bookingsUpdateIn };
}

describe('calculateOutstandingAmount', () => {
  it('uses payment_amount when set', () => {
    expect(calculateOutstandingAmount(30, 25)).toBe(30);
  });

  it('falls back to price_per_session when payment_amount is null', () => {
    expect(calculateOutstandingAmount(null, 25)).toBe(25);
  });

  it('returns null for zero or negative amounts', () => {
    expect(calculateOutstandingAmount(0, 25)).toBeNull();
    expect(calculateOutstandingAmount(null, 0)).toBeNull();
  });
});

describe('getUnpaidBookingGroupKey', () => {
  it('groups by cyclus when cyclus_id is present', () => {
    const r = row({
      id: 'b1',
      availability_slots: slot({
        start_time: '2026-06-01T10:00:00Z',
        cyclus_id: 'cycle-1',
      }),
    });
    expect(getUnpaidBookingGroupKey(r)).toBe('player:player-1:cyclus:cycle-1');
  });

  it('groups by slot_id when no cyclus_id', () => {
    expect(getUnpaidBookingGroupKey(row({ id: 'b1', slot_id: 'slot-abc' }))).toBe(
      'player:player-1:slot:slot-abc',
    );
  });

  it('uses guest recipient when no player_id', () => {
    const r = row({
      id: 'b1',
      player_id: null,
      guest_player_id: 'guest-1',
      profiles: null,
      guest_players: { full_name: 'Guest', email: 'g@example.com' },
      slot_id: 'slot-x',
    });
    expect(getUnpaidBookingGroupKey(r)).toBe('guest:guest-1:slot:slot-x');
  });
});

describe('groupUnpaidBookingsByPaymentObligation', () => {
  it('merges 8 cycle bookings for one player into one group with summed amount', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      row({
        id: `b${i}`,
        slot_id: `slot-${i}`,
        payment_amount: 10,
        availability_slots: slot({
          start_time: `2026-07-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
          cyclus_id: 'cycle-1',
          cyclus_name: 'Summer Cycle',
        }),
      }),
    );
    const groups = groupUnpaidBookingsByPaymentObligation(mapLines(rows));
    expect(groups).toHaveLength(1);
    expect(groups[0].bookingIds).toHaveLength(8);
    expect(groups[0].amount).toBe(80);
    expect(groups[0].sessionCount).toBe(8);
    expect(groups[0].isCycleGroup).toBe(true);
    expect(groups[0].cyclusName).toBe('Summer Cycle');
  });

  it('creates one group per player in a split cycle', () => {
    const rows = [
      row({ id: 'b1', player_id: 'p1', payment_amount: 10, availability_slots: slot({ start_time: '2026-07-01T10:00:00Z', cyclus_id: 'c1', cyclus_name: 'Split' }) }),
      row({ id: 'b2', player_id: 'p2', profiles: { full_name: 'Bob', email: 'b@x.com' }, payment_amount: 10, availability_slots: slot({ start_time: '2026-07-02T10:00:00Z', cyclus_id: 'c1', cyclus_name: 'Split' }) }),
      row({ id: 'b3', player_id: 'p3', profiles: { full_name: 'Cara', email: 'c@x.com' }, payment_amount: 10, availability_slots: slot({ start_time: '2026-07-03T10:00:00Z', cyclus_id: 'c1', cyclus_name: 'Split' }) }),
    ];
    const groups = groupUnpaidBookingsByPaymentObligation(mapLines(rows));
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.bookingIds.length === 1)).toBe(true);
  });

  it('excludes €0 companion bookings so only payer group appears', () => {
    const rows = [
      row({ id: 'payer', player_id: 'p1', payment_amount: 50, availability_slots: slot({ start_time: '2026-07-01T10:00:00Z', cyclus_id: 'c1' }) }),
      row({ id: 'companion', player_id: 'p2', profiles: { full_name: 'Companion', email: '' }, payment_amount: 0, availability_slots: slot({ start_time: '2026-07-01T11:00:00Z', cyclus_id: 'c1' }) }),
    ];
    const lines = mapLines(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0].bookingId).toBe('payer');
  });

  it('picks latest reminder_sent_at in the group', () => {
    const rows = [
      row({ id: 'b1', reminder_sent_at: '2026-01-01T10:00:00Z', availability_slots: slot({ start_time: '2026-07-01T10:00:00Z', cyclus_id: 'c1' }) }),
      row({ id: 'b2', reminder_sent_at: '2026-03-01T10:00:00Z', availability_slots: slot({ start_time: '2026-07-02T10:00:00Z', cyclus_id: 'c1' }) }),
    ];
    const groups = groupUnpaidBookingsByPaymentObligation(mapLines(rows));
    expect(groups[0].reminderSentAt).toBe('2026-03-01T10:00:00Z');
  });

  it('groups non-cycle bookings by slot_id', () => {
    const rows = [row({ id: 'b1', slot_id: 'slot-only' })];
    const groups = groupUnpaidBookingsByPaymentObligation(mapLines(rows));
    expect(groups[0].isCycleGroup).toBe(false);
    expect(groups[0].id).toBe('player:player-1:slot:slot-only');
  });
});

describe('buildUnpaidReminderSessionsHtml', () => {
  it('includes all booking ids context in cycle summary', () => {
    const obligation: import('./unpaidBookings').UnpaidBooking = {
      id: 'player:p1:cyclus:c1',
      bookingIds: ['b1', 'b2'],
      slotId: 's1',
      playerName: 'Alex',
      playerEmail: 'a@x.com',
      playerId: 'p1',
      guestPlayerId: null,
      sessionDate: '01 Jul 2026',
      sessionTime: '10:00 - 11:00',
      amount: 40,
      cyclusName: 'Summer',
      cyclusId: 'c1',
      sessionCount: 2,
      isCycleGroup: true,
      reminderSentAt: null,
      trainerName: 'Coach',
    };
    const html = buildUnpaidReminderSessionsHtml(obligation);
    expect(html).toContain('Summer');
    expect(html).toContain('2 session');
    expect(html).toContain('€40.00');
  });
});

describe('markUnpaidBookingsPaid / setUnpaidBookingsReminderSent', () => {
  it('mark paid updates all booking IDs in the group', async () => {
    const { client, bookingsUpdateIn } = createMockClient({});
    await markUnpaidBookingsPaid(['b1', 'b2', 'b3'], client);
    expect(bookingsUpdateIn).toHaveBeenCalledWith('id', ['b1', 'b2', 'b3']);
  });

  it('reminder sent updates all booking IDs in the group', async () => {
    const { client, bookingsUpdateIn } = createMockClient({});
    await setUnpaidBookingsReminderSent(['b1', 'b2'], client);
    expect(bookingsUpdateIn).toHaveBeenCalledWith('id', ['b1', 'b2']);
  });

  it('skips update when bookingIds is empty', async () => {
    const { client, bookingsUpdateIn } = createMockClient({});
    await markUnpaidBookingsPaid([], client);
    expect(bookingsUpdateIn).not.toHaveBeenCalled();
  });
});

describe('sortBookingsBySlotStartTime', () => {
  it('sorts by availability_slots.start_time ascending', () => {
    const rows = [
      { id: 'b', availability_slots: { start_time: '2026-06-10T10:00:00Z' } },
      { id: 'a', availability_slots: { start_time: '2026-06-01T10:00:00Z' } },
      { id: 'c', availability_slots: { start_time: '2026-06-15T10:00:00Z' } },
    ];

    const sorted = sortBookingsBySlotStartTime(rows);
    expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('UNPAID_BOOKINGS_SELECT', () => {
  it('does not use invalid trainer_profiles → profiles:user_id embeds', () => {
    expect(UNPAID_BOOKINGS_SELECT).not.toContain('profiles:user_id');
    expect(UNPAID_BOOKINGS_SELECT).not.toContain('slot_trainer');
    expect(UNPAID_BOOKINGS_SELECT).toContain('cyclus_id');
  });
});

describe('mapUnpaidBookingRow', () => {
  it('maps trainer name from separate lookup map', () => {
    const nameMap = new Map([['trainer-1', 'Coach Sam']]);
    const mapped = mapUnpaidBookingRow(row({ id: 'booking-1' }), nameMap);
    expect(mapped?.trainerName).toBe('Coach Sam');
  });

  it('returns null when amount is zero', () => {
    expect(mapUnpaidBookingRow(row({ id: 'b', payment_amount: 0 }), new Map())).toBeNull();
  });
});

describe('fetchUnpaidBookingsData', () => {
  beforeEach(() => {
    vi.mocked(logger.error).mockClear();
    fetchTrainerNamesMock.mockReset();
    fetchTrainerNamesMock.mockResolvedValue(new Map([['trainer-1', 'Coach Sam']]));
  });

  it('returns grouped obligations not raw booking rows', async () => {
    const { client } = createMockClient({
      bookings: {
        data: [
          row({ id: 'b1', payment_amount: 10, availability_slots: slot({ start_time: '2026-07-01T10:00:00Z', cyclus_id: 'c1' }) }),
          row({ id: 'b2', payment_amount: 10, availability_slots: slot({ start_time: '2026-07-02T10:00:00Z', cyclus_id: 'c1' }) }),
        ],
        error: null,
      },
    });

    const result = await fetchUnpaidBookingsData('trainer-1', undefined, client);
    expect(result).toHaveLength(1);
    expect(result[0].bookingIds).toEqual(['b1', 'b2']);
    expect(result[0].amount).toBe(20);
  });

  it('returns [] without querying bookings when no trainer or academy id', async () => {
    const { client, bookingsFrom } = createMockClient({});
    const result = await fetchUnpaidBookingsData(undefined, undefined, client);
    expect(result).toEqual([]);
    expect(bookingsFrom).not.toHaveBeenCalled();
  });

  it('returns [] and logs once on Supabase error without throwing', async () => {
    const { client } = createMockClient({
      bookings: {
        data: null,
        error: { message: 'Bad operator', code: 'PGRST200', details: 'embed filter' },
      },
    });
    await expect(fetchUnpaidBookingsData('trainer-1', undefined, client)).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('unpaidBookingsQueryOptions', () => {
  it('disables retry to avoid repeated 400 spam', () => {
    expect(unpaidBookingsQueryOptions.retry).toBe(false);
  });
});
