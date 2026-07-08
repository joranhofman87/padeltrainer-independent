import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isOccupyingStatus } from '@/lib/lessons';

const source = readFileSync(resolve(__dirname, 'AcademyReportsTab.tsx'), 'utf8');

// The reports tab must count only capacity-OCCUPYING bookings. Counting every booking
// row (via bookings!inner with no status filter) made cancelled/cancelled_swap bookings
// count as seats — pushing fill-rate past 100% and adding coaching hours for sessions
// whose bookings were all cancelled.
describe('AcademyReportsTab booking count', () => {
  it('does not use the status-agnostic bookings!inner embed', () => {
    expect(source).not.toContain('bookings!inner');
  });

  it('counts only occupying bookings (isOccupyingStatus / CAPACITY_OCCUPYING_STATUSES)', () => {
    expect(source).toContain('isOccupyingStatus');
    expect(source).toContain('CAPACITY_OCCUPYING_STATUSES');
  });

  it('sanity: cancelled + cancelled_swap are NOT occupying, so they never fill a seat', () => {
    expect(isOccupyingStatus('confirmed')).toBe(true);
    expect(isOccupyingStatus('pending')).toBe(true);
    expect(isOccupyingStatus('pending_approval')).toBe(true);
    expect(isOccupyingStatus('cancelled')).toBe(false);
    expect(isOccupyingStatus('cancelled_swap')).toBe(false);
  });
});
