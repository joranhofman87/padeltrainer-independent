import { describe, it, expect } from 'vitest';
import { buildCyclusLabel, type CyclusRosterEntry } from './cyclusLabel';

const entry = (over: Partial<CyclusRosterEntry> = {}): CyclusRosterEntry => ({
  dayTime: 'Ma 18:00',
  firstNames: ['Joran', 'Nick'],
  locationName: 'T.C. Boemerang',
  ...over,
});

describe('buildCyclusLabel', () => {
  it('renders day/time + players + location', () => {
    expect(buildCyclusLabel(entry())).toBe('Ma 18:00 (Joran, Nick) · T.C. Boemerang');
  });

  it('caps the names list and adds +K for the rest', () => {
    const label = buildCyclusLabel(entry({ firstNames: ['A', 'B', 'C', 'D', 'E', 'F'] }), 4);
    expect(label).toBe('Ma 18:00 (A, B, C, D, +2) · T.C. Boemerang');
  });

  it('drops the parens when there are no players (still useful: day/time + location)', () => {
    expect(buildCyclusLabel(entry({ firstNames: [] }))).toBe('Ma 18:00 · T.C. Boemerang');
  });

  it('drops the location suffix when there is no location', () => {
    expect(buildCyclusLabel(entry({ locationName: null }))).toBe('Ma 18:00 (Joran, Nick)');
  });

  it('returns null when there is no day/time, so the caller falls back to cycle.name', () => {
    expect(buildCyclusLabel(entry({ dayTime: null }))).toBeNull();
    expect(buildCyclusLabel(undefined)).toBeNull();
  });
});
