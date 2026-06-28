import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { cancelBookingsAndSync } from '@/lib/bookings';

export interface CyclePaymentParams {
  /**
   * EXACTLY the booking ids returned by the insert that just created this
   * cycle's pending bookings — never a status re-query. A re-query by
   * (player_id, slot_id, status='pending') could fold a prior
   * abandoned-checkout pending row into this payment and mis-spread the split
   * amount across more rows than intended (Codex foundation-verification, A2).
   */
  bookingIds: string[];
  slotId: string;
  amount: number;
  description: string;
  trainerId: string;
}

/**
 * Initiate the online (upfront) payment for a cycle whose bookings were JUST
 * inserted, and guarantee no orphan capacity is left behind on failure.
 *
 * The cycle online-booking flow inserts the pending bookings first (so the
 * split-payment headcount is correct), then creates the Mollie payment. If
 * payment creation fails AFTER the insert — token refresh, missing Mollie
 * profile, Mollie 4xx, network — the just-inserted 'pending' bookings would
 * otherwise linger, occupying slot capacity (CAPACITY_OCCUPYING_STATUSES) and
 * distorting the split-payment divisor. This helper soft-cancels them through
 * the booking facade ({@link cancelBookingsAndSync}, status='cancelled', never a
 * hard delete) before re-throwing, so a failed checkout never strands a seat
 * (Codex foundation-verification, A3).
 *
 * @returns the Mollie checkout URL to redirect to.
 * @throws the original payment error (after rolling back the bookings) when
 *   creation fails or returns no checkout URL.
 */
export async function initiateCyclePayment(
  params: CyclePaymentParams,
  client: SupabaseClient<Database> = supabase,
): Promise<{ checkoutUrl: string }> {
  const { bookingIds, slotId, amount, description, trainerId } = params;

  const { data, error } = await client.functions.invoke('create-mollie-payment', {
    body: { slotId, amount, description, trainerId, bookingIds },
  });

  const checkoutUrl = (data as { checkoutUrl?: string } | null)?.checkoutUrl;
  if (error || !checkoutUrl) {
    // Roll back the just-inserted bookings so a failed checkout leaves no
    // capacity-occupying orphan, then surface the ORIGINAL failure unchanged.
    await cancelBookingsAndSync(bookingIds, client);
    throw error ?? new Error('No checkout URL received');
  }

  return { checkoutUrl };
}
