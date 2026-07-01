import { describe, it, expect } from 'vitest';
import { mapAndGroupPublicSlots, type RawPublicSlotRow, type ShapeContext } from './publicAvailability';

// Noon-UTC start times so parseISO + isSameDay group by the same calendar day in any runner tz.
const row = (over: Partial<RawPublicSlotRow> & { id: string; start_time: string }): RawPublicSlotRow => ({
  end_time: over.start_time,
  cyclus_id: null,
  cyclus_name: null,
  court_type: null,
  price_per_session: 20,
  total_price: null,
  max_participants: 4,
  allow_single_booking: true,
  extra_costs: null,
  split_payment: false,
  trainer_id: 'tr1',
  locations: null,
  ...over,
});

const ctx = (over: Partial<ShapeContext> = {}): ShapeContext => ({
  bookingCounts: {},
  visibleIds: new Set(),
  trainerMap: {},
  nameMap: {},
  ...over,
});

describe('mapAndGroupPublicSlots', () => {
  it('maps + groups by day, filling trainer name/slug, location, spots-left, extra costs', () => {
    const slots = [
      row({ id: 's1', start_time: '2026-09-01T12:00:00Z', extra_costs: [{ description: 'balls', price: 2 }] }),
      row({ id: 's2', start_time: '2026-09-01T13:00:00Z' }),
      row({ id: 's3', start_time: '2026-09-02T12:00:00Z', locations: { name: 'Court A' } }),
    ];
    const groups = mapAndGroupPublicSlots(
      slots,
      ctx({
        visibleIds: new Set(['s1', 's2', 's3']),
        bookingCounts: { s1: 1 },
        trainerMap: { tr1: { slug: 'coach', user_id: 'u1' } },
        nameMap: { u1: 'Coach Jansen' },
      }),
    );
    expect(groups).toHaveLength(2); // two calendar days
    expect(groups[0].slots.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(groups[0].slots[0]).toMatchObject({
      trainer_name: 'Coach Jansen',
      trainer_slug: 'coach',
      spots_left: 3, // 4 max - 1 booked
      extra_costs: [{ description: 'balls', price: 2 }],
    });
    expect(groups[1].slots[0].location_name).toBe('Court A');
  });

  it('drops full slots (booked >= max) and tier-hidden slots', () => {
    const slots = [
      row({ id: 'full', start_time: '2026-09-01T12:00:00Z', max_participants: 2 }),
      row({ id: 'hidden', start_time: '2026-09-01T13:00:00Z' }),
      row({ id: 'ok', start_time: '2026-09-01T14:00:00Z' }),
    ];
    const groups = mapAndGroupPublicSlots(
      slots,
      ctx({ visibleIds: new Set(['full', 'ok']), bookingCounts: { full: 2 } }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].slots.map((s) => s.id)).toEqual(['ok']);
  });

  it('whole-slot (allow_single_booking=false) has capacity 1: unbooked shows 1 spot, one booking makes it full', () => {
    const slots = [
      row({ id: 'whole-open', start_time: '2026-09-01T12:00:00Z', allow_single_booking: false, max_participants: 4 }),
      row({ id: 'whole-taken', start_time: '2026-09-01T13:00:00Z', allow_single_booking: false, max_participants: 4 }),
    ];
    const groups = mapAndGroupPublicSlots(
      slots,
      // whole-taken has ONE booking → full for a whole-slot even though max_participants is 4.
      ctx({ visibleIds: new Set(['whole-open', 'whole-taken']), bookingCounts: { 'whole-taken': 1 } }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].slots.map((s) => s.id)).toEqual(['whole-open']);
    expect(groups[0].slots[0].spots_left).toBe(1); // capacity 1, not max_participants
  });

  it('dedupes by id', () => {
    const slots = [
      row({ id: 'dup', start_time: '2026-09-01T12:00:00Z' }),
      row({ id: 'dup', start_time: '2026-09-01T12:00:00Z' }),
    ];
    const groups = mapAndGroupPublicSlots(slots, ctx({ visibleIds: new Set(['dup']) }));
    expect(groups[0].slots).toHaveLength(1);
  });

  it('returns [] when nothing is visible', () => {
    const slots = [row({ id: 's1', start_time: '2026-09-01T12:00:00Z' })];
    expect(mapAndGroupPublicSlots(slots, ctx({ visibleIds: new Set() }))).toEqual([]);
  });
});
