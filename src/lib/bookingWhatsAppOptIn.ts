/**
 * The booking WhatsApp opt-in sequence, extracted from BookLesson so the ORDER is testable.
 *
 * BookLesson.tsx is a large page component with no test harness, and the ordering here is
 * exactly what went wrong once: the profile write happened BEFORE the RPC validated the number,
 * so an unnormalizable phone could land on the account while the opt-in itself correctly failed
 * closed. That is the one path where the two can disagree, and it is worth pinning rather than
 * re-reading.
 *
 * Two rules the sequence encodes:
 *   1. The RPC decides. It returns a contact id, or NULL when it refuses to normalize what was
 *      typed — so a non-null result is the validation signal for everything downstream.
 *   2. The profile is written only when the player TYPED a number (the profile had none), which
 *      is the case where the checkbox copy says so. Ticking a messaging box is not by itself
 *      consent to store data on the account.
 *
 * NEVER THROWS. It runs on the booking path; a consent write must not be able to break a booking.
 */

export type BookingOptInOutcome =
  /** Nothing to do: unticked, no slot, or no number. */
  | 'skipped'
  /** Consent recorded; nothing written to the profile (it already had a number). */
  | 'recorded'
  /** Consent recorded AND the typed number saved to the profile. */
  | 'recorded_and_saved'
  /** The RPC refused the number — fails closed, so nothing else happens either. */
  | 'rejected'
  /** Something errored; already reported through onError. */
  | 'failed';

export interface BookingOptInInput {
  optIn: boolean;
  /** The slot the tenant will be derived from, SERVER-side. */
  slotId: string | undefined;
  /** The number to consent for: the profile's, or the one just typed. */
  phone: string;
  /** True when the profile already had a number, so nothing should be written to it. */
  hasProfilePhone: boolean;
}

export interface BookingOptInDeps {
  // PromiseLike, not Promise: Supabase's query builders are thenables, not real Promises, so a
  // Promise return type rejects them for want of .catch/.finally.
  /** Calls record_whatsapp_optin_for_slot. Resolves to the RPC's own shape. */
  recordOptIn: (slotId: string, phone: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  /** Persists the typed number on the player's profile. */
  savePhoneToProfile: (phone: string) => PromiseLike<{ error: { message: string } | null }>;
  onError: (error: unknown) => void;
}

export async function recordBookingWhatsAppOptIn(
  input: BookingOptInInput,
  deps: BookingOptInDeps,
): Promise<BookingOptInOutcome> {
  const phone = (input.phone ?? '').trim();
  if (!input.optIn || !input.slotId || !phone) return 'skipped';

  try {
    const { data, error } = await deps.recordOptIn(input.slotId, phone);
    if (error) throw new Error(error.message);

    // NULL => the RPC would not guess at an unnormalizable number. Nothing further happens,
    // and in particular the profile is NOT written: a number too malformed to message is too
    // malformed to store.
    if (!data) return 'rejected';

    if (input.hasProfilePhone) return 'recorded';

    const { error: profileError } = await deps.savePhoneToProfile(phone);
    if (profileError) throw new Error(profileError.message);
    return 'recorded_and_saved';
  } catch (error) {
    deps.onError(error);
    return 'failed';
  }
}
