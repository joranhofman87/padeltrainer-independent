/**
 * Shared guest-player identity resolution for anonymous public flows (public
 * booking widget, guest intake). Lifted from submit-guest-intake so the guest
 * pay-first booking fn reuses the SAME family rule.
 *
 * Family rule: an email is shared within a family (a parent booking for a child
 * uses the parent's address). The unique index on guest_players.email was
 * dropped for exactly this, so several guests can share one address — only
 * REUSE the row whose NAME matches within the owner scope; a different name is a
 * different person (a sibling) and gets a fresh record instead of overwriting.
 *
 * SECURITY: this NEVER attributes a booking to an existing authenticated profile
 * (player_id). An anonymous caller must not be able to attach a booking to
 * someone else's account merely by knowing their email — that would be
 * impersonation / IDOR. Booking as an existing player requires authentication
 * (create-mollie-payment); the guest path always mints/reuses a guest_players
 * row keyed on (email, name, owner).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

export function normalizeGuestName(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Pure: pick the candidate guest whose name matches the target, else null. */
export function matchGuestByName<T extends { id: string; full_name: string | null }>(
  candidates: T[] | null | undefined,
  fullName: string,
): T | null {
  const target = normalizeGuestName(fullName);
  return (candidates ?? []).find((g) => normalizeGuestName(g.full_name) === target) ?? null;
}

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
};

/**
 * Find-or-create the guest_players row for this (email, name) within the owner
 * scope. Owner is XOR: academy OR trainer OR neither (never both). Returns the
 * guest_player_id to book against.
 */
export async function resolveOrCreateGuestPlayer(
  admin: SupabaseClient,
  params: ResolveGuestParams,
): Promise<{ guestPlayerId: string }> {
  const email = params.email.toLowerCase();
  const academyProfileId = params.owner.academyProfileId ?? null;
  const trainerId = params.owner.trainerId ?? null;

  // Candidates on this address, scoped to the owner (family rule).
  let query = admin.from("guest_players").select("id, full_name").eq("email", email);
  if (academyProfileId) query = query.eq("academy_profile_id", academyProfileId);
  else if (trainerId) query = query.eq("trainer_id", trainerId);
  else query = query.is("academy_profile_id", null).is("trainer_id", null);

  const { data: candidates } = await query;
  const existing = matchGuestByName(
    candidates as { id: string; full_name: string | null }[] | null,
    params.name.full_name,
  );

  if (existing) {
    await admin
      .from("guest_players")
      .update({
        first_name: params.name.first_name,
        last_name: params.name.last_name,
        full_name: params.name.full_name,
        // Only OVERWRITE contact fields the caller actually supplied — a booking
        // that omits phone must not null out a phone captured on an earlier one.
        ...(params.phone ? { phone: params.phone } : {}),
        ...(params.skillRating != null ? { skill_rating: params.skillRating } : {}),
        ...(params.ratingSystem ? { rating_system: params.ratingSystem } : {}),
      })
      .eq("id", existing.id);
    return { guestPlayerId: existing.id };
  }

  const insertRow: Record<string, unknown> = {
    first_name: params.name.first_name,
    last_name: params.name.last_name,
    full_name: params.name.full_name,
    email,
    phone: params.phone ?? null,
    skill_rating: params.skillRating ?? null,
    rating_system: params.ratingSystem ?? "knltb",
    source: params.source ?? "public_booking",
  };
  if (academyProfileId) insertRow.academy_profile_id = academyProfileId;
  else if (trainerId) insertRow.trainer_id = trainerId;

  const { data: created, error } = await admin
    .from("guest_players")
    .insert(insertRow)
    .select("id")
    .single();

  if (error || !created) {
    // PII hygiene: log code only (Postgres error details can embed the email).
    throw new Error(`guest_player_insert_failed:${error?.code ?? "unknown"}`);
  }
  return { guestPlayerId: created.id as string };
}
