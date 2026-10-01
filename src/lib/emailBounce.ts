// Email delivery-failure (bounce) surfacing — read hooks over the Phase 3 RPCs.
//   useAcademyUndeliverableRecipients -> dashboard alert count + BouncingEmailsCard
//   useInvoicesDeliveryStatus         -> per-row bounce indicator on the invoice list
// The per-PLAYER badge reads email_undeliverable straight off get_players_overview,
// so it needs no hook here.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { refuseOverlayWrite } from '@/lib/overlayWriteContainment';

// 'provider_suppressed' = on Resend's suppression list (state='ok', no bounce) — still undeliverable. Populated by
// the PR-2 email.suppressed webhook; the reader returns it in place of a bare 'ok'.
export type EmailBounceState = 'hard_bounced' | 'complained' | 'provider_suppressed';

export interface UndeliverableRecipient {
  player_key: string;
  player_type: 'registered' | 'guest';
  profile_id: string | null;
  guest_player_id: string | null;
  full_name: string;
  email: string;
  state: EmailBounceState;
  last_event_at: string | null;
}

export async function fetchAcademyUndeliverableRecipients(
  academyProfileId: string,
): Promise<UndeliverableRecipient[]> {
  const { data, error } = await supabase.rpc('get_academy_undeliverable_recipients', {
    p_academy_profile_id: academyProfileId,
  });
  if (error) throw error;
  return (data ?? []) as UndeliverableRecipient[];
}

/** The academy's players whose resolved email is undeliverable (hard bounce / complaint). */
export function useAcademyUndeliverableRecipients(academyProfileId: string | null | undefined) {
  return useQuery({
    queryKey: ['academy-undeliverable-recipients', academyProfileId],
    queryFn: () => fetchAcademyUndeliverableRecipients(academyProfileId!),
    enabled: !!academyProfileId,
    staleTime: 60 * 1000,
  });
}

export type InvoiceDeliveryStatus = 'bounced' | 'delivered' | 'failed' | 'sent' | null;

/** Per-invoice delivery status + the resolved recipient email (null = none on
 *  file). linkedEmail drives the InvoiceDeliveryChip's "No email" flag without a
 *  client-side profiles read that RLS would block. */
export interface InvoiceDeliveryInfo {
  status: InvoiceDeliveryStatus;
  linkedEmail: string | null;
}

export async function fetchInvoicesDeliveryStatus(
  invoiceIds: string[],
): Promise<Record<string, InvoiceDeliveryInfo>> {
  if (invoiceIds.length === 0) return {};
  const { data, error } = await supabase.rpc('get_invoices_delivery_status', {
    p_invoice_ids: invoiceIds,
  });
  if (error) throw error;
  const map: Record<string, InvoiceDeliveryInfo> = {};
  for (const row of (data ?? []) as { invoice_id: string; delivery_status: InvoiceDeliveryStatus; linked_email: string | null }[]) {
    map[row.invoice_id] = { status: row.delivery_status, linkedEmail: row.linked_email ?? null };
  }
  return map;
}

/** Per-invoice delivery status + recipient email for the visible page of an invoice list. */
export function useInvoicesDeliveryStatus(invoiceIds: string[]) {
  const stableKey = [...invoiceIds].sort().join(',');
  return useQuery({
    queryKey: ['invoices-delivery-status', stableKey],
    queryFn: () => fetchInvoicesDeliveryStatus(invoiceIds),
    enabled: invoiceIds.length > 0,
    staleTime: 60 * 1000,
  });
}

// ===================== remediation (fix-it) =====================
//
// ABC-16 H0 removed both registered-player remediation writers.
//
//   * The `direct` path invoked `academy-update-player-email`, which replaced the player's
//     REAL Auth login email with the service role. Its gate ("this academy owns the player")
//     was satisfied by a caller-authored `academy_player_metadata` row, so an academy could
//     take over a nascent account. `get_player_email_edit_capability` no longer returns
//     'direct', the Edge Function refuses unconditionally, and this client path is gone —
//     all three, because the service role is bound by none of the other two.
//
//   * The billing-email OVERRIDE also wrote `academy_player_metadata`, which H0 made
//     read-only for clients. It is therefore contained too, rather than left to fail at the
//     network boundary with a raw permission error.
//
// A guest has no login, and the guest write below goes to `guest_players`, whose write
// policies are ownership-based (`academy_profile_id` in the caller's academies, or an ACTIVE
// academy trainer owns the row — 20260224171306) and reference no overlay. That path was
// verified independently safe and is deliberately preserved.

/** Academy/trainer edit a guest's contact email directly. Unaffected by ABC-16 H0. */
export async function updateGuestEmail(guestPlayerId: string, email: string): Promise<void> {
  const { error } = await supabase.from('guest_players').update({ email: email.trim().toLowerCase() }).eq('id', guestPlayerId);
  if (error) throw error;
}

/** Invoice-only billing-email override. ABC-16 H0: temporarily has no client writer. */
export async function updateBillingEmailOverride(_opts: {
  academyProfileId: string;
  profileId?: string | null;
  guestPlayerId?: string | null;
  email: string;
}): Promise<never> {
  refuseOverlayWrite('billingEmail');
}
