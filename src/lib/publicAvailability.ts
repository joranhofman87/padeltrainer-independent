/**
 * Shared shaping for the PUBLIC availability surfaces (the anon "what can I book" data on
 * academy/trainer/club pages, and the upcoming visual booking widget). The fetch lives in the
 * `usePublicAvailability` hook; the pure dedupe → visibility-filter → capacity-filter → map →
 * group-by-day transform lives here so it can be unit-tested without Supabase.
 *
 * Lifted verbatim (behavior-preserving) from AcademyPublicOpenSlots so every public surface shapes
 * availability identically. Visibility is enforced UPSTREAM via filterVisibleSlotIds (tier windows)
 * — this module only consumes the resulting `visibleIds` set; it never widens visibility.
 */
import { parseISO, isSameDay } from 'date-fns';

/** A single bookable public slot, shaped for display + booking. */
export interface PublicSlot {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  court_type: string | null;
  location_name: string | null;
  trainer_id: string | null;
  trainer_name: string | null;
  trainer_slug: string | null;
  price_per_session: number | null;
  total_price: number | null;
  extra_costs: { description: string; price: number }[];
  max_participants: number;
  allow_single_booking: boolean;
  spots_left: number;
  split_payment: boolean;
}

/** Public slots grouped by calendar day (in the caller's locale/day boundaries). */
export interface PublicDayGroup {
  date: Date;
  slots: PublicSlot[];
}

/** The raw availability_slots row shape this transform reads (superset-tolerant). */
export interface RawPublicSlotRow {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  court_type: string | null;
  price_per_session: number | null;
  total_price: number | null;
  max_participants: number | null;
  allow_single_booking: boolean | null;
  extra_costs: unknown;
  split_payment?: boolean | null;
  trainer_id: string | null;
  locations?: { name: string | null } | null;
}

export interface ShapeContext {
  /** slot_id → count of capacity-occupying bookings. */
  bookingCounts: Record<string, number>;
  /** slot ids that passed tier-visibility (filterVisibleSlotIds). */
  visibleIds: Set<string>;
  /** trainer_id → { slug, user_id }. */
  trainerMap: Record<string, { slug: string | null; user_id: string | null }>;
  /** user_id → full_name. */
  nameMap: Record<string, string>;
}

const DEFAULT_MAX_PARTICIPANTS = 4;

/**
 * Effective BOOKING capacity of a slot. A slot is PER-SEAT (capacity max_participants) when it is
 * `allow_single_booking` (per-spot single-session booking) OR `split_payment` (a cyclus whose total
 * is split among N players — each of the N books a seat and pays total ÷ N); otherwise it is booked
 * as a WHOLE (one booking, full price) → capacity 1. Mirrors the server RPCs (book_guest_cyclus_for_
 * payment 20260706160000 for the split case; book_*_for_payment 20260704190000 for the rest) so the
 * read-side "is it full?" matches what the booking RPC allows — without split-awareness a split slot
 * would vanish from the page after ONE of its N bookings. max_participants stays the attendee count.
 */
export function bookingCapacity(
  maxParticipants: number,
  allowSingleBooking: boolean | null | undefined,
  splitPayment: boolean | null | undefined = false,
): number {
  return allowSingleBooking || splitPayment ? maxParticipants : 1;
}

function parseExtraCosts(value: unknown): { description: string; price: number }[] {
  return Array.isArray(value)
    ? (value as { description: string; price: number }[]).filter((e) => e && typeof e.price === 'number')
    : [];
}

/**
 * Dedupe by id → drop tier-hidden → drop full → map to {@link PublicSlot} → group by day. Pure.
 * Mirrors AcademyPublicOpenSlots' original inline transform exactly so the refactor is invisible.
 */
export function mapAndGroupPublicSlots(rawSlots: RawPublicSlotRow[], ctx: ShapeContext): PublicDayGroup[] {
  const seen = new Set<string>();
  const slots: PublicSlot[] = rawSlots
    .filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      if (!ctx.visibleIds.has(s.id)) return false;
      const maxP = s.max_participants || DEFAULT_MAX_PARTICIPANTS;
      return (ctx.bookingCounts[s.id] || 0) < bookingCapacity(maxP, s.allow_single_booking, s.split_payment);
    })
    .map((s) => {
      const maxP = s.max_participants || DEFAULT_MAX_PARTICIPANTS;
      const booked = ctx.bookingCounts[s.id] || 0;
      const trainer = (s.trainer_id && ctx.trainerMap[s.trainer_id]) || { slug: null, user_id: null };
      const trainerName = trainer.user_id ? ctx.nameMap[trainer.user_id] || null : null;
      return {
        id: s.id,
        start_time: s.start_time,
        end_time: s.end_time,
        cyclus_id: s.cyclus_id,
        cyclus_name: s.cyclus_name,
        court_type: s.court_type,
        location_name: s.locations?.name || null,
        trainer_id: s.trainer_id,
        trainer_name: trainerName,
        trainer_slug: trainer.slug,
        price_per_session: s.price_per_session || null,
        total_price: s.total_price || null,
        extra_costs: parseExtraCosts(s.extra_costs),
        max_participants: maxP,
        allow_single_booking: s.allow_single_booking || false,
        spots_left: bookingCapacity(maxP, s.allow_single_booking, s.split_payment) - booked,
        split_payment: s.split_payment || false,
      };
    });

  const groups: PublicDayGroup[] = [];
  for (const slot of slots) {
    const slotDate = parseISO(slot.start_time);
    const existing = groups.find((g) => isSameDay(g.date, slotDate));
    if (existing) existing.slots.push(slot);
    else groups.push({ date: slotDate, slots: [slot] });
  }
  return groups;
}
