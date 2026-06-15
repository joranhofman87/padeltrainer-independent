// Email delivery-failure (bounce) surfacing — read hooks over the Phase 3 RPCs.
//   useAcademyUndeliverableRecipients -> dashboard alert count + BouncingEmailsCard
//   useInvoicesDeliveryStatus         -> per-row bounce indicator on the invoice list
// The per-PLAYER badge reads email_undeliverable straight off get_players_overview,
// so it needs no hook here.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';

export type EmailBounceState = 'hard_bounced' | 'complained';

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

export async function fetchInvoicesDeliveryStatus(
  invoiceIds: string[],
): Promise<Record<string, InvoiceDeliveryStatus>> {
  if (invoiceIds.length === 0) return {};
  const { data, error } = await supabase.rpc('get_invoices_delivery_status', {
    p_invoice_ids: invoiceIds,
  });
  if (error) throw error;
  const map: Record<string, InvoiceDeliveryStatus> = {};
  for (const row of (data ?? []) as { invoice_id: string; delivery_status: InvoiceDeliveryStatus }[]) {
    map[row.invoice_id] = row.delivery_status;
  }
  return map;
}

/** Per-invoice delivery status for the visible page of an invoice list. */
export function useInvoicesDeliveryStatus(invoiceIds: string[]) {
  const stableKey = [...invoiceIds].sort().join(',');
  return useQuery({
    queryKey: ['invoices-delivery-status', stableKey],
    queryFn: () => fetchInvoicesDeliveryStatus(invoiceIds),
    enabled: invoiceIds.length > 0,
    staleTime: 60 * 1000,
  });
}
