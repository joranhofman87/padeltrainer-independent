// @vitest-environment node
// The client-side view of the booking cutoff. It is ADVISORY — the server decides — but it has
// to mirror the SQL, because a UI that disagrees with the database either offers slots that get
// rejected on submit, or hides slots the player is entitled to book.
import { describe, it, expect } from 'vitest';
import {
  effectiveCutoffMinutes,
  isSlotWithinCutoff,
  formatCutoffMinutes,
  BOOKING_CUTOFF_PRESETS,
  MAX_BOOKING_CUTOFF_MINUTES,
} from '@/lib/bookingCutoff';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

describe('effectiveCutoffMinutes — the stricter wins', () => {
  it('takes the larger of the two', () => {
    expect(effectiveCutoffMinutes(2880, 4320)).toBe(4320);   // trainer tightens
    expect(effectiveCutoffMinutes(2880, 1440)).toBe(2880);   // trainer cannot loosen
  });

  it('treats missing values as no cutoff', () => {
    expect(effectiveCutoffMinutes(null, 1440)).toBe(1440);   // independent trainer, no academy
    expect(effectiveCutoffMinutes(2880, null)).toBe(2880);
    expect(effectiveCutoffMinutes(null, null)).toBe(0);
    expect(effectiveCutoffMinutes(undefined, undefined)).toBe(0);
  });

  it('never returns a negative', () => {
    expect(effectiveCutoffMinutes(-60, -30)).toBe(0);
  });
});

describe('isSlotWithinCutoff', () => {
  it('blocks inside the window and allows outside it', () => {
    expect(isSlotWithinCutoff(inHours(47), 2880, NOW)).toBe(true);    // 48h cutoff, 47h away
    expect(isSlotWithinCutoff(inHours(49), 2880, NOW)).toBe(false);
  });

  it('allows exactly ON the boundary', () => {
    // 48h away with a 48h cutoff is not "less than", matching `start_time - now() < interval`
    expect(isSlotWithinCutoff(inHours(48), 2880, NOW)).toBe(false);
  });

  it('a cutoff of 0 blocks NOTHING — including a session that already started', () => {
    // the property that makes this safe to ship to every existing academy
    expect(isSlotWithinCutoff(inHours(-2), 0, NOW)).toBe(false);
    expect(isSlotWithinCutoff(inHours(0.1), 0, NOW)).toBe(false);
  });

  it('a started session IS inside a non-zero cutoff', () => {
    expect(isSlotWithinCutoff(inHours(-2), 120, NOW)).toBe(true);
  });

  it('does not block on missing or unparseable input — the server decides', () => {
    // failing open here is right: this is display logic, and hiding a bookable slot on a
    // parse error would be a worse bug than showing one the server then refuses
    expect(isSlotWithinCutoff(null, 2880, NOW)).toBe(false);
    expect(isSlotWithinCutoff(undefined, 2880, NOW)).toBe(false);
    expect(isSlotWithinCutoff('not a date', 2880, NOW)).toBe(false);
  });

  it('accepts a Date as well as an ISO string', () => {
    expect(isSlotWithinCutoff(new Date(inHours(1)), 2880, NOW)).toBe(true);
  });
});

describe('presets', () => {
  it('offers no-cutoff through 7 days, and nothing above the DB limit', () => {
    expect(BOOKING_CUTOFF_PRESETS[0]).toBe(0);
    expect(Math.max(...BOOKING_CUTOFF_PRESETS)).toBe(MAX_BOOKING_CUTOFF_MINUTES);
    for (const p of BOOKING_CUTOFF_PRESETS) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(MAX_BOOKING_CUTOFF_MINUTES);
    }
  });

  it('is strictly ascending, so the dropdown reads as a ladder', () => {
    const sorted = [...BOOKING_CUTOFF_PRESETS].sort((a, b) => a - b);
    expect([...BOOKING_CUTOFF_PRESETS]).toEqual(sorted);
    expect(new Set(BOOKING_CUTOFF_PRESETS).size).toBe(BOOKING_CUTOFF_PRESETS.length);
  });

  it('labels every preset without leaking minutes at the user', () => {
    const t = (_k: string, fb: string, o?: Record<string, unknown>) =>
      fb.replace(/\{\{count\}\}/g, String(o?.count ?? ''));
    expect(formatCutoffMinutes(0, t)).toBe('Geen limiet');
    expect(formatCutoffMinutes(120, t)).toBe('2 uur');
    expect(formatCutoffMinutes(2880, t)).toBe('2 dagen');
    expect(formatCutoffMinutes(10080, t)).toBe('7 dagen');
    for (const p of BOOKING_CUTOFF_PRESETS) {
      expect(formatCutoffMinutes(p, t)).not.toMatch(/minute|minuten|NaN|undefined/i);
    }
  });
});
