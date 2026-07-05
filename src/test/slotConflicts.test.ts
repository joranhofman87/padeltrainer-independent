// slotConflicts — the client half of the trainer double-booking guard. The epoch-based
// comparison is the point: PostgREST '+00:00' timestamps vs Date#toISOString '.000Z'
// never match as STRINGS (that exact mismatch made the bulk-create dedup a silent no-op).
import { describe, it, expect } from 'vitest';
import {
  epochRange,
  rangesOverlap,
  splitByOverlap,
  isTrainerSlotOverlapError,
} from '@/lib/slotConflicts';

describe('epochRange', () => {
  it('parses PostgREST +00:00 and JS .000Z formats to the SAME instant', () => {
    const fromDb = epochRange('2026-09-07T09:00:00+00:00', '2026-09-07T10:00:00+00:00');
    const fromJs = epochRange('2026-09-07T09:00:00.000Z', '2026-09-07T10:00:00.000Z');
    expect(fromDb).toEqual(fromJs);
  });

  it('accepts Date objects', () => {
    const d = new Date('2026-09-07T09:00:00Z');
    expect(epochRange(d, new Date('2026-09-07T10:00:00Z')).startMs).toBe(d.getTime());
  });
});

describe('rangesOverlap (half-open [start, end))', () => {
  const base = epochRange('2026-09-07T10:00:00Z', '2026-09-07T11:00:00Z');
  it('detects identical, partial, and containing overlaps', () => {
    expect(rangesOverlap(base, base)).toBe(true);
    expect(rangesOverlap(base, epochRange('2026-09-07T10:30:00Z', '2026-09-07T11:30:00Z'))).toBe(true);
    expect(rangesOverlap(base, epochRange('2026-09-07T09:00:00Z', '2026-09-07T12:00:00Z'))).toBe(true);
  });
  it('back-to-back ranges do NOT overlap', () => {
    expect(rangesOverlap(base, epochRange('2026-09-07T11:00:00Z', '2026-09-07T12:00:00Z'))).toBe(false);
    expect(rangesOverlap(base, epochRange('2026-09-07T09:00:00Z', '2026-09-07T10:00:00Z'))).toBe(false);
  });
});

describe('splitByOverlap', () => {
  const sessions = [
    { start: '2026-09-07T09:00:00Z', end: '2026-09-07T10:00:00Z' },
    { start: '2026-09-07T10:00:00Z', end: '2026-09-07T11:00:00Z' },
    { start: '2026-09-07T11:00:00Z', end: '2026-09-07T12:00:00Z' },
  ];
  it('partitions candidates against existing ranges', () => {
    // Existing 10:30–11:30 straddles sessions 2 AND 3.
    const existing = [epochRange('2026-09-07T10:30:00Z', '2026-09-07T11:30:00Z')];
    const { fresh, skipped } = splitByOverlap(sessions, (s) => epochRange(s.start, s.end), existing);
    expect(fresh.map((s) => s.start)).toEqual(['2026-09-07T09:00:00Z']);
    expect(skipped).toHaveLength(2);
  });
  it('everything is fresh when nothing overlaps', () => {
    const { fresh, skipped } = splitByOverlap(sessions, (s) => epochRange(s.start, s.end), []);
    expect(fresh).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });
});

describe('isTrainerSlotOverlapError', () => {
  it('recognizes the trigger refusal in Error and Supabase-error shapes', () => {
    expect(isTrainerSlotOverlapError(new Error('trainer_slot_overlap'))).toBe(true);
    expect(isTrainerSlotOverlapError({ message: 'trainer_slot_overlap', code: 'P0001' })).toBe(true);
  });
  it('rejects other errors and empty values', () => {
    expect(isTrainerSlotOverlapError(new Error('slot_full'))).toBe(false);
    expect(isTrainerSlotOverlapError(null)).toBe(false);
    expect(isTrainerSlotOverlapError(undefined)).toBe(false);
  });
});
