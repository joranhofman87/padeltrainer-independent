// Cycle write operations (create / update / settings / delete + the atomic apply_slot_edit_to_cycle
// RPC), extracted from lib/cycles.ts (god-file split). These call no cycles.ts internals — they depend
// only on the shared toCycle mapper + applySlotDeleteToCycle guard + supabase — so cycles.ts re-exports
// via `export *` (and imports updateCycle back for its 2 callers).
import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Json, Database } from '@/integrations/supabase/types';
import type { Cycle, CycleInput, CycleSettings, SlotEditPatch, SlotEditResult } from './cycleTypes';
import { toCycle } from './cycleMappers';
import { applySlotDeleteToCycle } from '@/lib/slotDeleteGuard';
import { setSlotVisibility } from '@/lib/slots';

/**
 * Atomic, set-based slot edit / apply-to-cycle via the `apply_slot_edit_to_cycle` RPC (Phase 4 F2).
 *
 * Replaces the non-atomic per-slot "apply to whole cyclus" client loop. Applies a relative time
 * shift + non-price fields to every `slotIds` row in ONE statement, with an ALL-OR-NOTHING
 * capacity-shrink guard: if a requested `maxParticipants` would shrink any slot below its occupancy,
 * NOTHING is updated and the offending slots come back in `blockedSlotIds`.
 *
 * Adoption notes (Slice 7b):
 *  • Omitted keys are KEPT per-slot — there is no normalization. To reproduce the client's
 *    whole-cyclus overwrite, populate EVERY non-price field, not a changed-only diff.
 *  • `startShiftMinutes` + `durationMinutes` travel together (both or neither; throws otherwise). A
 *    pure resize passes `startShiftMinutes: 0`.
 *  • Relative-shift + cycle-scope + NON-PRICE only. Single-slot absolute-time edits and any price
 *    write stay on the existing path / {@link updateCyclePricing} (slot = price source of truth).
 *
 * INERT until Slice 7b adopts it; wrap callers in a graceful fallback before the owner deploys the
 * migration. `cycleId` may be null (orphan-cyclus slots).
 */
export async function applySlotEditToCycle(
  cycleId: string | null,
  slotIds: string[],
  patch: SlotEditPatch,
): Promise<SlotEditResult> {
  if ((patch.startShiftMinutes === undefined) !== (patch.durationMinutes === undefined)) {
    throw new Error('applySlotEditToCycle: startShiftMinutes and durationMinutes must be provided together');
  }
  const p: Record<string, unknown> = {};
  // Round the integer-typed fields so a fractional value can't abort the server-side ::int cast.
  if (patch.startShiftMinutes !== undefined) p.start_shift_minutes = Math.round(patch.startShiftMinutes);
  if (patch.durationMinutes !== undefined) p.duration_minutes = Math.round(patch.durationMinutes);
  if (patch.maxParticipants !== undefined) {
    p.max_participants = patch.maxParticipants === null ? null : Math.round(patch.maxParticipants);
  }
  if (patch.trainerId !== undefined) p.trainer_id = patch.trainerId;
  if (patch.locationId !== undefined) p.location_id = patch.locationId;
  if (patch.ratingSystem !== undefined) p.rating_system = patch.ratingSystem;
  if (patch.minRating !== undefined) p.min_rating = patch.minRating;
  if (patch.maxRating !== undefined) p.max_rating = patch.maxRating;
  if (patch.cyclusName !== undefined) p.cyclus_name = patch.cyclusName;
  if (patch.isPublic !== undefined) p.is_public = patch.isPublic;

  if (slotIds.length === 0 || Object.keys(p).length === 0) {
    return { updatedCount: 0, blockedCount: 0, blockedSlotIds: [] };
  }

  const { data, error } = await supabase.rpc('apply_slot_edit_to_cycle' as never, {
    _cycle_id: cycleId,
    _slot_ids: slotIds,
    _patch: p,
  } as never);
  if (error) throw error;
  const row = (data as unknown as Array<{
    updated_count: number | string;
    blocked_count: number | string;
    blocked_slot_ids: string[] | null;
  }>)?.[0];
  return {
    updatedCount: Number(row?.updated_count ?? 0),
    blockedCount: Number(row?.blocked_count ?? 0),
    blockedSlotIds: row?.blocked_slot_ids ?? [],
  };
}

export async function updateCycleSettings(cycleId: string, settings: CycleSettings): Promise<void> {
  const { error } = await supabase
    .from('cycles')
    .update({ settings: settings as unknown as Json })
    .eq('id', cycleId);
  if (error) throw error;
}

export async function createCycle(
  input: CycleInput,
  client: SupabaseClient<Database> = supabase,
): Promise<Cycle> {
  const insertData = {
    owner_type: input.owner_type,
    owner_id: input.owner_id,
    name: input.name,
    description: input.description || null,
    start_date: input.is_always_open ? null : (input.start_date ?? null),
    end_date: input.is_always_open ? null : (input.end_date ?? null),
    enrollment_deadline: input.is_always_open ? null : (input.enrollment_deadline || null),
    is_always_open: input.is_always_open ?? false,
    settings: (input.settings || {}) as Json,
    status: input.status || 'draft',
    type: input.type || 'registration',
    location_id: input.location_id || null,
    price_per_session: input.price_per_session ?? null,
    total_price: input.total_price ?? null,
    currency: input.currency || 'EUR',
    terms: input.terms ?? null,
    price_table: (input.price_table ?? null) as unknown as Json,
  };
  
  const { data, error } = await client
    .from('cycles')
    .insert(insertData)
    .select()
    .single();

  if (error) throw error;
  return toCycle(data);
}

