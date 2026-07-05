import { describe, it, expect } from 'vitest';
import { formatZonedTime, formatZonedDayLabel, zonedDateKey, groupSlotsByZonedDay } from './zonedFormat';
import type { PublicSlot } from './publicAvailability';

const TZ = 'Europe/Amsterdam';

describe('zoned formatters', () => {
  it('formatZonedTime renders in the given tz, not UTC (DST-aware)', () => {
    expect(formatZonedTime('2026-06-01T20:00:00Z', TZ)).toBe('22:00'); // summer UTC+2
    expect(formatZonedTime('2026-12-01T20:00:00Z', TZ)).toBe('21:00'); // winter UTC+1
  });

  it('zonedDateKey uses the tz calendar day — a late-UTC instant rolls to the next tz day', () => {
    expect(zonedDateKey('2026-06-01T23:00:00Z', TZ)).toBe('2026-06-02'); // 01:00 Jun 2 Ams
    expect(zonedDateKey('2026-06-01T09:00:00Z', TZ)).toBe('2026-06-01');
  });

  it('formatZonedDayLabel falls back gracefully on an invalid locale', () => {
    expect(() => formatZonedDayLabel('2026-06-01T09:00:00Z', TZ, '')).not.toThrow();
  });
});

describe('groupSlotsByZonedDay', () => {
  const slot = (id: string, start: string): PublicSlot => ({
    id,
    start_time: start,
    end_time: start,
    cyclus_id: null,
    cyclus_name: null,
    court_type: null,
    location_name: null,
    trainer_id: null,
    academy_profile_id: null,
    trainer_name: null,
    trainer_slug: null,
    price_per_session: 10,
    total_price: null,
    extra_costs: [],
    max_participants: 4,
    allow_single_booking: true,
    spots_left: 4,
    split_payment: false,
  });

  it('groups by owner-tz day, moving a late-UTC slot onto the next tz day', () => {
    const days = groupSlotsByZonedDay(
      [
        slot('a', '2026-06-01T09:00:00Z'), // 11:00 Jun 1 Ams
        slot('b', '2026-06-01T18:00:00Z'), // 20:00 Jun 1 Ams
        slot('c', '2026-06-01T23:00:00Z'), // 01:00 Jun 2 Ams → next day
      ],
      TZ,
      'nl-NL',
    );
    expect(days.map((d) => d.key)).toEqual(['2026-06-01', '2026-06-02']);
    expect(days[0].slots.map((s) => s.id)).toEqual(['a', 'b']);
    expect(days[1].slots.map((s) => s.id)).toEqual(['c']);
  });

  it('returns [] for no slots', () => {
    expect(groupSlotsByZonedDay([], TZ)).toEqual([]);
  });
});
