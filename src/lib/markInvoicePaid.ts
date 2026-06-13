import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

export interface MarkInvoicePaidResult {
  error: Error | null;
  /** true when the invoice was cancelled and therefore could not be paid. */
  blockedCancelled?: boolean;
  /**
   * true once invoices.status was flipped to 'paid'. When `error` is set but
   * `invoicePaid` is true, the invoice IS paid but the linked-booking sync
   * failed — callers can surface that distinct state.
   */
  invoicePaid?: boolean;
}

/**
 * Single source of truth for "mark an invoice paid".
 *
 * Flips the invoice to paid AND propagates the canonical paid transition to
 * every linked booking — `payment_status='paid'`, `status='confirmed'`,
 * `paid_at` — mirroring supabase/functions/mollie-webhook (the authoritative
 * paid path). Every MANUAL mark-paid path (trainer/academy edit pages, the
 * trainer InvoiceList) must route through this so the trainer, academy and
 * player surfaces never disagree about whether a session is paid. Previously
 * the manual paths updated only `invoices.status`, leaving bookings stale and
 * forcing the player surface to compensate with a client-side override.
 *
 * Cancelled invoices cannot be paid (returns `blockedCancelled`); cancelled
 * bookings linked to the invoice are never resurrected.
 */
export async function markInvoicePaidAndSyncBookings(
  invoiceId: string,
  bookingIds: string[] | null | undefined,
  client: SupabaseClient<Database> = supabase,
): Promise<MarkInvoicePaidResult> {
  const paidAt = new Date().toISOString();

  // Guard cancelled→paid: a cancelled invoice must not be revived as paid.
  const { data: updated, error: invErr } = await client
    .from('invoices')
    .update({ status: 'paid', paid_at: paidAt })
    .eq('id', invoiceId)
    .neq('status', 'cancelled')
    .select('id');
  if (invErr) return { error: new Error(invErr.message), invoicePaid: false };
  if (!updated || updated.length === 0) return { error: null, blockedCancelled: true, invoicePaid: false };

  // Propagate to the linked bookings so every surface reads the same DB truth.
  if (bookingIds && bookingIds.length > 0) {
    const { error: bkErr } = await client
      .from('bookings')
      .update({ payment_status: 'paid', status: 'confirmed', paid_at: paidAt })
      .in('id', bookingIds)
      .neq('status', 'cancelled')
      .neq('status', 'cancelled_swap');
    if (bkErr) return { error: new Error(bkErr.message), invoicePaid: true };
  }

  return { error: null, invoicePaid: true };
}