export async function updateCycle(cycleId: string, updates: Partial<CycleInput>): Promise<Cycle> {
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.description !== undefined) updateData.description = updates.description;
  if (updates.start_date !== undefined) updateData.start_date = updates.start_date;
  if (updates.end_date !== undefined) updateData.end_date = updates.end_date;
  if (updates.enrollment_deadline !== undefined) updateData.enrollment_deadline = updates.enrollment_deadline;
  if (updates.is_always_open !== undefined) updateData.is_always_open = updates.is_always_open;
  if (updates.settings !== undefined) updateData.settings = updates.settings as Json;
  if (updates.status !== undefined) updateData.status = updates.status;
  if (updates.location_id !== undefined) updateData.location_id = updates.location_id;
  if (updates.price_per_session !== undefined) updateData.price_per_session = updates.price_per_session;
  if (updates.total_price !== undefined) updateData.total_price = updates.total_price;
  if (updates.currency !== undefined) updateData.currency = updates.currency;
  if (updates.terms !== undefined) updateData.terms = updates.terms;
  if (updates.price_table !== undefined) updateData.price_table = updates.price_table as unknown as Json;
  
  const { data, error } = await supabase
    .from('cycles')
    .update(updateData)
    .eq('id', cycleId)
    .select()
    .single();

  if (error) throw error;
  return toCycle(data);
}

/**
 * Publish a DRAFT cycle created by the slot generator: open it for booking and
 * apply the stored public/private intent to its slots.
 *
 * The generator inserts slots `is_public:false` (draft = not bookable) and the
 * cycle `status:'draft'`. Publishing flips the cycle to `open` and sets every
 * slot's visibility to `makePublic` (the owner's `settings.publish_visibility`
 * choice; `false` keeps a private cycle that staff can still book).
 *
 * Two non-atomic writes: if the visibility write fails the cycle is already
 * `open` but its slots stay private — safe (nothing is publicly visible until
 * `is_public` flips) and the owner can simply retry. (A future atomic RPC could
 * fuse the two if needed.)
 */
export async function publishCycle(
  cycleId: string,
  makePublic: boolean,
  client: SupabaseClient<Database> = supabase,
): Promise<void> {
  const { error: openErr } = await client
    .from('cycles')
    .update({ status: 'open', updated_at: new Date().toISOString() })
    .eq('id', cycleId);
  if (openErr) throw openErr;

  const { data, error: readErr } = await client
    .from('availability_slots')
    .select('id')
    .eq('cyclus_id', cycleId);
  if (readErr) throw readErr;

  const ids = ((data as { id: string }[] | null) ?? []).map((s) => s.id);
  const { error: visErr } = await setSlotVisibility(ids, makePublic, client);
  if (visErr) throw visErr;
}

/**
 * Publish a batch of cycli at once — e.g. all the per-series draft cycli the slot generator just
 * created. Resilient: one cyclus failing to publish never aborts the rest; returns how many
 * published / failed so the caller can report partial success. `makePublic` applies to the whole
 * batch (the generator's run shares a single visibility intent). `publishOne` is an injectable seam
 * for tests; production uses the real {@link publishCycle}.
 */
export async function publishCycles(
  cycleIds: string[],
  makePublic: boolean,
  client: SupabaseClient<Database> = supabase,
  publishOne: typeof publishCycle = publishCycle,
): Promise<{ published: number; failed: number }> {
  let published = 0;
  let failed = 0;
  for (const id of cycleIds) {
    try {
      await publishOne(id, makePublic, client);
      published += 1;
    } catch {
      failed += 1;
    }
  }
  return { published, failed };
}

/** Delete the given sessions, re-verifying right before deletion that none gained an
 *  occupying booking since the preview (a player booking is never silently cancelled).
 *  Deleting an availability_slot CASCADES (FK ON DELETE CASCADE) to its bookings, claims,
 *  session reports + notes — which is exactly why the booking re-check is the load-bearing
 *  guard here. Invoices are not FK-linked to slots, so they are untouched. */
export async function deleteUnbookedSlots(slotIds: string[]): Promise<number> {
  if (slotIds.length === 0) return 0;
  // Atomic delete via the canonical RPC: it locks each slot + its bookings FOR UPDATE and KEEPS any
  // that holds a booking, instead of the old check-then-delete (which could cascade-destroy a
  // booking that landed between the booking check and the DELETE). No cycle id → no split recompute,
  // which matches this trim's prior behaviour (it only removes unbooked tail sessions).
  const res = await applySlotDeleteToCycle(null, slotIds);
  return res.deletedCount;
}

export async function deleteCycle(cycleId: string): Promise<void> {
  const { error } = await supabase
    .from('cycles')
    .delete()
    .eq('id', cycleId);

  if (error) throw error;
}
