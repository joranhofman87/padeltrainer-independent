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
