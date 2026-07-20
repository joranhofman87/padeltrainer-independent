import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import type { Database } from '@/integrations/supabase/types';

/**
 * Client for the PR-7a tenant-safe notification timeline RPCs. All three return the SAME
 * projection, so one row type covers them: safe row ids + event/channel/status/skip_reason +
 * the REDACTED destination + the sanitized public_summary + timestamps. The raw address,
 * contact_id and recipient ids never leave the database (see migration 20260917100000).
 */
export type NotificationTimelineEntry =
  Database['public']['Functions']['get_booking_notification_timeline']['Returns'][number];

/** The RPC is missing (client deployed ahead of the migration) → render nothing, never throw. */
function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST202';
}

async function callTimeline(
  fn: 'get_booking_notification_timeline' | 'get_invoice_notification_timeline' | 'get_player_notification_timeline',
  args: Record<string, unknown>,
): Promise<NotificationTimelineEntry[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.rpc as any)(fn, args);
  if (error) {
    if (isMissingFunction(error)) return [];
    throw error;
  }
  return (data ?? []) as NotificationTimelineEntry[];
}

export function useBookingNotificationTimeline(bookingId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['notification-timeline', 'booking', bookingId ?? null] as const,
    queryFn: () => callTimeline('get_booking_notification_timeline', { p_booking_id: bookingId }),
    enabled: enabled && Boolean(bookingId),
    staleTime: 30 * 1000,
  });
}

export function useInvoiceNotificationTimeline(invoiceId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['notification-timeline', 'invoice', invoiceId ?? null] as const,
    queryFn: () => callTimeline('get_invoice_notification_timeline', { p_invoice_id: invoiceId }),
    enabled: enabled && Boolean(invoiceId),
    staleTime: 30 * 1000,
  });
}

/** Staff view of ONE player, authorized + ref-expanded server-side by get_person_refs_for_scope. */
export function usePlayerNotificationTimeline(
  args: { scope: 'academy' | 'trainer'; scopeId: string; guestId?: string | null; profileId?: string | null } | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ['notification-timeline', 'player', args?.scope ?? null, args?.scopeId ?? null, args?.guestId ?? null, args?.profileId ?? null] as const,
    queryFn: () =>
      callTimeline('get_player_notification_timeline', {
        p_scope: args!.scope,
        p_scope_id: args!.scopeId,
        p_guest_id: args?.guestId ?? undefined,
        p_profile_id: args?.profileId ?? undefined,
      }),
    enabled: enabled && Boolean(args?.scopeId) && Boolean(args?.guestId || args?.profileId),
    staleTime: 30 * 1000,
  });
}

/** The signed-in player's OWN history (p_scope omitted → self mode). */
export function useMyNotificationTimeline(enabled = true) {
  return useQuery({
    queryKey: ['notification-timeline', 'self'] as const,
    queryFn: () => callTimeline('get_player_notification_timeline', {}),
    enabled,
    staleTime: 30 * 1000,
  });
}

const EVENT_LABELS: Record<string, string> = {
  booking_confirmed_player: 'Booking confirmed',
  booking_confirmed_staff: 'New booking',
  booking_cancelled_player: 'Booking cancelled',
  booking_cancelled_staff: 'Booking cancelled',
  payment_receipt_player: 'Payment receipt',
  payment_received_staff: 'Payment received',
  invoice_created_player: 'Invoice sent',
  invoice_paid_player: 'Invoice paid',
  invoice_paid_staff: 'Invoice paid',
  invoice_reminder_player: 'Invoice reminder',
  review_received_trainer: 'Review received',
  session_reminder_player: 'Session reminder',
  rebook_invite_player: 'Rebooking invite',
  rebook_paid_player: 'Rebooking paid',
  rebook_paid_staff: 'Rebooking paid',
};

/** Human label for an event key, falling back to the de-underscored key. */
export function notificationEventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType.replace(/_/g, ' ');
}

/** The most meaningful timestamp for an entry: when it actually happened, else when queued. */
export function notificationEntryTimestamp(e: NotificationTimelineEntry): string {
  return e.occurred_at ?? e.sent_at ?? e.failed_at ?? e.created_at;
}
