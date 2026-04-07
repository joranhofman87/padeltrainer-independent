import { describe, it, expect } from 'vitest';
import { COMMON_TIMEZONES, getTimezoneAbbr } from './timezones';

describe('COMMON_TIMEZONES', () => {
  it('contains Amsterdam as first entry', () => {
    expect(COMMON_TIMEZONES[0].value).toBe('Europe/Amsterdam');
  });

  it('has unique values', () => {
    const values = COMMON_TIMEZONES.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('getTimezoneAbbr', () => {
  it('returns a short abbreviation for valid timezone', () => {
    const abbr = getTimezoneAbbr('Europe/Amsterdam');
    // Could be CET or CEST depending on date
    expect(abbr.length).toBeLessThanOrEqual(5);
    expect(abbr).not.toBe('Europe/Amsterdam');
  });

  it('returns timezone string for invalid timezone', () => {
    const abbr = getTimezoneAbbr('Invalid/Zone');
    expect(abbr).toBe('Invalid/Zone');
  });
});
