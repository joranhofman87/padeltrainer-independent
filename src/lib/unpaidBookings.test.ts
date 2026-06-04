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
  it('uses slot_trainer embed instead of trainer_profiles:trainer_id alias', () => {
    expect(UNPAID_BOOKINGS_SELECT).toContain('slot_trainer:trainer_profiles!availability_slots_trainer_id_fkey');
    expect(UNPAID_BOOKINGS_SELECT).not.toContain('trainer_profiles:trainer_id');
  });
});

describe('mapUnpaidBookingRow', () => {
  it('maps trainer name from slot_trainer.profiles', () => {
    const row = {
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
        cyclus_name: 'Summer',
        price_per_session: 30,
        slot_trainer: {
          id: 'trainer-1',
          profiles: { full_name: 'Coach Sam' },
        },
      },
    };

    const mapped = mapUnpaidBookingRow(row);
    expect(mapped.trainerName).toBe('Coach Sam');
    expect(mapped.playerName).toBe('Alex Player');
    expect(mapped.amount).toBe(25);
  });

  it('falls back to Trainer when slot_trainer profile is missing', () => {
    const row = {
      id: 'booking-2',
      slot_id: 'slot-2',
      payment_amount: null,
      reminder_sent_at: null,
      player_id: null,
      guest_player_id: 'guest-1',
      profiles: null,
      guest_players: { full_name: 'Guest', email: 'guest@example.com' },
      availability_slots: {
        start_time: '2026-06-10T10:00:00Z',
        end_time: '2026-06-10T11:00:00Z',
        cyclus_name: null,
        price_per_session: 40,
        slot_trainer: null,
      },
    };

    expect(mapUnpaidBookingRow(row).trainerName).toBe('Trainer');
    expect(mapUnpaidBookingRow(row).amount).toBe(40);
  });
});

describe('fetchUnpaidBookingsData', () => {
  beforeEach(() => {
    vi.mocked(logger.error).mockClear();
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

  it('queries bookings when trainer id is provided', async () => {
    const { client, bookingsFrom } = createMockClient({
      bookings: { data: [], error: null },
    });
    await fetchUnpaidBookingsData('trainer-1', undefined, client);
    expect(bookingsFrom).toHaveBeenCalled();
  });

  it('returns [] and logs once on Supabase error without throwing', async () => {
    const { client } = createMockClient({
      bookings: {
        data: null,
        error: { message: 'Bad operator', code: 'PGRST120', details: 'embed filter' },
      },
    });
    await expect(fetchUnpaidBookingsData('trainer-1', undefined, client)).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to load unpaid bookings',
      expect.any(Error),
      expect.objectContaining({ component: 'UnpaidBookingsCard', code: 'PGRST120' }),
    );
  });
});

describe('unpaidBookingsQueryOptions', () => {
  it('disables retry to avoid repeated 400 spam', () => {
    expect(unpaidBookingsQueryOptions.retry).toBe(false);
  });
});
