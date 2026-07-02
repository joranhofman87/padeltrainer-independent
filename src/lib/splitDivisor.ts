/**
 * G5 — client mirror of the split-payment capacity divisor.
 *
 * The canonical rule lives in the edge `_shared/booking-pricing.ts`
 * (`resolveSplitDivisorFromSlots`), which the app tsconfig can't import. This is a
 * byte-identical mirror for client indicative amounts + invoice draft creation.
 * `splitDivisorContract.test.ts` asserts the two implementations agree, so they
 * cannot drift.
 *
 * Divisor = MAX(max_participants) across the cycle's slots, each coalesced to ≥1.
 * A divisor of 1 means "no split" (full price). Frozen to capacity so it never
 * drifts with the cohort and never overcharges a player.
 */
export function resolveSplitDivisor(slots: { max_participants?: number | null }[]): number {
  const caps = (slots ?? []).map((s) => Math.max(1, Number(s?.max_participants) || 1));
  return caps.length ? Math.max(...caps) : 1;
}
