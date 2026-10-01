import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

export interface MarkInvoicePaidResult {
  error: Error | null;
  /** true when the invoice could not be paid because it is cancelled. */
  blockedCancelled?: boolean;
  /**
   * true once the invoice IS paid. Under the server boundary this is no longer a partial state:
   * the invoice and its bookings settle in ONE transaction, so `invoicePaid: true` also means the
   * linked bookings are settled.
   */
  invoicePaid?: boolean;
  /** Bookings that took the money but hold no seat — surfaced so the UI can say so. */
  paidNoSeat?: string[];
}

/**
 * Request MANUAL settlement of an invoice ("we received this out of band").
 *
 * This used to be a browser-side pair of writes: flip `invoices.status='paid'`, then update the
 * linked bookings. Two problems, both real:
 *  - it was not atomic. A closed tab, a dropped connection or an RLS refusal on the second write
 *    left a PAID invoice whose seats were still unpaid, and no retry could tell the difference.
 *  - it made the browser a settlement authority. Capacity, M-17 survivors and replay detection
 *    are decided under database locks; a client cannot participate in that.
 *
 * Settlement now happens in one authenticated server call. Authorization is unchanged — the
 * function evaluates the caller's own JWT against the same rule the invoices UPDATE policies
 * encode (owning trainer, or academy manager). No Mollie id is invented for a manual payment.
 * Retrying is safe: a second request settles nothing new and fires no side-effect twice.
 */
export async function requestManualInvoiceSettlement(
  invoiceId: string,
  client: SupabaseClient<Database> = supabase,
): Promise<MarkInvoicePaidResult> {
  const { data, error } = await client.functions.invoke('settle-invoice-manual', {
    body: { invoiceId },
  });

  const payload = (data ?? null) as
    | { settled?: boolean; invoicePaid?: boolean; refusalReason?: string; paidNoSeat?: string[]; error?: string }
    | null;

  // A refused settlement is reported as a refusal, never as success. `invokeError` is set for a
  // non-2xx response, so the refusal body has to be read out of the payload too.
  if (payload?.refusalReason === 'invoice_cancelled') {
    return { error: null, blockedCancelled: true, invoicePaid: false };
  }
  // A refusal carries the server's reason, which is more useful than the HTTP status the
  // transport reports for the same response.
  if (payload?.refusalReason) {
    return { error: new Error(payload.refusalReason), invoicePaid: false };
  }
  if (error) {
    return { error: new Error(payload?.error || error.message), invoicePaid: false };
  }
  if (!payload?.settled) {
    return {
      error: new Error(payload?.refusalReason || payload?.error || 'Settlement failed'),
      invoicePaid: false,
    };
  }

  return { error: null, invoicePaid: true, paidNoSeat: payload.paidNoSeat ?? [] };
}
