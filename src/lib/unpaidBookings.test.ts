import { describe, it, expect } from 'vitest';
import { sortBookingsBySlotStartTime } from './unpaidBookings';

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
