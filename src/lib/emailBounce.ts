// Email delivery-failure (bounce) surfacing — read hooks over the Phase 3 RPCs.
//   useAcademyUndeliverableRecipients -> dashboard alert count + BouncingEmailsCard
//   useInvoicesDeliveryStatus         -> per-row bounce indicator on the invoice list
// The per-PLAYER badge reads email_undeliverable straight off get_players_overview,
// so it needs no hook here.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';

export type EmailEditCapability = 'direct' | 'override';

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

/** Whether the academy may edit a registered player's REAL email ('direct') or
 *  must use a billing-email override ('override'). Guests are edited directly. */
export function usePlayerEmailEditCapability(profileId: string | null | undefined, academyProfileId: string | null | undefined) {
  return useQuery({
    queryKey: ['player-email-edit-capability', profileId, academyProfileId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_player_email_edit_capability', {
        _profile_id: profileId!,
        _academy_profile_id: academyProfileId!,
      });
      if (error) throw error;
      return (data ?? 'override') as EmailEditCapability;
    },
    enabled: !!profileId && !!academyProfileId,
    staleTime: 60 * 1000,
  });
}

/** Gated edit of a registered player's real login email (only when capability='direct'). */
export async function updatePlayerEmailDirect(profileId: string, academyProfileId: string, email: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('academy-update-player-email', {
    body: { profile_id: profileId, academy_profile_id: academyProfileId, email },
  });
  if (error) throw error;
  if (data && (data as { error?: string }).error) throw new Error((data as { error: string }).error);
}

/** Academy/trainer edit a guest's contact email directly. */
export async function updateGuestEmail(guestPlayerId: string, email: string): Promise<void> {
  const { error } = await supabase.from('guest_players').update({ email: email.trim().toLowerCase() }).eq('id', guestPlayerId);
  if (error) throw error;
}

/** Set an invoice-only billing-email override on the academy's player-metadata row. */
export async function updateBillingEmailOverride(opts: {
  academyProfileId: string;
  profileId?: string | null;
  guestPlayerId?: string | null;
  email: string;
}): Promise<void> {
  let q = supabase
    .from('academy_player_metadata')
    .update({ billing_email: opts.email.trim().toLowerCase() })
    .eq('academy_profile_id', opts.academyProfileId)
    .is('removed_at', null);
  q = opts.guestPlayerId ? q.eq('guest_player_id', opts.guestPlayerId) : q.eq('profile_id', opts.profileId!);
  const { error } = await q;
  if (error) throw error;
}
