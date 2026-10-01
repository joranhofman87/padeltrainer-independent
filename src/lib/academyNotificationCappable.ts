/**
 * N3: the CAPPABLE set — optional events with a LIVE academy-attributed v2 producer, per
 * docs/NOTIFICATION_ATTRIBUTION_MATRIX.md (drift-pinned by its test). Offering a control for a
 * trainer-only or legacy-path event would be a switch wired to nothing; keep this list and the
 * matrix in the same change, always.
 */
export const CAPPABLE_EVENTS: ReadonlyArray<{
  event: string;
  channels: ReadonlyArray<'email' | 'whatsapp'>;
}> = [
  { event: 'booking_request_staff', channels: ['email'] },
  { event: 'booking_confirmed_staff', channels: ['email'] },
  // whatsapp deliberately absent: 20260923100000 set supports_whatsapp=false for this
  // event (no committed template) — a cap row for it would be refused by M2's trigger.
  { event: 'booking_cancelled_player', channels: ['email'] },
  { event: 'rebook_member_open_player', channels: ['email'] },
];
