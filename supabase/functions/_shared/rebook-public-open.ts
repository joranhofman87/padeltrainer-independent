// Resolving the rebook wizard's "When sessions open to the public" choice into concrete
// booking-mode flags. Absent/unknown/'inherit' ⇒ null (the engine keeps each source court's own
// flags — legacy behaviour). An explicit mode ⇒ a uniform override applied to EVERY series in the
// round, so a split source court can't silently open per-seat (the Round B footgun).
//
// The four modes mirror CycleBookingMode (src/lib/cycleBookingMode.ts) and the slot generator's
// booking-mode picker, so the wizard, the overview and the engine all speak the same language.

export type PublicOpenOverride = {
  /** Per-seat selling (price ÷ max_participants, capacity = max_participants). */
  allowSingle: boolean;
  /** Whole-remaining-cyclus checkout is offered. */
  allowCyclus: boolean;
  /** Whole-court single-session selling (full price, capacity 1); mutually exclusive with split. */
  wholeSlot: boolean;
  /** Split the price across the players. Forced false for whole-court (can't split one payment). */
  split: boolean;
};

const PUBLIC_OPEN_MODES = ["both", "single_only", "single_only_whole_slot", "cyclus_only"];

/**
 * @returns the uniform override for an explicit mode, or `null` to inherit the source court's flags.
 */
export function resolvePublicOpenOverride(mode: unknown, split: unknown): PublicOpenOverride | null {
  if (typeof mode !== "string" || !PUBLIC_OPEN_MODES.includes(mode)) return null;
  const wholeSlot = mode === "single_only_whole_slot";
  return {
    allowSingle: mode === "both" || mode === "single_only",
    allowCyclus: mode === "both" || mode === "cyclus_only",
    wholeSlot,
    // whole-court is one payment by definition → split can't apply (mirrors CycleForm's rule).
    split: wholeSlot ? false : split === true,
  };
}
