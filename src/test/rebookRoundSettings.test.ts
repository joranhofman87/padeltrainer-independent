import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase chain mock: `from()` returns a chainable builder; terminal reads (maybeSingle/range)
// and the update's `.select('id')` (awaited via `then`) resolve from a FIFO queue set per test.
// `from` is referenced LAZILY inside the factory (vi.mock hoisting) — see registrations.test.ts.
const results: Array<{ data: unknown; error?: unknown }> = [];
const nextResult = () => (results.length ? results.shift()! : { data: null, error: null });
const chain: Record<string, unknown> = {
  from: () => chain, select: () => chain, eq: () => chain, in: () => chain, order: () => chain, update: () => chain,
  maybeSingle: () => Promise.resolve(nextResult()),
  range: () => Promise.resolve(nextResult()),
  then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(nextResult()).then(res, rej),
};
vi.mock('@/lib/supabaseClient', () => ({ supabase: { from: () => chain } }));

const updateCycleSettings = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/cycleWrites', () => ({ updateCycleSettings: (...a: unknown[]) => updateCycleSettings(...a) }));

const applyBookingModeToFutureSlots = vi.fn().mockResolvedValue({ flipped: 2, skippedBooked: 1 });
vi.mock('@/lib/cycleBookingMode', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyBookingModeToFutureSlots: (...a: unknown[]) => applyBookingModeToFutureSlots(...a),
}));

import {
  updateRoundPaymentMode, updateRoundPublicOpenMode, updateRoundReleasePolicy, deriveReleasePolicy,
} from '@/lib/rebookRoundSettings';

beforeEach(() => { results.length = 0; updateCycleSettings.mockClear(); applyBookingModeToFutureSlots.mockClear(); });

describe('deriveReleasePolicy', () => {
  it('classifies auto / private / mixed, ignoring released + defaulting empty to auto', () => {
    expect(deriveReleasePolicy(['auto_release_scheduled', 'auto_release_scheduled'])).toBe('auto');
    expect(deriveReleasePolicy(['held', 'pending_admin_review'])).toBe('private');
    expect(deriveReleasePolicy(['auto_release_scheduled', 'held'])).toBe('mixed');
    expect(deriveReleasePolicy(['released', 'auto_release_scheduled'])).toBe('auto'); // released ignored
    expect(deriveReleasePolicy(['released'])).toBe('auto'); // no policy-bearing slots → default
    expect(deriveReleasePolicy([])).toBe('auto');
  });
});

describe('updateRoundPaymentMode', () => {
  it('merges rebook_payment_mode into settings (preserving other keys) per cycle', async () => {
    results.push({ data: { settings: { rebook_round_id: 'r1', keep: 'me' } } });
    const res = await updateRoundPaymentMode(['c1'], 'upfront', true);
    expect(res.updatedCycles).toBe(1);
    expect(updateCycleSettings).toHaveBeenCalledWith('c1', expect.objectContaining({
      rebook_round_id: 'r1', keep: 'me', rebook_payment_mode: 'upfront', rebook_strict_mollie: true,
    }));
  });

  it('forces strict-Mollie OFF when the mode is deferred (mirrors the edge coupling)', async () => {
    results.push({ data: { settings: {} } });
    await updateRoundPaymentMode(['c1'], 'deferred_split', true);
    expect(updateCycleSettings).toHaveBeenCalledWith('c1', expect.objectContaining({
      rebook_payment_mode: 'deferred_split', rebook_strict_mollie: false,
    }));
  });
});

describe('updateRoundPublicOpenMode', () => {
  it('writes the booking-mode flags + split, and stamps future slots', async () => {
    results.push({ data: { settings: { keep: 1 } } });
    const res = await updateRoundPublicOpenMode(['c1'], 'cyclus_only', true);
    expect(updateCycleSettings).toHaveBeenCalledWith('c1', expect.objectContaining({
      keep: 1, allow_single_booking: false, allow_cyclus_booking: true, whole_slot_booking: false, split_payment: true,
    }));
    expect(applyBookingModeToFutureSlots).toHaveBeenCalledWith('c1', { allowSingle: false, wholeSlot: false });
    expect(res.updatedSlots).toBe(2);
    expect(res.skippedBookedSlots).toBe(1);
  });

  it('forces split OFF for whole-court (single_only_whole_slot)', async () => {
    results.push({ data: { settings: {} } });
    await updateRoundPublicOpenMode(['c1'], 'single_only_whole_slot', true);
    expect(updateCycleSettings).toHaveBeenCalledWith('c1', expect.objectContaining({
      whole_slot_booking: true, allow_single_booking: false, split_payment: false,
    }));
  });
});

describe('updateRoundReleasePolicy', () => {
  it('sets non-released slots to the target, skips released + already-at-target', async () => {
    results.push({ data: [
      { id: 's1', public_release_status: 'held' },                    // → change to auto
      { id: 's2', public_release_status: 'auto_release_scheduled' },  // already auto → skip
      { id: 's3', public_release_status: 'released' },                // released → excluded
    ], error: null });
    results.push({ data: [{ id: 's1' }], error: null }); // the update chunk returns the changed id
    const res = await updateRoundReleasePolicy(['c1'], 'auto');
    expect(res.skippedReleasedSlots).toBe(1);
    expect(res.updatedSlots).toBe(1); // only s1
    expect(res.failed).toEqual([]);
  });
});
