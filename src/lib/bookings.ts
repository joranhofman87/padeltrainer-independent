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

export interface SetBookingPaymentResult {
  /** Raw error when the booking payment write failed — nothing else ran. */
  bookingError: unknown | null;
  /** Set when the booking was updated but invoice reconciliation threw — the
   * booking IS marked, but a linked invoice may now be stale. */
  invoiceSyncError: Error | null;
}

/**
 * Reconcile every invoice that bills any of `bookingIds` to its bookings' real paid
 * state. Invoices reference bookings by a `booking_ids[]` array with NO foreign key
 * (see DOMAIN_MODEL.md), so this link is reconciled explicitly:
 *  - flip an invoice to `paid` once ALL of its non-cancelled bookings are paid
 *    (reconcile-when-fully-covered — a partly-paid invoice stays open); and
 *  - revert a `paid` invoice to `sent` when a booking is un-marked and full
 *    coverage breaks.
 * Idempotent: only writes when the target status actually differs. Cancelled
 * invoices are left untouched.
 */
export async function reconcileBookingInvoices(
  bookingIds: string[],
  client: SupabaseClient<Database> = supabase,
): Promise<void> {
  if (bookingIds.length === 0) return;

  const { data: invoices, error: invErr } = await client
    .from('invoices')
    .select('id, status, booking_ids')
    .overlaps('booking_ids', bookingIds)
    .neq('status', 'cancelled');
  if (invErr) throw new Error(invErr.message);

  for (const inv of invoices ?? []) {
    const ids = ((inv.booking_ids as string[] | null) ?? []);
    if (ids.length === 0) continue;

    const { data: bookings, error: bkErr } = await client
      .from('bookings')
      .select('id, payment_status, status')
      .in('id', ids);
    if (bkErr) throw new Error(bkErr.message);

    // Cancelled bookings don't owe anything — exclude them from the coverage test.
    const active = (bookings ?? []).filter((b) => b.status !== 'cancelled');
    if (active.length === 0) continue;
    const allPaid = active.every((b) => b.payment_status === 'paid');

    if (allPaid && inv.status !== 'paid') {
      const { error } = await client
        .from('invoices')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', inv.id);
      if (error) throw new Error(error.message);
    } else if (!allPaid && inv.status === 'paid') {
      const { error } = await client
        .from('invoices')
        .update({ status: 'sent', paid_at: null })
        .eq('id', inv.id);
      if (error) throw new Error(error.message);
    }
  }
}

/**
 * Canonical "mark a booking paid / unpaid manually" (cash / paid-externally) write.
 *
 * Sets the booking's payment fields, then reconciles every invoice that bills it via
 * {@link reconcileBookingInvoices}. Previously the trainer toggle wrote
 * `payment_status` directly and stopped, leaving the linked invoice stale —
 * booking↔invoice divergence (audit E-005/E-010). The booking write commits BEFORE
 * the reconcile, so the failure modes are surfaced separately: `bookingError`
 * (nothing else ran → abort) vs `invoiceSyncError` (the booking IS marked, but an
 * invoice may be stale → warn).
 */
export async function setBookingPaymentAndReconcile(
  bookingId: string,
  paid: boolean,
  client: SupabaseClient<Database> = supabase,
): Promise<SetBookingPaymentResult> {
  const now = new Date().toISOString();
  const { error: bookingError } = await client
    .from('bookings')
    .update(
      paid
        ? { payment_status: 'paid', paid_at: now, paid_externally: true }
        : { payment_status: 'pending', paid_at: null, paid_externally: false },
    )
    .eq('id', bookingId);
  if (bookingError) return { bookingError, invoiceSyncError: null };

  try {
    await reconcileBookingInvoices([bookingId], client);
  } catch (err) {
    return { bookingError: null, invoiceSyncError: err instanceof Error ? err : new Error(String(err)) };
  }
  return { bookingError: null, invoiceSyncError: null };
}
