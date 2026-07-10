/**
 * Groups a trainer's bookable slots into whole-cyclus bundles + individual sessions for the public
 * BookLesson page (`/app/book/:trainerId`). Extracted as a pure function so the bundle rules — which
 * are money-adjacent — can be unit-tested without mounting the page.
 *
 * Two invariants this encodes (both were bugs before):
 *  1. Honor `settings.allow_cyclus_booking`. Absent/true ⇒ the whole cyclus is offered as one bundle;
 *     explicit `false` ⇒ NO bundle, sessions are sold individually only. This matches the owner switch
 *     read the same way by GuestBookingDialog / CycleForm / AcademyCyclusOverview
 *     (`settings?.allow_cyclus_booking !== false`).
 *  2. Build the bundle from the *bookable* sessions passed in (already visibility- + capacity-filtered),
 *     NOT from the full cyclus size. A released rebook cyclus whose priority cohort already filled some
 *     weeks still offers the remaining weeks as one payment; previously a single full/hidden session
 *     suppressed the entire whole-series card.
 *
 * Pricing note (P-04): cycle prices are per player. A NON-split cycle session offered as an individual
 * "Losse sessie" must charge the full `price_per_session`, never a per-spot divided share — so those
 * copies clear `allow_single_booking` (which the render path would otherwise divide by
 * `max_participants`) and are tagged `fromCycle` so the booking handler charges the full price.
 *
 * Split-payment cycles are a special case: the per-player amount is the court price ÷ FROZEN capacity,
 * which only the whole-series (bundle) path reproduces — the single-slot path charges the full court
 * price for an `allow_single_booking=false` session, a 4× overcharge. So a split cyclus is priced ONLY
 * through the bundle: it may bundle down to a single remaining session (its final week), and when the
 * owner has disabled whole-series booking, only genuinely per-seat sessions (`allow_single_booking=true`
 * — the single-slot path already charges price ÷ max_participants, i.e. the split share) are sold
 * standalone. A full-price single of a split session is never exposed.
 */

/** The minimal slot fields the grouping reads/writes. Callers pass a richer slot type via the generic. */
export interface OfferingSlotFields {
  start_time: string;
  cyclus_id?: string | null;
  cyclus_name?: string | null;
  price_per_session?: number | null;
  allow_single_booking?: boolean | null;
  fromCycle?: boolean;
  location?: unknown;
}

/** The subset of cyclus settings that drives the offering shape. */
export interface CyclusOfferingSettings {
  min_group_size?: number;
  split_payment?: boolean;
  allow_cyclus_booking?: boolean;
}

export interface CyclusBundleOffering<S extends OfferingSlotFields> {
  cyclus_id: string;
  cyclus_name: string;
  slots: S[];
  totalPrice: number;
  firstDate: string;
  lastDate: string;
  location: S['location'];
  min_group_size?: number;
}

export interface CyclusOfferings<S extends OfferingSlotFields> {
  bundles: CyclusBundleOffering<S>[];
  individualSlots: S[];
}

/**
 * @param availableSlots  slots already filtered to bookable (visible tier + spots left).
 * @param settingsById    cyclus settings keyed by cyclus_id (may include ids with no available slots).
 * @param cyclusNameFallback  label for a bundle whose slots carry no cyclus_name.
 */
export function buildCyclusOfferings<S extends OfferingSlotFields>(
  availableSlots: S[],
  settingsById: Record<string, CyclusOfferingSettings | undefined>,
  cyclusNameFallback: string,
): CyclusOfferings<S> {
  const cyclusGroups: Record<string, S[]> = {};
  const standaloneSlots: S[] = [];
  for (const slot of availableSlots) {
    if (slot.cyclus_id) {
      (cyclusGroups[slot.cyclus_id] ||= []).push(slot);
    } else {
      standaloneSlots.push(slot);
    }
  }

  const bundles: CyclusBundleOffering<S>[] = [];
  const partialCyclusSlots: S[] = [];
  const cycleSingleSessionSlots: S[] = [];

  for (const [cyclusId, group] of Object.entries(cyclusGroups)) {
    const settings = settingsById[cyclusId];
    const sortedSlots = [...group].sort(
      (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    );
    // Offer the whole cyclus only when the owner allows it AND there are enough bookable sessions.
    // Non-split needs ≥2 (a lone leftover is just a single session). Split needs only ≥1: a split
    // session can ONLY be priced correctly through the bundle path (court price ÷ frozen capacity), so
    // even the final remaining week must bundle rather than fall to the full-price single-slot path.
    const cyclusBookingAllowed = settings?.allow_cyclus_booking !== false;
    const minToBundle = settings?.split_payment ? 1 : 2;
    const canBundle = cyclusBookingAllowed && sortedSlots.length >= minToBundle;

    if (canBundle) {
      const totalPrice = sortedSlots.reduce((sum, s) => sum + (s.price_per_session || 0), 0);
      bundles.push({
        cyclus_id: cyclusId,
        cyclus_name: sortedSlots[0].cyclus_name || cyclusNameFallback,
        slots: sortedSlots,
        totalPrice,
        firstDate: sortedSlots[0].start_time,
        lastDate: sortedSlots[sortedSlots.length - 1].start_time,
        location: sortedSlots[0].location,
        min_group_size: settings?.min_group_size,
      });
    }

    if (settings?.split_payment) {
      // Not bundled — only reachable when the owner disabled whole-series booking (with ≥1 bookable).
      // Sell ONLY genuinely per-seat sessions (allow_single_booking=true → the single-slot path already
      // charges price ÷ max_participants, i.e. the split share). A full-price single of a split session
      // would overcharge, so those sessions are never exposed standalone.
      if (!canBundle) {
        for (const slot of sortedSlots) {
          if (slot.allow_single_booking === true) partialCyclusSlots.push(slot);
        }
      }
    } else if (canBundle) {
      // Bundled + non-split: additionally expose allow_single_booking sessions as full-price singles.
      for (const slot of sortedSlots) {
        if (slot.allow_single_booking === true) {
          cycleSingleSessionSlots.push({ ...slot, allow_single_booking: false, fromCycle: true } as S);
        }
      }
    } else {
      // No bundle (booking disabled or <2 bookable), non-split: every session must stay bookable, so
      // offer each as an individual full-price fromCycle session.
      for (const slot of sortedSlots) {
        partialCyclusSlots.push({ ...slot, allow_single_booking: false, fromCycle: true } as S);
      }
    }
  }

  return { bundles, individualSlots: [...standaloneSlots, ...partialCyclusSlots, ...cycleSingleSessionSlots] };
}
