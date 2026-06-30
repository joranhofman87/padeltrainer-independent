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
  options?: { skipInvoiceSync?: boolean },
): Promise<CancelBookingResult> {
  if (bookingIds.length === 0) return { cancelError: null, syncError: null };

  const { data: cancelledRows, error: cancelError } = await client
    .from('bookings')
    .update({ status: 'cancelled' })
    .in('id', bookingIds)
    .select('id');
  if (cancelError) return { cancelError, syncError: null };
  // An RLS-blocked UPDATE returns NO error but changes 0 rows. Surface that as a real failure so the
  // caller never reports a phantom success (e.g. "removed from 14 sessions" while nothing changed —
  // the academy-manager bookings UPDATE policy, 20260704120000, must be live for this to persist).
  if ((cancelledRows?.length ?? 0) === 0) {
    return {
      cancelError: new Error('No bookings were cancelled — you may not have permission to change these bookings.'),
      syncError: null,
    };
  }

  // Deliberate "Don't update invoices" roster edit: soft-cancel the booking but
  // leave every linked invoice exactly as it is (the owner reconciles billing
  // manually). Paid invoices are never touched either way.
  if (options?.skipInvoiceSync) return { cancelError: null, syncError: null };

  try {
    await syncInvoicesAfterBookingRemoval(bookingIds);
  } catch (err) {
    return { cancelError: null, syncError: err instanceof Error ? err : new Error(String(err)) };
  }
  return { cancelError: null, syncError: null };
}

export interface CancelPlayerInCycleResult extends CancelBookingResult {
  /** How many of the player's active bookings were soft-cancelled. */
  cancelledCount: number;
}

/**
 * Remove ONE player from a whole cycle/series in one action: find that player's
 * active (non-cancelled) bookings among `slotIds` and soft-cancel them via
 * {@link cancelBookingsAndSync}. The caller decides which slots to act on (e.g.
 * the cycle's FUTURE sessions, mirroring the whole-cycle ADD scope). A player is
 * matched by `playerId` (profile) OR `guestPlayerId` (guest) — whichever the
 * roster row carries. `options.skipInvoiceSync` threads straight through, so a
 * whole-cycle remove can leave invoices untouched. No bookings found ⇒ no-op.
 */
export async function cancelPlayerBookingsInCycle(
  slotIds: string[],
  player: { playerId?: string | null; guestPlayerId?: string | null },
  client: SupabaseClient<Database> = supabase,
  options?: { skipInvoiceSync?: boolean },
): Promise<CancelPlayerInCycleResult> {
  if (slotIds.length === 0 || (!player.playerId && !player.guestPlayerId)) {
    return { cancelError: null, syncError: null, cancelledCount: 0 };
  }

  let query = client
    .from('bookings')
    .select('id')
    .in('slot_id', slotIds)
    .neq('status', 'cancelled');
  query = player.playerId
    ? query.eq('player_id', player.playerId)
    : query.eq('guest_player_id', player.guestPlayerId as string);

  const { data, error } = await query;
  if (error) return { cancelError: error, syncError: null, cancelledCount: 0 };

  const ids = (data ?? []).map((b) => b.id as string);
  if (ids.length === 0) return { cancelError: null, syncError: null, cancelledCount: 0 };

  const res = await cancelBookingsAndSync(ids, client, options);
  return { ...res, cancelledCount: ids.length };
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

/**
 * Insert booking row(s) — the single write point for booking creation.
 *
 * The twin of {@link insertAvailabilitySlots} in `src/lib/slots.ts`. Accepts one
 * row or an array (the cyclus paths pass arrays); pass `returning` to get the
 * inserted rows back via `.select(returning)` (e.g. `'id'`, or the surface's
 * `INSERTED_BOOKING_SELECT` projection for the add-player invoice flow) — the
 * result is always an ARRAY (no `.single()`).
 *
 * Row shape is intentionally permissive: each surface (cyclus bulk-book,
 * book-for-player, inline add-player) builds its OWN fully-typed literal.
 * `payment_amount` / `payment_status` / `status` / `guest_player_id`-vs-
 * `player_id` are money-path and stay author-controlled at the call site — this
 * owns only the raw write so it can't diverge per screen. Capacity is enforced
 * by the `enforce_booking_slot_tier` DB trigger, not here. Pure pass-through:
 * rows are NOT normalized, so an `undefined` key still drops (supabase-js) and a
 * column default applies, exactly as an inline insert would.
 */
export async function insertBookings(
  rows: Record<string, unknown> | Record<string, unknown>[],
  client: SupabaseClient<Database> = supabase,
  returning?: string,
): Promise<{ data: unknown; error: unknown }> {
  const query = client.from('bookings').insert(rows as never);
  if (returning) {
    const { data, error } = await query.select(returning);
    return { data, error: error ?? null };
  }
  const { error } = await query;
  return { data: null, error: error ?? null };
}

/**
 * Insert a SINGLE booking row and return it as one object via
 * `.select(returning).single()` — for the call sites that read exactly one row
 * back (e.g. the just-created booking's id). This is the `.single()` shape that
 * the array-returning {@link insertBookings} deliberately can't reproduce.
 * `returning` defaults to `'*'` (the bare `.select()`). Same pure-pass-through
 * row handling as {@link insertBookings}. Returns `{ data: <row>|null, error }`.
 */
export async function insertBookingSingle(
  row: Record<string, unknown>,
  client: SupabaseClient<Database> = supabase,
  returning = '*',
): Promise<{ data: unknown; error: unknown }> {
  const { data, error } = await client.from('bookings').insert(row as never).select(returning).single();
  return { data, error: error ?? null };
}
