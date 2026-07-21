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

  let data: unknown = null;
  let error: { message: string } | null = null;
  try {
    const res = await supabase.rpc('enqueue_booking_notification', {
      p_booking_ids: ids,
      p_kind: kind,
    });
    data = res.data;
    error = res.error;
  } catch (thrown) {
    // NO-THROW CONTRACT. A network drop or a client-level exception must not escape into the
    // caller, because by this point the BOOKING (or the cancellation) has already succeeded —
    // letting it propagate would report "booking failed" for what is only a lost email.
    logger.error(
      'Booking notification enqueue THREW',
      thrown instanceof Error ? thrown : new Error(String(thrown)),
      { component: context, action: kind, bookingCount: ids.length },
    );
    return { ok: false, enqueued: 0, error: String(thrown) };
  }

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

  // Zero rows on a SUCCESSFUL call is an ordinary outcome, not a fault: an idempotent retry
  // emits nothing, and an optional event the recipient has turned off emits nothing. Warning
  // on all of them would train everyone to ignore the warning, and the genuinely odd case
  // (an orphan trainer with no account) would be lost in it. If that case needs alerting it
  // belongs in the RPC as an explicit error or a structured reason — not inferred out here
  // from a count that cannot tell the three apart.
  const enqueued = typeof data === 'number' ? data : 0;
  return { ok: true, enqueued };
}

/**
 * Group booking rows by RECIPIENT (guest first, then registered player), returning the ids
 * each recipient is owed a notification about.
 *
 * Extracted so the grouping is testable at RUNTIME rather than pinned by a source regex —
 * the previous source-level assertion silently matched nothing in the one file it was
 * supposed to be checking, which is a worse failure than no test.
 */
export function groupBookingIdsByRecipient(
  rows: Array<{ id?: string | null; player_id?: string | null; guest_player_id?: string | null }> | null | undefined,
): string[][] {
  const byRecipient = new Map<string, string[]>();
  for (const row of rows ?? []) {
    const bookingId = row?.id;
    if (!bookingId) continue;
    // NAMESPACED: guest_player_id and player_id are keys into DIFFERENT tables, so an
    // un-prefixed map could merge two unrelated people if the values ever coincided.
    // Guest wins when a row carries both — that row is a staff-booked guest, and keying it
    // on the player id would address the wrong person.
    const recipient = row?.guest_player_id
      ? `guest:${row.guest_player_id}`
      : row?.player_id ? `player:${row.player_id}` : null;
    if (!recipient) continue;
    byRecipient.set(recipient, [...(byRecipient.get(recipient) ?? []), bookingId]);
  }
  return [...byRecipient.values()];
}

/**
 * Enqueue one `confirmation_player` per recipient for a just-inserted set of bookings.
 * `confirmation_player` accepts exactly ONE recipient per call, so the grouping is not a
 * convenience — it is what keeps each call valid.
 */
export async function enqueueConfirmationsPerRecipient(
  rows: Array<{ id?: string | null; player_id?: string | null; guest_player_id?: string | null }> | null | undefined,
  context: string,
): Promise<EnqueueResult[]> {
  const groups = groupBookingIdsByRecipient(rows);
  return Promise.all(groups.map((ids) => enqueueBookingNotification(ids, 'confirmation_player', context)));
}

