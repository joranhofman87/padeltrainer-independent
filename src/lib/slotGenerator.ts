/**
 * Quick slot/cycle generator — create lib.
 *
 * `generateCycleWithSlots(input)` turns one weekly rule into a DRAFT cycle plus
 * all its availability slots in a single flow:
 *   plan (pure `planSlots`) → overlap-dedup vs the trainer's existing slots →
 *   create a `status:'draft' type:'cyclus'` cycle → batch-insert the slots with
 *   `is_public:false` (not bookable until the owner publishes).
 *
 * Slots are born private (`is_public:false`) and the cycle is `draft`; the
 * owner reviews them in the agenda and publishes (see `publishCycle`). The
 * public/private + upfront-payment intent is recorded in `cycle.settings`
 * (`publish_visibility`, `payment_timing`, `requires_upfront_payment`) so the
 * later public-booking flow (Phase B) attaches without touching generation.
 *
 * Atomicity: the slot insert is one statement; if it fails, the just-created
 * draft cycle is deleted (abort cleanup) so no slot-less shell is left behind.
 * A zero-slot config (or all-overlap) throws before/without leaving a cycle.
 */
import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { createCycle } from '@/lib/cycleWrites';
import { insertAvailabilitySlots } from '@/lib/slots';
import { planSlots, type SlotPlanConfig } from '@/lib/slotPlan';
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
}

export interface GenerateCycleResult {
  cycleId: string;
  slotsCreated: number;
  /** Planned slots dropped because the trainer already has a slot at that start. */
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

  // Overlap dedup: skip any planned start the trainer already has a slot at.
  const earliest = drafts[0].startISO;
  const { data: existing, error: readErr } = await client
    .from('availability_slots')
    .select('start_time')
    .eq('trainer_id', input.trainerId)
    .gte('start_time', earliest);
  if (readErr) throw new SlotGeneratorError(`Failed to check existing slots: ${msgOf(readErr)}`);
  const taken = new Set(
    ((existing as { start_time: string }[] | null) ?? []).map((r) => new Date(r.start_time).toISOString()),
  );
  const fresh = drafts.filter((d) => !taken.has(d.startISO));
  const skippedOverlaps = drafts.length - fresh.length;
  if (fresh.length === 0) {
    throw new SlotGeneratorError('All planned slots already exist for this trainer — nothing to generate.');
  }

  const pricesIncludeVat = input.pricesIncludeVat ?? true;
  const hasExtraCosts = !!input.extraCosts && input.extraCosts.length > 0;

  const settings: CycleSettings = {
    generated_by: 'slot_generator',
    allow_single_booking: input.allowSingleBooking,
    publish_visibility: input.publishVisibility,
    prices_include_vat: pricesIncludeVat,
    ...(hasExtraCosts ? { extra_costs: input.extraCosts } : {}),
    ...(input.maxParticipants != null ? { max_group_size: input.maxParticipants } : {}),
    ...(input.requiresUpfrontPayment ? { payment_timing: 'upfront', requires_upfront_payment: true } : {}),
    ...(input.plan.holidayRanges && input.plan.holidayRanges.length > 0
      ? { excluded_dates: input.plan.holidayRanges.flatMap((h) => [h.from, h.to]) }
      : {}),
  };

  const cycle = await createCycle(
    {
      owner_type: input.ownerType,
      owner_id: input.ownerId,
      name: input.cycleName,
      type: 'cyclus',
      status: 'draft',
      location_id: input.locationId ?? null,
      price_per_session: input.pricePerSession,
      total_price: Math.round(input.pricePerSession * fresh.length * 100) / 100,
      settings,
    },
    client,
  );

  const rows = fresh.map((d) => ({
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
    is_public: false, // DRAFT — not bookable until published
    prices_include_vat: pricesIncludeVat,
    cyclus_id: cycle.id,
    cyclus_name: input.cycleName,
    rating_system: input.ratingSystem ?? null,
    min_rating: input.minRating ?? null,
    max_rating: input.maxRating ?? null,
    ...(hasExtraCosts ? { extra_costs: input.extraCosts } : {}),
  }));

  const { error: insErr } = await insertAvailabilitySlots(rows, client, 'id');
  if (insErr) {
    // Abort cleanup — never leave a slot-less draft cycle behind.
    await client.from('cycles').delete().eq('id', cycle.id);
    throw new SlotGeneratorError(`Failed to create slots: ${msgOf(insErr)}`);
  }

  return { cycleId: cycle.id, slotsCreated: rows.length, skippedOverlaps };
}
