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

// Trainer pay is per HOUR of session held (≥1 person), and the owner wants a player-
// confirmation cross-check. Both come from session_reports.session_happened per reporter.
describe('AcademyReportsTab attendance / chargeable hours', () => {
  it('reads player/trainer confirmation from session_reports.session_happened', () => {
    expect(source).toContain("from('session_reports')");
    expect(source).toContain('session_happened');
    expect(source).toContain("reporter_role === 'player'");
    expect(source).toContain("reporter_role === 'trainer'");
  });

  it('only counts a confirmation when the reporter said the session HAPPENED', () => {
    // guard against counting session_happened=false reports as confirmations
    expect(source).toMatch(/if \(!r\.session_happened\) continue/);
  });

  it('chargeable + confirmed hours are computed over HELD (>=1 person) sessions', () => {
    expect(source).toContain('booking_count > 0');
    expect(source).toContain('player_confirmed');
    expect(source).toContain('confirmedHours');
    expect(source).toContain('chargeableHours'); // stat-tile label key
  });
});
