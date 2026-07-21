import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';

/**
 * The v2 replacement for the legacy `send-email` booking notifications.
 *
 * The client passes BOOKING IDS AND AN INTENT — nothing else. Recipients, addresses, tenant
 * scope and copy are all derived server-side by `enqueue_booking_notification`, which also
 * validates that the caller is entitled to notify about every booking in the set. A
 * client-supplied recipient address deciding where mail goes is the shape this replaces.
 *
 * RESIDUAL RELIABILITY LIMITATION (deliberate, documented, not fixed here):
 * the booking mutation and this enqueue are SEPARATE round trips from the browser, so they
 * are not atomic. A crash, a closed tab or a network drop between them leaves a booking with
 * no notification. That is why this is called only AFTER the mutation succeeds, with the ids
 * the mutation actually returned — the failure mode is a MISSING notification, never a
 * notification for a booking that does not exist. Closing the gap properly needs either a
 * transactional outbox on the mutation itself or a reconciliation sweep; both are out of
 * scope for this migration and are recorded in the architecture notes.
 */
export type BookingNotificationKind =
  /** Player asked for a booking that needs approval → the trainer hears about it. */
  | 'request_staff'
  /** A booking confirmed WITHOUT online payment → the player (or guest) hears about it. */
  | 'confirmation_player'
  /** Staff cancelled bookings → each affected player/guest hears about it. */
  | 'cancelled_player';

export type EnqueueResult = { ok: boolean; enqueued: number; error?: string };

/**
 * Enqueue one booking notification. Returns rather than throws, because the BOOKING is the
 * authoritative outcome and must not be reported as failed just because its email did not
 * queue — but the failure is never silent: it is logged at error level and surfaced in the
 * result, so a caller cannot mistake it for a send.
 */
export async function enqueueBookingNotification(
  bookingIds: string[],
  kind: BookingNotificationKind,
  context: string,
): Promise<EnqueueResult> {
  const ids = [...new Set(bookingIds.filter(Boolean))];
  if (ids.length === 0) {
    logger.warn('Booking notification skipped — no booking ids', { component: context, action: kind });
    return { ok: false, enqueued: 0, error: 'no_booking_ids' };
  }

  const { data, error } = await supabase.rpc('enqueue_booking_notification', {
    p_booking_ids: ids,
    p_kind: kind,
  });

  if (error) {
    // Loud on purpose. The old path swallowed send failures, which is how a notification gap
    // survives unnoticed until someone complains they never got an email.
    // PostgrestError already extends Error, so no narrowing dance is needed here.
    logger.error(
      'Booking notification enqueue FAILED',
      error as unknown as Error,
      { component: context, action: kind, bookingCount: ids.length },
    );
    return { ok: false, enqueued: 0, error: error.message };
  }

  const enqueued = typeof data === 'number' ? data : 0;
  if (enqueued === 0) {
    // The RPC answered successfully with zero rows — e.g. an orphan trainer with no account.
    // Legitimate, but worth seeing rather than assuming a send happened.
    logger.warn('Booking notification enqueued nothing', { component: context, action: kind });
  }
  return { ok: true, enqueued };
}
