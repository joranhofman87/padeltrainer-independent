/**
 * Build the bookings for the players auto-enrolled onto a cycle's NEWLY-added sessions when a
 * repeat-count extension grows the cycle (TrainerScheduleOverview cycle edit).
 *
 * Each existing player/guest is carried onto every new slot — but every new session starts CLEAN:
 *   - status 'confirmed' (a future session, never the template's possibly-'attended' past status), and
 *   - payment_status 'pending' — the player OWES for the added weeks. The old code copied the
 *     template's payment_status, so extending a cycle whose players had already PAID minted the new
 *     weeks as 'paid' with no money received (architecture audit 2026-07-11, Batch 2 d — "added weeks
 *     born 'paid'"). payment_amount (the per-session price/split share) is carried so the new session
 *     costs the same; only the paid STATE resets.
 *
 * Pure (no I/O) so the paid-state rule is unit-tested. Dedups the templates by player/guest identity.
 */
export interface ExtensionTemplateBooking {
  player_id: string | null;
  guest_player_id: string | null;
  payment_amount: number | null;
}

export interface ExtensionBookingRow {
  slot_id: string;
  player_id: string | null;
  guest_player_id: string | null;
  status: 'confirmed';
  payment_amount: number | null;
  payment_status: 'pending';
}

export function buildCycleExtensionBookings(
  existingBookings: ExtensionTemplateBooking[],
  newSlotIds: string[],
): ExtensionBookingRow[] {
  // One template per unique player/guest (first booking wins), mirroring the previous playerMap.
  const templateByKey = new Map<string, ExtensionTemplateBooking>();
  for (const b of existingBookings) {
    const key = b.player_id || b.guest_player_id || '';
    if (key && !templateByKey.has(key)) templateByKey.set(key, b);
  }

  const rows: ExtensionBookingRow[] = [];
  for (const template of templateByKey.values()) {
    for (const slotId of newSlotIds) {
      rows.push({
        slot_id: slotId,
        player_id: template.player_id,
        guest_player_id: template.guest_player_id,
        status: 'confirmed',
        payment_amount: template.payment_amount ?? null,
        payment_status: 'pending',
      });
    }
  }
  return rows;
}
