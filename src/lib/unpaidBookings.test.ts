import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sortBookingsBySlotStartTime,
  mapUnpaidBookingRow,
  fetchUnpaidBookingsData,
  UNPAID_BOOKINGS_SELECT,
  unpaidBookingsQueryOptions,
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

function createMockClient(handlers: {
  academyTrainers?: { data: { trainer_profile_id: string }[] | null };
  bookings?: { data: unknown[] | null; error: { message: string; code?: string; details?: string; hint?: string } | null };
}) {
  const bookingsFrom = vi.fn();
  const bookingsSelect = vi.fn(() => ({
    in: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockResolvedValue(handlers.bookings ?? { data: [], error: null }),
  }));

  bookingsFrom.mockReturnValue({ select: bookingsSelect });

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
        return { select: bookingsSelect };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  return { client: client as never, bookingsFrom, bookingsSelect };
}

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

  it('returns empty array unchanged', () => {
    expect(sortBookingsBySlotStartTime([])).toEqual([]);
  });
});

describe('UNPAID_BOOKINGS_SELECT', () => {
  it('does not use invalid trainer_profiles → profiles:user_id embeds', () => {
    expect(UNPAID_BOOKINGS_SELECT).not.toContain('profiles:user_id');
    expect(UNPAID_BOOKINGS_SELECT).not.toContain('slot_trainer');
    expect(UNPAID_BOOKINGS_SELECT).not.toContain('trainer_profiles:trainer_id');
    expect(UNPAID_BOOKINGS_SELECT).toContain('trainer_id');
  });
});

describe('mapUnpaidBookingRow', () => {
  const baseRow = {
    id: 'booking-1',
    slot_id: 'slot-1',
    payment_amount: 25,
    reminder_sent_at: null,
    player_id: 'player-1',
    guest_player_id: null,
    profiles: { full_name: 'Alex Player', email: 'alex@example.com' },
    guest_players: null,
    availability_slots: {
      start_time: '2026-06-10T10:00:00Z',
      end_time: '2026-06-10T11:00:00Z',
      trainer_id: 'trainer-1',
      cyclus_name: 'Summer',
      price_per_session: 30,
    },
  };

  it('maps trainer name from separate lookup map', () => {
    const nameMap = new Map([['trainer-1', 'Coach Sam']]);
    expect(mapUnpaidBookingRow(baseRow, nameMap).trainerName).toBe('Coach Sam');
  });

  it('falls back to Trainer when lookup map has no entry', () => {
    expect(mapUnpaidBookingRow(baseRow, new Map()).trainerName).toBe('Trainer');
  });
});

describe('fetchUnpaidBookingsData', () => {
  beforeEach(() => {
    vi.mocked(logger.error).mockClear();
    fetchTrainerNamesMock.mockReset();
    fetchTrainerNamesMock.mockResolvedValue(new Map([['trainer-1', 'Coach Sam']]));
  });

  it('returns [] without querying bookings when no trainer or academy id', async () => {
    const { client, bookingsFrom } = createMockClient({});
    const result = await fetchUnpaidBookingsData(undefined, undefined, client);
    expect(result).toEqual([]);
    expect(bookingsFrom).not.toHaveBeenCalled();
  });

  it('returns [] without querying bookings when academy has no active trainers', async () => {
    const { client, bookingsFrom } = createMockClient({
      academyTrainers: { data: [] },
    });
    const result = await fetchUnpaidBookingsData(undefined, 'academy-1', client);
    expect(result).toEqual([]);
    expect(bookingsFrom).not.toHaveBeenCalled();
  });

  it('fetches trainer names separately and maps rows', async () => {
    const { client } = createMockClient({
      bookings: {
        data: [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            payment_amount: 20,
            reminder_sent_at: null,
            player_id: 'p1',
            guest_player_id: null,
            profiles: { full_name: 'Player', email: 'p@example.com' },
            guest_players: null,
            availability_slots: {
              start_time: '2026-07-01T10:00:00Z',
              end_time: '2026-07-01T11:00:00Z',
              trainer_id: 'trainer-1',
              cyclus_name: null,
              price_per_session: 25,
            },
          },
        ],
        error: null,
      },
    });

    const result = await fetchUnpaidBookingsData('trainer-1', undefined, client);
    expect(fetchTrainerNamesMock).toHaveBeenCalledWith(['trainer-1'], client, 'UnpaidBookingsCard');
    expect(result[0]?.trainerName).toBe('Coach Sam');
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
    expect(fetchTrainerNamesMock).not.toHaveBeenCalled();
  });
});

describe('unpaidBookingsQueryOptions', () => {
  it('disables retry to avoid repeated 400 spam', () => {
    expect(unpaidBookingsQueryOptions.retry).toBe(false);
  });
});
