import { describe, it, expect } from 'vitest';
import { TIME_OPTIONS, buildHalfHourOptions } from './timeOptions';

describe('timeOptions', () => {
  it('TIME_OPTIONS is the full-day half-hour list ("00:00" … "23:30", 48 entries)', () => {
    expect(TIME_OPTIONS).toHaveLength(48);
    expect(TIME_OPTIONS[0]).toBe('00:00');
    expect(TIME_OPTIONS[1]).toBe('00:30');
    expect(TIME_OPTIONS[47]).toBe('23:30');

    // Byte-for-byte identical to the legacy Array.from builder it replaced —
    // this list is imported and .map()'d across many screens, so its exact
    // contents and order must not drift.
    const legacy = Array.from({ length: 24 * 2 }, (_, i) => {
      const hours = Math.floor(i / 2);
      const minutes = (i % 2) * 30;
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    });
    expect(TIME_OPTIONS).toEqual(legacy);
  });

  it('buildHalfHourOptions(6, 23) matches the 06:00–23:30 slot/generator wizard range', () => {
    const opts = buildHalfHourOptions(6, 23);
    expect(opts[0]).toBe('06:00');
    expect(opts[opts.length - 1]).toBe('23:30');
    expect(opts).toHaveLength((23 - 6 + 1) * 2); // 36
    expect(opts).not.toContain('00:00');

    // Exactly the inline list the generator/proposal wizards built by hand.
    const legacy: string[] = [];
    for (let h = 6; h <= 23; h++) {
      legacy.push(`${h.toString().padStart(2, '0')}:00`);
      legacy.push(`${h.toString().padStart(2, '0')}:30`);
    }
    expect(opts).toEqual(legacy);
  });

  it('midnightEnd appends "00:00" as an end-of-day sentinel; start list is a strict prefix', () => {
    const end = buildHalfHourOptions(6, 23, { midnightEnd: true });
    expect(end[end.length - 1]).toBe('00:00');
    expect(end).toHaveLength((23 - 6 + 1) * 2 + 1); // 37
    expect(end.slice(0, -1)).toEqual(buildHalfHourOptions(6, 23));
  });
});
