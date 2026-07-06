/**
 * Quick slot/cycle generator — create lib.
 *
 * `generateCycleWithSlots(input)` turns one weekly rule into DRAFT cycli plus
 * their availability slots in a single flow:
 *   plan (pure `planSlots`) → overlap-dedup vs the trainer's existing slots →
 *   group into per-(weekday + start-time) series → create ONE `status:'draft'
 *   type:'cyclus'` cycle PER series → batch-insert all slots (each carrying its
 *   series' `cyclus_id`) with `is_public:false` (not bookable until published).
 *
 * Per-series, not one mega-cyclus: "every Monday 18:00" and "every Wednesday
 * 19:00" become separate cycli, each independently bookable/payable as a unit —
 * a flat batch of mixed days/times was never a meaningful "pay for the cyclus".
 *
 * Slots are born private (`is_public:false`) and the cycle is `draft`; the
 * owner reviews them in the agenda and publishes (see `publishCycle`). The
 * public/private + upfront-payment intent is recorded in `cycle.settings`
 * (`publish_visibility`, `payment_timing`, `requires_upfront_payment`) so the
 * later public-booking flow (Phase B) attaches without touching generation.
 *
 * Atomicity: the slot insert is one statement; on ANY failure (a mid-loop
 * createCycle throw OR the slot insert) every already-created per-series draft
 * cyclus in `createdCycleIds` is deleted, so no slot-less shells are left behind
 * (a failed cleanup is surfaced on the rethrown error, never swallowed).
 * A zero-slot config (or all-overlap) throws before/without leaving a cycle.
 */
import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { createCycle } from '@/lib/cycleWrites';
import { insertAvailabilitySlots } from '@/lib/slots';
import { planSlots, groupSlotsBySeries, type SlotPlanConfig } from '@/lib/slotPlan';
import { epochRange, fetchTrainerSlotRanges, splitByOverlap } from '@/lib/slotConflicts';
import type { CycleSettings, ExtraCost } from '@/lib/cycleTypes';

export interface GenerateCycleInput {
  ownerType: 'trainer' | 'academy';
  /** cycles.owner_id — trainer_profiles.id or academy_profiles.id. */
  ownerId: string;
  cycleName: string;
  /** Slot owner (trainer_profiles.id). On the academy side this is the picked trainer. */
  trainerId: string;
  /** Set when ownerType === 'academy'. */
  academyProfileId?: string | null;
  locationId?: string | null;
  courtType?: string | null;
  pricePerSession: number;
  /** null → DB default capacity. */
  maxParticipants?: number | null;
  /** true → players may book a single session; false → whole cycle only. */
  allowSingleBooking: boolean;
  /** Whole-slot selling: sessions bookable individually as the ENTIRE slot at full price. */
  wholeSlotBooking?: boolean;
  /** false → whole-series checkout refused (settings.allow_cyclus_booking; default true). */
  allowCyclusBooking?: boolean;
  pricesIncludeVat?: boolean;
  /** Stored intent; applied to slots on publish (draft slots stay private). */
  publishVisibility: 'public' | 'private';
  /** Phase-B-inert marker for "public + must pay upfront". */
  requiresUpfrontPayment?: boolean;
  extraCosts?: ExtraCost[];
  ratingSystem?: string | null;
  minRating?: number | null;
  maxRating?: number | null;
  /** The weekly rule, fed to the pure `planSlots`. */
  plan: SlotPlanConfig;
  /** BCP-47 locale for the per-series name suffix (e.g. "ma 18:00"). Defaults to nl-NL. */
  locale?: string;
}

export interface GenerateCycleResult {
  /** One id per created cyclus — one per (weekday + start-time) series in the batch. */
  cycleIds: string[];
  cyclesCreated: number;
  slotsCreated: number;
  /** Planned slots dropped because their time range overlaps a slot the trainer already has. */
  skippedOverlaps: number;
}

export class SlotGeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotGeneratorError';
  }
}

const msgOf = (e: unknown): string =>
  (e as { message?: string } | null)?.message ?? String(e);

