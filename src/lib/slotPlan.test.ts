import { describe, it, expect } from 'vitest';
import { planSlots, SlotPlanError, MAX_PLANNED_SLOTS, type SlotPlanConfig } from './slotPlan';

const TZ = 'Europe/Amsterdam';

// Format an ISO instant back to local wall-clock in a tz — used to assert the
// generator anchored times correctly.
const localTime = (iso: string, tz = TZ) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  );
const localDay = (iso: string, tz = TZ) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(iso)).toLowerCase();
const localDate = (iso: string, tz = TZ) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );

const base: SlotPlanConfig = {
  weekdays: ['monday'],
  windowStart: '15:00',
  windowEnd: '20:00',
  slotDurationMin: 60,
  startDate: '2026-06-01',
  weeks: 1,
  timezone: TZ,
};

describe('planSlots — intra-day blocked break', () => {
  it('the spec example: 3–8pm @60 skipping 5–6pm → 3,4,6,7pm', () => {
    const out = planSlots({ ...base, breakStart: '17:00', breakEnd: '18:00' });
    // exactly one Monday in a 1-week window, 4 surviving slots
    expect(out).toHaveLength(4);
    expect(out.map((s) => localTime(s.startISO))).toEqual(['15:00', '16:00', '18:00', '19:00']);
    expect(out.map((s) => localTime(s.endISO))).toEqual(['16:00', '17:00', '19:00', '20:00']);
    expect(out.every((s) => localDay(s.startISO) === 'monday')).toBe(true);
  });

  it('no break → back-to-back fill, last full slot ends exactly at windowEnd', () => {
    const out = planSlots(base);
    expect(out.map((s) => localTime(s.startISO))).toEqual(['15:00', '16:00', '17:00', '18:00', '19:00']);
  });

  it('a slot only PARTLY overlapping the break is still dropped (half-open [start,end))', () => {
    // break 17:30–18:00 overlaps the 17:00–18:00 slot → dropped; 16:00 (ends 17:00) survives
    const out = planSlots({ ...base, breakStart: '17:30', breakEnd: '18:00' });
    expect(out.map((s) => localTime(s.startISO))).toEqual(['15:00', '16:00', '18:00', '19:00']);
  });

  it('drops the trailing partial slot that would run past windowEnd', () => {
    const out = planSlots({ ...base, windowEnd: '17:30' }); // 15,16 fit; 17:00→18:00 would overrun
    expect(out.map((s) => localTime(s.startISO))).toEqual(['15:00', '16:00']);
  });

  it('a window shorter than one slot yields nothing that day', () => {
    const out = planSlots({ ...base, windowStart: '15:00', windowEnd: '15:30', slotDurationMin: 60 });
    expect(out).toHaveLength(0);
  });
});

describe('planSlots — weekday + holiday filtering', () => {
  it('only plans on selected weekdays', () => {
    const out = planSlots({ ...base, weekdays: ['monday', 'wednesday'], weeks: 1 });
    const days = new Set(out.map((s) => localDay(s.startISO)));
    expect(days).toEqual(new Set(['monday', 'wednesday'])); // exactly one of each in a 1-week span
    expect(out).toHaveLength(2 * 5); // 2 days × 5 slots (15–20 @60)
  });

  it('skips dates inside a holiday range (the "week off")', () => {
    // 5 Mondays, one full week blacked out → 4 Mondays survive
    const five = planSlots({ ...base, weeks: 5 });
    const mondays = new Set(five.map((s) => localDate(s.startISO)));
    expect(mondays.size).toBe(5);
    const skipped = [...mondays].sort()[2]; // black out the 3rd Monday's whole week
    const out = planSlots({
      ...base,
      weeks: 5,
      holidayRanges: [{ from: skipped, to: skipped, name: 'Holiday' }],
    });
    expect(new Set(out.map((s) => localDate(s.startISO)))).not.toContain(skipped);
    expect(out).toHaveLength((five.length / 5) * 4); // 4 of 5 Mondays survive
  });
});

describe('planSlots — weeks ↔ endDate equivalence', () => {
  it('weeks:2 from a date == endDate 13 days later (inclusive)', () => {
    const byWeeks = planSlots({ ...base, weekdays: ['monday', 'thursday'], weeks: 2 });
    const byEnd = planSlots({
      ...base,
      weekdays: ['monday', 'thursday'],
      weeks: undefined,
      endDate: '2026-06-14', // 2026-06-01 + 13 days
    });
    expect(byEnd).toEqual(byWeeks);
  });
});

describe('planSlots — DST correctness (Europe/Amsterdam, exact UTC)', () => {
  it('spring-forward Sunday (2026-03-29) anchors 09:00 local = 07:00 UTC (+02:00 summer)', () => {
    const out = planSlots({
      ...base,
      weekdays: ['sunday'],
      windowStart: '09:00',
      windowEnd: '10:00',
      slotDurationMin: 60,
      startDate: '2026-03-29',
      weeks: 1,
    });
    expect(out).toHaveLength(1);
    expect(localTime(out[0].startISO)).toBe('09:00');
    expect(out[0].startISO).toBe('2026-03-29T07:00:00.000Z');
  });

  it('fall-back Sunday (2026-10-25) anchors 09:00 local = 08:00 UTC (+01:00 winter)', () => {
    const out = planSlots({
      ...base,
      weekdays: ['sunday'],
      windowStart: '09:00',
      windowEnd: '10:00',
      slotDurationMin: 60,
      startDate: '2026-10-25',
      weeks: 1,
    });
    expect(out).toHaveLength(1);
    expect(localTime(out[0].startISO)).toBe('09:00');
    expect(out[0].startISO).toBe('2026-10-25T08:00:00.000Z');
  });
});

describe('planSlots — guards', () => {
  it('throws past the MAX_PLANNED_SLOTS cap', () => {
    // 7 days × 32 slots/day (06–22 @30) × 3 weeks = 672 > 500
    expect(() =>
      planSlots({
        ...base,
        weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
        windowStart: '06:00',
        windowEnd: '22:00',
        slotDurationMin: 30,
        weeks: 3,
      }),
    ).toThrow(SlotPlanError);
    expect(MAX_PLANNED_SLOTS).toBe(500);
  });

  it.each([
    ['no weekdays', { weekdays: [] as never[] }],
    ['overnight window', { windowStart: '20:00', windowEnd: '15:00' }],
    ['zero duration', { slotDurationMin: 0 }],
    ['both weeks and endDate', { endDate: '2026-06-14' }], // base already has weeks
    ['neither weeks nor endDate', { weeks: undefined }],
    ['half a break', { breakStart: '17:00' }],
    ['bad time format', { windowStart: '9am' }],
    ['bad date format', { startDate: '01-06-2026' }],
  ])('throws on %s', (_label, override) => {
    expect(() => planSlots({ ...base, ...(override as Partial<SlotPlanConfig>) })).toThrow(SlotPlanError);
  });
});
