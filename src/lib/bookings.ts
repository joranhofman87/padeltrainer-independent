import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { syncInvoicesAfterBookingRemoval } from '@/lib/invoiceSync';

/**
 * Domain service for booking writes. UI screens (trainer / academy) should call
 * these instead of issuing raw `supabase.from('bookings')` mutations, so the
 * booking↔invoice write rules live in ONE place and can't diverge per screen.
 */

export interface CancelBookingResult {
  /**
   * The raw Supabase error when the booking(s) could not be cancelled — in
   * which case nothing else ran. Returned raw (not wrapped) so callers can pass
   * it straight to getFriendlyErrorMessage like the inline path did.
   */
  cancelError: unknown | null;
  /**
   * Set when the cancel committed but invoice reconciliation threw. The
   * player(s) ARE removed; some invoices may still bill them or show the wrong
   * split.
   */
  syncError: Error | null;
}

/**
 * Canonical "remove player(s) from session(s)" / cancel-bookings write.
 *
 * Soft-cancels the bookings (`status='cancelled'`, NEVER a hard delete — a
 * delete would lose history and, via `bookings.slot_id ON DELETE CASCADE`, is
 * unsafe) AND reconciles every invoice that billed them through
 * {@link syncInvoicesAfterBookingRemoval}. The cancel commits BEFORE the sync,
 * so the two failure modes are surfaced separately: `cancelError` (nothing
 * changed → abort + show the error) vs `syncError` (players removed, but warn
 * that invoices may be stale). Callers keep their own toast/UX and any
 * cycle-scope follow-up (e.g. syncSplitCountForCycle); this only owns the
 * booking↔invoice DB writes so they can't diverge across trainer/academy
 * screens. An empty list is a no-op.
 */
export async function cancelBookingsAndSync(
  bookingIds: string[],
  client: SupabaseClient<Database> = supabase,
): Promise<CancelBookingResult> {
  if (bookingIds.length === 0) return { cancelError: null, syncError: null };

  const { error: cancelError } = await client
    .from('bookings')
    .update({ status: 'cancelled' })
    .in('id', bookingIds);
  if (cancelError) return { cancelError, syncError: null };

  try {
    await syncInvoicesAfterBookingRemoval(bookingIds);
  } catch (err) {
    return { cancelError: null, syncError: err instanceof Error ? err : new Error(String(err)) };
  }
  return { cancelError: null, syncError: null };
}
