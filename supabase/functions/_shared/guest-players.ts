/**
 * PLAYER identity for the anonymous public payment flows (the booking widget's single-slot, cart
 * and cyclus checkouts).
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
 * Create (or replay) the Player to book against. Returns the CANONICAL person_id and nothing else.
 *
 * Throws on refusal — the callers treat having a Player as a hard precondition for taking money,
 * and a booking against a Player that was never created is worse than a failed checkout.
 */
export async function resolvePlayerForCheckout(
  admin: SupabaseClient,
  params: ResolveGuestParams,
): Promise<{ personId: string }> {
  const academyProfileId = params.owner.academyProfileId ?? null;
  const trainerId = params.owner.trainerId ?? null;

  // `guest_players` requires a trainer or an academy (`guest_players_owner_check`), so a scopeless
  // booking has never been storable. Refused here rather than at the constraint.
  if (!academyProfileId && !trainerId) {
    throw new Error("player_create_failed:no_owner_scope");
  }
  if (!params.creationRequestId) {
    throw new Error("player_create_failed:missing_creation_request_id");
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
    throw new Error(`player_create_failed:${error.code ?? "unknown"}`);
  }
  const result = data as { person_id: string | null } | null;
  if (!result?.person_id) {
    throw new Error("player_create_failed:no_person");
  }
  // ONE id, and it is canonical. This used to return a guest row id and throw when there was none,
  // which made a legacy compatibility reference a precondition of taking a payment — a Player whose
  // guest source had been claimed into an account was a checkout that could not happen.
  return { personId: result.person_id };
}

/**
 * The legacy column a booking row still physically needs, derived from the canonical person by the
 * SERVICE-ONLY adapter (`player_legacy_ref` is granted to service_role alone and refuses any other
 * caller — owner correction, 2026-08-09). This module runs inside a service-key edge function, the
 * one place such a derivation is permitted, and the derived id must die in this process: it goes
 * into the `bookings` insert and NEVER into an HTTP response, a log line or any client-visible
 * state. Callers pass a person and a scope; they never choose a legacy id.
 *
 * Returns BOTH shapes because `bookings` carries both: an account holder is written as `player_id`
 * and everyone else as `guest_player_id`, and after a claim or merge the same person may have both
 * — in which case the registered path is the compatible one and the adapter says so.
 */
export async function legacyBookingRef(
  admin: SupabaseClient,
  personId: string,
  owner: GuestOwner,
): Promise<{ playerId: string | null; guestPlayerId: string | null }> {
  const academyProfileId = owner.academyProfileId ?? null;
  const trainerId = owner.trainerId ?? null;
  const { data, error } = await admin.rpc("player_legacy_ref", {
    _person_id: personId,
    _owner_type: academyProfileId ? "academy" : "trainer",
    _owner_id: academyProfileId ?? trainerId,
  });
  if (error) throw new Error(`legacy_ref_failed:${error.code ?? "unknown"}`);
  const ref = data as { player_id: string | null; guest_player_id: string | null } | null;
  return { playerId: ref?.player_id ?? null, guestPlayerId: ref?.guest_player_id ?? null };
}

/**
 * The one legacy column an anonymous checkout must write, or a loud failure.
 *
 * `bookings.guest_player_id` is NOT NULL-able in practice for this path, so a missing source is a
 * broken invariant rather than a case to handle: a self-signup checkout creates a brand-new Player,
 * which by construction has a guest source in this scope and no account. If a PROFILE source turns
 * up, this path is the wrong one — an account holder books through the authenticated flow, and
 * silently writing them in as a guest is how a booking becomes invisible in their own app.
 */
export async function legacyGuestRefForCheckout(
  admin: SupabaseClient,
  personId: string,
  owner: GuestOwner,
): Promise<string> {
  const { playerId, guestPlayerId } = await legacyBookingRef(admin, personId, owner);
  if (playerId) throw new Error("legacy_ref_failed:registered_player_path_required");
  if (!guestPlayerId) throw new Error("legacy_ref_failed:no_guest_source");
  return guestPlayerId;
}
