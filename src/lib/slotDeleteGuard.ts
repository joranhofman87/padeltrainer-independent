import { supabase } from '@/lib/supabaseClient';
import { CAPACITY_OCCUPYING_STATUSES } from '@/lib/lessons';
import { cancelBookingsAndSync } from '@/lib/bookings';
import { syncSplitCountForCycle } from '@/lib/invoiceSync';

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

export interface CancelAndDeleteSlotsResult extends SlotDeleteResult {
  /** Active bookings that were soft-cancelled to free the slots for deletion. */
  cancelledBookings: number;
  /** Cancel/delete committed but a follow-up invoice resync threw (non-fatal). */
  syncError: Error | null;
}

/**
 * Remove sessions that STILL HAVE bookings: soft-cancel every active booking on `slotIds` first
 * (so the guarded {@link applySlotDeleteToCycle} will actually delete them), then delete the slots,
 * then resync the cycle's split amounts. The "Don't update invoices" toggle threads through as
 * `skipInvoices` — when set, neither the booking-removal nor the split resync touches invoices
 * (the owner reconciles billing manually), matching the rest of the cycle page.
 *
 * Use this only where the owner has EXPLICITLY opted to drop a booked session (the per-session
 * delete confirm and the looptijd trim's "also remove booked sessions" opt-in). The plain
 * {@link applySlotDeleteToCycle} still protects booked slots for every other path.
 */
export async function cancelBookingsAndDeleteSlots(
  cycleId: string | null,
  slotIds: string[],
  options?: { skipInvoices?: boolean },
): Promise<CancelAndDeleteSlotsResult> {
  if (slotIds.length === 0) {
    return { deletedCount: 0, protectedCount: 0, protectedSlotIds: [], cancelledBookings: 0, syncError: null };
  }
  const skip = options?.skipInvoices ?? false;

  // 1. Cancel the active bookings on these slots (the RPC refuses to delete a slot that still holds
  //    an occupying booking). cancelBookingsAndSync reconciles those bookings' invoices unless skip.
  const { data: bookingRows, error: bErr } = await supabase
    .from('bookings')
    .select('id')
    .in('slot_id', slotIds)
    .in('status', CAPACITY_OCCUPYING_STATUSES as unknown as string[]);
  if (bErr) throw bErr;
  const bookingIds = (bookingRows ?? []).map((b) => b.id as string);

  let syncError: Error | null = null;
  if (bookingIds.length > 0) {
    const res = await cancelBookingsAndSync(bookingIds, supabase, { skipInvoiceSync: skip, declineClaims: true });
    if (res.cancelError) throw res.cancelError;
    if (res.syncError) syncError = res.syncError;
  }

  // 2. Delete the now-empty slots via the guarded RPC.
  const del = await applySlotDeleteToCycle(cycleId, slotIds);

  // 3. Rebuild the cycle's split amounts (the RPC only stamps split_count) — unless skipping invoices.
  if (del.deletedCount > 0 && !skip) {
    try {
      await syncSplitCountForCycle(cycleId);
    } catch (e) {
      syncError = e instanceof Error ? e : new Error(String(e));
    }
  }

  return { ...del, cancelledBookings: bookingIds.length, syncError };
}
