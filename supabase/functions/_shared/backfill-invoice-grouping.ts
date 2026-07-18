// Grouping for the admin invoice-backfill. Kept here (not inline in the function)
// so the doctrine-sensitive subject resolution is unit-testable.

export interface BackfillBooking {
  player_id: string | null;
  guest_player_id: string | null;
}

/**
 * The invoice SUBJECT of a booking, GUEST-FIRST per FAM-02: a dual-keyed booking
 * (player_id + guest_player_id both set — a parent account booking for a child
 * guest) belongs to the GUEST person, so it must bill the guest, not the parent
 * profile. Choosing profile-first would batch several different children under
 * one parent subject and mint a single invoice spanning distinct people.
 */
export function invoiceSubjectId(b: BackfillBooking): string {
  return b.guest_player_id ?? b.player_id ?? 'unknown';
}

/** Batch key = (cyclus, subject): each subject's bookings in a cycle → ONE invoice. */
export function backfillGroupKey(cyclusId: string | null | undefined, b: BackfillBooking): string {
  return `${cyclusId || 'no-cycle'}__${invoiceSubjectId(b)}`;
}
