import { supabase } from '@/lib/supabaseClient';
import { CAPACITY_OCCUPYING_STATUSES } from '@/lib/lessons';

/**
 * Data-loss guard for slot deletion.
 *
 * `bookings.slot_id` is `ON DELETE CASCADE`, so deleting an availability_slot silently deletes its
 * bookings. Any "delete slots for this cycle" path (proposal reset / regeneration) must therefore
 * never delete a slot that still has an ACTIVE booking (canonical occupying statuses —
 * confirmed / pending / pending_approval). Use these helpers to filter the deletable set.
 */

/** The subset of `slotIds` that have at least one active (capacity-occupying) booking. */
export async function findBookedSlotIds(slotIds: string[]): Promise<Set<string>> {
  if (slotIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from('bookings')
    .select('slot_id')
    .in('slot_id', slotIds)
    .in('status', CAPACITY_OCCUPYING_STATUSES as unknown as string[]);
  if (error) throw error;
  return new Set((data ?? []).map((b) => b.slot_id as string));
}

/** Of `slotIds`, the ones safe to hard-delete (no active booking). */
export async function filterDeletableSlotIds(slotIds: string[]): Promise<string[]> {
  if (slotIds.length === 0) return [];
  const booked = await findBookedSlotIds(slotIds);
  return slotIds.filter((id) => !booked.has(id));
}

export interface SlotDeleteResult {
  /** How many slots were actually deleted. */
  deletedCount: number;
  /** How many requested slots were kept because they still hold an active booking. */
  protectedCount: number;
  /** The kept slot ids — surface these to the user ("N sessions kept, they're booked"). */
  protectedSlotIds: string[];
}

/**
 * Atomic, set-based slot delete via the `apply_slot_delete_to_cycle` RPC (Phase 4 F2).
 *
 * Does the same guard as {@link filterDeletableSlotIds} — never deletes a slot with a
 * capacity-occupying booking (bookings.slot_id is ON DELETE CASCADE) — but the guard + DELETE +
 * split-divisor recompute run in ONE transaction under row locks (candidate slots AND their
 * bookings), closing the client check-then-delete TOCTOU against both new bookings and concurrent
 * status flips, and replacing the non-atomic per-slot / 500-row client delete loops.
 *
 * ADOPTION CONTRACT — this is a GUARD, not a canceller or an invoice engine:
 *  • It KEEPS slots that still hold an occupying booking (returned in `protectedSlotIds`). A
 *    cancel-then-delete flow (today's trainer dialog) must cancel those bookings BEFORE calling, or
 *    the slots silently survive — surface a non-zero `protectedCount`, don't treat it as success.
 *  • Cancellation emails + invoice credit/recalc run on the caller, BEFORE this call, scoped to the
 *    slots it will actually delete (the cascade destroys the bookings those reads need).
 *  • The recalc only stamps `invoices.split_count`. The caller must STILL run its
 *    syncInvoicesAfterBookingRemoval / syncSplitCountForCycle AFTER this returns to rebuild invoice
 *    line-item AMOUNTS — this RPC does not touch line items.
 *
 * INERT until Slice 6 adopts it; wrap callers in a graceful fallback so it is safe before the owner
 * deploys the migration. `cycleId` may be null (pure delete of orphan-cyclus slots — no recalc).
 */
export async function applySlotDeleteToCycle(
  cycleId: string | null,
  slotIds: string[],
): Promise<SlotDeleteResult> {
  if (slotIds.length === 0) return { deletedCount: 0, protectedCount: 0, protectedSlotIds: [] };
  const { data, error } = await supabase.rpc('apply_slot_delete_to_cycle' as never, {
    _cycle_id: cycleId,
    _slot_ids: slotIds,
  } as never);
  if (error) throw error;
  const row = (data as unknown as Array<{
    deleted_count: number | string;
    protected_count: number | string;
    protected_slot_ids: string[] | null;
  }>)?.[0];
  return {
    deletedCount: Number(row?.deleted_count ?? 0),
    protectedCount: Number(row?.protected_count ?? 0),
    protectedSlotIds: row?.protected_slot_ids ?? [],
  };
}
