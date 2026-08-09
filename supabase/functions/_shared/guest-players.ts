/**
 * Guest-player identity for the anonymous public payment flows (the booking widget's single-slot,
 * cart and cyclus checkouts).
 *
 * WHAT THIS USED TO DO, and why it no longer does. It looked the typed address up in
 * `guest_players`, took the row whose NAME matched within the owner scope, OVERWROTE that row's
 * name and contact details with whatever had just been typed, and booked against it. That is an
 * identity selected from two mutable attributes by an unauthenticated stranger — the decision U2
 * removed everywhere else (owner, 2026-08-09). The family rule made it narrower than an
 * email-alone match; it did not make it a decision anybody had authorized.
 *
 * WHAT IT DOES NOW. It creates a Player through the one server-side command, idempotently on the
 * caller's `creationRequestId`. A booker who retries — a double tap, a network replay, a Mollie
 * redirect that comes back — carries the same id and gets the same Player. A booker who returns
 * next month is a new Player, and the command files a `possible_duplicate_player` proposal for a
 * human to judge rather than quietly writing over the previous one's details.
 *
 * SECURITY, unchanged: this NEVER attributes a booking to an existing authenticated profile
 * (`player_id`). An anonymous caller must not be able to attach a booking to someone else's account
 * merely by knowing their email — that would be impersonation. Booking as an existing player
 * requires authentication (create-mollie-payment).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

export type GuestOwner = { academyProfileId?: string | null; trainerId?: string | null };

export type GuestNameFields = {
  first_name: string | null;
  last_name: string | null;
  full_name: string;
};

export type ResolveGuestParams = {
  email: string;
  name: GuestNameFields;
  phone?: string | null;
  skillRating?: number | null;
  ratingSystem?: string | null;
  owner: GuestOwner;
  source?: string;
  /**
   * The booker's own id for THIS checkout attempt. Required: without it a retry is a different
   * attempt and makes a second Player, and no attribute of the person may be used to notice that.
   */
  creationRequestId: string;
};

/**
 * Create (or replay) the guest_players row to book against. Returns the guest_player_id.
 *
 * Throws on refusal — the callers treat guest identity as a hard precondition for taking money,
 * and a booking against a Player that was never created is worse than a failed checkout.
 */
export async function resolveOrCreateGuestPlayer(
  admin: SupabaseClient,
  params: ResolveGuestParams,
): Promise<{ guestPlayerId: string; personId: string }> {
  const academyProfileId = params.owner.academyProfileId ?? null;
  const trainerId = params.owner.trainerId ?? null;

  // `guest_players` requires a trainer or an academy (`guest_players_owner_check`), so a scopeless
  // booking has never been storable. Refused here rather than at the constraint.
  if (!academyProfileId && !trainerId) {
    throw new Error("guest_player_create_failed:no_owner_scope");
  }
  if (!params.creationRequestId) {
    throw new Error("guest_player_create_failed:missing_creation_request_id");
  }

  const { data, error } = await admin.rpc("player_create_command", {
    _creation_request_id: params.creationRequestId,
    _owner_type: academyProfileId ? "academy" : "trainer",
    _owner_id: academyProfileId ?? trainerId,
    _full_name: params.name.full_name,
    _email: params.email.toLowerCase(),
    _phone: params.phone ?? null,
    _first_name: params.name.first_name,
    _last_name: params.name.last_name,
    _skill_rating: params.skillRating ?? null,
    _rating_system: params.ratingSystem ?? null,
    _source: params.source ?? "public_booking",
    // The booker is the only party present; this endpoint's own gates (slot validity, throttles,
    // CORS allow-list) stand in for an operator, exactly as they do for the registration form.
    _origin: "self_signup",
  });

  if (error) {
    // PII hygiene: log/throw the code only — Postgres error details can embed the email.
    throw new Error(`guest_player_create_failed:${error.code ?? "unknown"}`);
  }
  const result = data as { guest_player_id: string | null; person_id: string } | null;
  if (!result?.guest_player_id) {
    throw new Error("guest_player_create_failed:no_player");
  }
  return { guestPlayerId: result.guest_player_id, personId: result.person_id };
}