export async function generateCycleWithSlots(
  input: GenerateCycleInput,
  client: SupabaseClient<Database> = supabase,
): Promise<GenerateCycleResult> {
  // Pure planning first — throws SlotPlanError on invalid config or past the cap.
  const drafts = planSlots(input.plan);
  if (drafts.length === 0) {
    throw new SlotGeneratorError(
      'This configuration produces no slots — widen the window, weekdays, or date range.',
    );
  }

  // Overlap dedup: skip any planned slot whose TIME RANGE overlaps a slot the trainer
  // already has (not just exact-start matches — a shifted re-run must not double-book
  // the court). Best-effort UX layer: the DB trigger (20260708100000) is the
  // authoritative, race-proof backstop. Read is paginated + bounded to the batch window.
  const earliest = drafts[0].startISO;
  const latestEnd = drafts.reduce((max, d) => (d.endISO > max ? d.endISO : max), drafts[0].endISO);
  const { byTrainer, error: readErr } = await fetchTrainerSlotRanges(
    [input.trainerId],
    earliest,
    latestEnd,
    client,
  );
  if (readErr) throw new SlotGeneratorError(`Failed to check existing slots: ${msgOf(readErr)}`);
  const existing = byTrainer.get(input.trainerId) ?? [];
  const { fresh, skipped } = splitByOverlap(drafts, (d) => epochRange(d.startISO, d.endISO), existing);
  const skippedOverlaps = skipped.length;
  if (fresh.length === 0) {
    // Carries the trigger's token so surfaces that map trainer_slot_overlap show the
    // translated message; friendlyError suppresses the raw text everywhere else.
    throw new SlotGeneratorError(
      'trainer_slot_overlap: every planned session overlaps an existing session for this trainer — nothing to generate.',
    );
  }

  const pricesIncludeVat = input.pricesIncludeVat ?? true;
  const hasExtraCosts = !!input.extraCosts && input.extraCosts.length > 0;

  const settings: CycleSettings = {
    generated_by: 'slot_generator',
    allow_single_booking: input.allowSingleBooking,
    whole_slot_booking: input.wholeSlotBooking ?? false,
    allow_cyclus_booking: input.allowCyclusBooking ?? true,
    publish_visibility: input.publishVisibility,
    prices_include_vat: pricesIncludeVat,
    ...(hasExtraCosts ? { extra_costs: input.extraCosts } : {}),
    ...(input.maxParticipants != null ? { max_group_size: input.maxParticipants } : {}),
    ...(input.requiresUpfrontPayment ? { payment_timing: 'upfront', requires_upfront_payment: true } : {}),
    ...(input.plan.holidayRanges && input.plan.holidayRanges.length > 0
      ? { excluded_dates: input.plan.holidayRanges.flatMap((h) => [h.from, h.to]) }
      : {}),
  };

  // One cyclus per (weekday + start-time) series. The base name gets a "ma 18:00" suffix per series.
  // Own the empty-name rule here (not just in the wizard) so the persisted name can't drift from the
  // preview: a blank base name falls back to the series label alone, never " – ma 18:00".
  const baseName = input.cycleName.trim();
  const series = groupSlotsBySeries(fresh, input.plan.timezone, input.locale);
  const createdCycleIds: string[] = [];

  try {
    const rows: Record<string, unknown>[] = [];
    for (const s of series) {
      const name = baseName ? `${baseName} – ${s.label}` : s.label;
      const cycle = await createCycle(
        {
          owner_type: input.ownerType,
          owner_id: input.ownerId,
          name,
          type: 'cyclus',
          status: 'draft',
          location_id: input.locationId ?? null,
          price_per_session: input.pricePerSession,
          total_price: Math.round(input.pricePerSession * s.slots.length * 100) / 100,
          settings,
        },
        client,
      );
      createdCycleIds.push(cycle.id);
      for (const d of s.slots) {
        rows.push({
          trainer_id: input.trainerId,
          academy_profile_id: input.academyProfileId ?? null,
          location_id: input.locationId ?? null,
          court_type: input.courtType ?? null,
          start_time: d.startISO,
          end_time: d.endISO,
          price_per_session: input.pricePerSession,
          total_price: input.pricePerSession,
          max_participants: input.maxParticipants ?? null,
          allow_single_booking: input.allowSingleBooking,
    whole_slot_booking: input.wholeSlotBooking ?? false,
          is_public: false, // DRAFT — not bookable until published
          prices_include_vat: pricesIncludeVat,
          cyclus_id: cycle.id,
          cyclus_name: name,
          rating_system: input.ratingSystem ?? null,
          min_rating: input.minRating ?? null,
          max_rating: input.maxRating ?? null,
          ...(hasExtraCosts ? { extra_costs: input.extraCosts } : {}),
        });
      }
    }

    const { error: insErr } = await insertAvailabilitySlots(rows, client, 'id');
    if (insErr) throw new SlotGeneratorError(`Failed to create slots: ${msgOf(insErr)}`);

    return {
      cycleIds: createdCycleIds,
      cyclesCreated: createdCycleIds.length,
      slotsCreated: rows.length,
      skippedOverlaps,
    };
  } catch (e) {
    // Abort cleanup — never leave slot-less draft cycli behind (covers a mid-loop createCycle
    // failure as well as a failed slot insert). Surface (don't swallow) a failed cleanup, so N
    // leaked empty cycli can't go unnoticed in the cyclus overview.
    let cleanupNote = '';
    if (createdCycleIds.length > 0) {
      const { error: delErr } = await client.from('cycles').delete().in('id', createdCycleIds);
      if (delErr) {
        cleanupNote = ` (cleanup of ${createdCycleIds.length} draft cyclus/cycli ALSO failed: ${msgOf(delErr)})`;
      }
    }
    const base = e instanceof SlotGeneratorError ? e.message : msgOf(e);
    throw new SlotGeneratorError(base + cleanupNote);
  }
}
