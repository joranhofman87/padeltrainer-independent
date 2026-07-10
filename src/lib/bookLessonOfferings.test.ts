import { describe, it, expect } from 'vitest';
import { buildCyclusOfferings, type CyclusOfferingSettings } from './bookLessonOfferings';

interface TestSlot {
  id: string;
  start_time: string;
  cyclus_id?: string | null;
  cyclus_name?: string | null;
  price_per_session?: number | null;
  allow_single_booking?: boolean | null;
  fromCycle?: boolean;
  location?: { id: string; name: string; city: string; street_address: string | null } | null;
}

const FALLBACK = 'Training cycle';

/** A bookable session of cyclus C on a given day (Aug 2026), €25 unless overridden. */
const s = (id: string, day: number, over: Partial<TestSlot> = {}): TestSlot => ({
  id,
  start_time: `2026-08-${String(day).padStart(2, '0')}T10:00:00Z`,
  cyclus_id: 'C',
  cyclus_name: 'Zomerreeks',
  price_per_session: 25,
  ...over,
});

const settings = (o: CyclusOfferingSettings): Record<string, CyclusOfferingSettings> => ({ C: o });

describe('buildCyclusOfferings', () => {
  it('bundles a fully-available non-split cyclus (booking allowed by default)', () => {
    const { bundles, individualSlots } = buildCyclusOfferings(
      [s('a', 3), s('b', 10), s('c', 17)],
      settings({}), // allow_cyclus_booking absent ⇒ allowed
      FALLBACK,
    );
    expect(bundles).toHaveLength(1);
    expect(bundles[0].slots.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(bundles[0].totalPrice).toBe(75);
    expect(bundles[0].firstDate).toBe('2026-08-03T10:00:00Z');
    expect(bundles[0].lastDate).toBe('2026-08-17T10:00:00Z');
    // no allow_single_booking sessions ⇒ nothing offered individually
    expect(individualSlots).toHaveLength(0);
  });

  it('FIX 2: bundles only the bookable sessions it is given — a partially-filled cyclus still offers its remaining weeks as one payment', () => {
    // Caller already filtered out the full/hidden weeks; the helper must NOT require the full cyclus size.
    const { bundles } = buildCyclusOfferings([s('b', 10), s('d', 24)], settings({}), FALLBACK);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].slots.map((x) => x.id)).toEqual(['b', 'd']);
    expect(bundles[0].totalPrice).toBe(50); // sum of the two REMAINING weeks, not the original 4
  });

  it('FIX 1: allow_cyclus_booking=false suppresses the bundle and sells sessions individually', () => {
    const { bundles, individualSlots } = buildCyclusOfferings(
      [s('a', 3), s('b', 10), s('c', 17)],
      settings({ allow_cyclus_booking: false }),
      FALLBACK,
    );
    expect(bundles).toHaveLength(0);
    // every session stays bookable, as a full-price fromCycle single
    expect(individualSlots.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
    for (const slot of individualSlots) {
      expect(slot.fromCycle).toBe(true);
      expect(slot.allow_single_booking).toBe(false);
    }
  });

  it('offers <2 bookable sessions individually rather than as a one-session "bundle"', () => {
    const { bundles, individualSlots } = buildCyclusOfferings([s('a', 3)], settings({}), FALLBACK);
    expect(bundles).toHaveLength(0);
    expect(individualSlots).toHaveLength(1);
    expect(individualSlots[0].fromCycle).toBe(true);
  });

  it('bundled non-split cyclus ALSO exposes allow_single_booking sessions as full-price singles', () => {
    const { bundles, individualSlots } = buildCyclusOfferings(
      [s('a', 3, { allow_single_booking: true }), s('b', 10), s('c', 17, { allow_single_booking: true })],
      settings({}),
      FALLBACK,
    );
    expect(bundles).toHaveLength(1);
    // only the two allow_single_booking sessions are offered standalone (the render path would divide
    // by max_participants, so they must be flattened to full-price fromCycle copies)
    expect(individualSlots.map((x) => x.id).sort()).toEqual(['a', 'c']);
    for (const slot of individualSlots) {
      expect(slot.fromCycle).toBe(true);
      expect(slot.allow_single_booking).toBe(false);
    }
  });

  it('split-payment cyclus bundles but NEVER exposes standalone sessions', () => {
    const { bundles, individualSlots } = buildCyclusOfferings(
      [s('a', 3, { allow_single_booking: true }), s('b', 10)],
      settings({ split_payment: true }),
      FALLBACK,
    );
    expect(bundles).toHaveLength(1);
    expect(individualSlots).toHaveLength(0);
  });

  it('OVERCHARGE GUARD: a split cyclus with a single bookable session (final week) still bundles — never sold at full price via the single-slot path', () => {
    // Regression: the >=2 threshold used to drop the lone final-week split session into the individual
    // path, where allow_single_booking=false ⇒ FULL court price (4× the split share). It must bundle.
    const { bundles, individualSlots } = buildCyclusOfferings(
      [s('a', 24, { allow_single_booking: false, price_per_session: 40 })],
      settings({ split_payment: true }),
      FALLBACK,
    );
    expect(bundles).toHaveLength(1);
    expect(bundles[0].slots.map((x) => x.id)).toEqual(['a']); // routed through the split-aware bundle
    expect(individualSlots).toHaveLength(0); // NOT exposed as a full-price single
  });

  it('split cyclus with whole-series booking disabled sells ONLY genuinely per-seat sessions (never a full-price split single)', () => {
    // allow_single_booking=true ⇒ the single-slot path charges price ÷ max_participants (the split
    // share), so it is safe standalone. A plain session (allow_single_booking=false) would overcharge,
    // so it is dropped rather than exposed.
    const { bundles, individualSlots } = buildCyclusOfferings(
      [s('a', 3, { allow_single_booking: true }), s('b', 10, { allow_single_booking: false })],
      settings({ split_payment: true, allow_cyclus_booking: false }),
      FALLBACK,
    );
    expect(bundles).toHaveLength(0);
    expect(individualSlots.map((x) => x.id)).toEqual(['a']); // 'b' dropped (would overcharge)
    const a = individualSlots[0];
    expect(a.allow_single_booking).toBe(true); // untouched — the render path applies the ÷capacity share
    expect(a.fromCycle).toBeUndefined();
  });

  it('passes standalone (non-cyclus) slots straight through to individual sessions', () => {
    const { bundles, individualSlots } = buildCyclusOfferings(
      [{ id: 'x', start_time: '2026-08-05T09:00:00Z', cyclus_id: null }],
      {},
      FALLBACK,
    );
    expect(bundles).toHaveLength(0);
    expect(individualSlots.map((x) => x.id)).toEqual(['x']);
  });

  it('does not mutate the caller’s slots when flattening cycle-derived singles', () => {
    const original = s('a', 3, { allow_single_booking: true });
    buildCyclusOfferings([original, s('b', 10, { allow_single_booking: true })], settings({}), FALLBACK);
    expect(original.allow_single_booking).toBe(true); // untouched
    expect(original.fromCycle).toBeUndefined();
  });

  it('carries min_group_size + location, and falls back on a missing cyclus_name', () => {
    const { bundles } = buildCyclusOfferings(
      [
        s('a', 3, { cyclus_name: null, location: { id: 'L', name: 'Court', city: 'Amsterdam', street_address: null } }),
        s('b', 10, { cyclus_name: null }),
      ],
      settings({ min_group_size: 4 }),
      FALLBACK,
    );
    expect(bundles[0].cyclus_name).toBe(FALLBACK);
    expect(bundles[0].min_group_size).toBe(4);
    expect(bundles[0].location).toEqual({ id: 'L', name: 'Court', city: 'Amsterdam', street_address: null });
  });

  it('sorts bundle sessions chronologically regardless of input order', () => {
    const { bundles } = buildCyclusOfferings([s('c', 17), s('a', 3), s('b', 10)], settings({}), FALLBACK);
    expect(bundles[0].slots.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});
