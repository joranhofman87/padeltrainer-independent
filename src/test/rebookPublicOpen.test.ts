import { describe, it, expect } from 'vitest';
import { resolvePublicOpenOverride } from '../../supabase/functions/_shared/rebook-public-open.ts';

// The rebook wizard's "When sessions open to the public" choice → the flags bulk-rebook-cycle
// stamps on the new cycle settings + slots. 'inherit' must reproduce the source court exactly;
// an explicit mode overrides the whole round (fixing the split-source-opens-per-seat footgun).
describe('resolvePublicOpenOverride', () => {
  it('inherits (returns null) for absent / null / "inherit" / unknown values', () => {
    expect(resolvePublicOpenOverride(undefined, false)).toBeNull();
    expect(resolvePublicOpenOverride(null, false)).toBeNull();
    expect(resolvePublicOpenOverride('inherit', true)).toBeNull();
    expect(resolvePublicOpenOverride('nonsense', true)).toBeNull();
    expect(resolvePublicOpenOverride(42, true)).toBeNull();
  });

  it('cyclus_only + split off = whole court, one upfront payment (the Round-B-correct config)', () => {
    expect(resolvePublicOpenOverride('cyclus_only', false)).toEqual({
      allowSingle: false, allowCyclus: true, wholeSlot: false, split: false,
    });
  });

  it('both + split honours the split toggle', () => {
    expect(resolvePublicOpenOverride('both', true)).toEqual({
      allowSingle: true, allowCyclus: true, wholeSlot: false, split: true,
    });
    expect(resolvePublicOpenOverride('both', false).split).toBe(false);
  });

  it('single_only = per-seat sessions only, no whole-cyclus checkout', () => {
    expect(resolvePublicOpenOverride('single_only', true)).toEqual({
      allowSingle: true, allowCyclus: false, wholeSlot: false, split: true,
    });
  });

  it('single_only_whole_slot forces split OFF (whole court is one payment)', () => {
    expect(resolvePublicOpenOverride('single_only_whole_slot', true)).toEqual({
      allowSingle: false, allowCyclus: false, wholeSlot: true, split: false,
    });
  });

  it('split is coerced strictly to boolean true (a truthy non-true does NOT split)', () => {
    expect(resolvePublicOpenOverride('cyclus_only', 'yes' as unknown).split).toBe(false);
    expect(resolvePublicOpenOverride('cyclus_only', 1 as unknown).split).toBe(false);
    expect(resolvePublicOpenOverride('cyclus_only', true).split).toBe(true);
  });

  // The engine applies the result as `override ? override.X : sourceFlag`. This documents the
  // regression guarantee: inherit (null) leaves the source flags untouched on BOTH settings + slots.
  it('inherit leaves the source flags in control (application contract)', () => {
    const override = resolvePublicOpenOverride('inherit', true);
    const sourceSplit = true; // whatever the source court happened to be
    const applied = override ? override.split : sourceSplit;
    expect(applied).toBe(sourceSplit);
  });
});
