import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

/** Owner scope for roster twin creation. */
export type GuestResolveScope =
  | { kind: 'academy'; academyProfileId: string }
  | { kind: 'trainer'; trainerId: string };

/**
 * Snapshot of a REGISTERED player (a `profiles`-backed person) sourced from the
 * `get_players_overview` RPC — NEVER from a direct `profiles` read (academy managers cannot
 * RLS-read arbitrary profile rows; the overview RPC is SECURITY DEFINER and the sanctioned source).
 *
 * `personId` is the canonical identity the overview row carries; it is what this module answers
 * with, and what the caller uses to re-locate the person on its own list surfaces afterwards.
 */
export type RegisteredPlayerSnapshot = {
  profileId: string;
  personId: string | null;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  skillRating?: number | null;
  ratingSystem?: string | null;
  birthDate?: string | null;
};

/**
 * Phase 0 of person-unification (docs/PERSON_UNIFICATION_PLAN.md), U2-corrected: make sure a
 * registered player has a guest TWIN so the still-guest-keyed roster/booking/invoice chain can seat
 * them — and answer with CANONICAL IDENTITY ONLY (owner correction, 2026-08-09).
 *
 * What this module used to return was the twin's guest id, read straight out of the create
 * command's result, plus a client-side `has_trained` UPDATE keyed on that id. Both are gone:
 *
 *   * the command answers with `person_id` and nothing else — the mint trigger's B1 rule merges a
 *     `roster_registered_twin` onto the profile's person, so the person the command returns IS the
 *     person the caller already had;
 *   * `has_trained` is set server-side by `person_mark_has_trained`, person in, scope authorized,
 *     flag written on whatever in-scope source row carries it;
 *   * the caller re-reads its own picker surface (the overview) and finds the guest side of this
 *     person there — on the same rows every other pick comes from, not from the create contract.
 *
 * Two earlier behaviours are deliberately NOT preserved:
 *
 *   * the twin-exists pre-check (the bridge RPC that answered a guest id for a profile). Since
 *     Phase 3.2 the picker shows a merged person as ONE row carrying both ids, so a person whose
 *     twin exists never reaches this function — their pick already had a guest side. The
 *     stamped-but-never-merged remainder (a `twin_trust_failure` under review) was the ONE case
 *     that pre-check could still find, and seating the profile's person with THAT guest row pairs
 *     a roster entry with a guest that belongs to a DIFFERENT person — exactly the inconsistent
 *     pairing U2 exists to kill. A pair awaiting human review is seated after the human resolves
 *     it, not before.
 *   * the empty-field patch on a found twin, which rode on the same pre-check.
 *
 * A lost mint race (23505 on uniq_guest_twin_per_academy) means the twin exists after all — and by
 * B1 it was merged onto this same person, so the answer is the person the caller already holds.
 *
 * A null return is a HARD failure the roster caller must ABORT on — never silently seat nobody.
 */
export async function ensureRosterTwinForRegisteredPlayer(
  scope: GuestResolveScope,
  snapshot: RegisteredPlayerSnapshot,
): Promise<{ personId: string } | null> {
  // Only the academy flow is wired. A trainer-scope caller used to fall back to resolve-or-create
  // by address and name; there is no such fallback any more, because "we do not support this scope
  // yet" is not a reason to start guessing who somebody is. Callers ABORT on null.
  if (scope.kind !== 'academy') {
    logger.error(
      'ensureRosterTwinForRegisteredPlayer called with an unsupported scope',
      new Error('trainer scope is not wired'),
      { scopeKind: scope.kind },
    );
    return null;
  }
  const academyProfileId = scope.academyProfileId;
  const fullName = snapshot.fullName.trim();
  if (!fullName) return null;

  // Mint the twin through the one create command, so the create is idempotent, authorized in one
  // place, and files a duplicate proposal if this Player looks like one the academy already has.
  // The stamp is honest here: the row is BRAND NEW and carries nothing, so asserting it is this
  // account holder adds no data to their person; the operator picked the profile by id from the
  // academy's own overview.
  const { data: created, error } = await supabase.rpc('player_create_command', {
    _creation_request_id: crypto.randomUUID(),
    _owner_type: 'academy',
    _owner_id: academyProfileId,
    _full_name: fullName,
    _email: (snapshot.email ?? '').trim().toLowerCase() || null,
    _phone: snapshot.phone ?? null,
    _skill_rating: snapshot.skillRating ?? null,
    _rating_system: snapshot.ratingSystem ?? null,
    _birth_date: snapshot.birthDate ?? null,
    _source: 'roster_registered_twin',
    _twin_of_profile_id: snapshot.profileId,
  });

  if (!error) {
    const personId = (created as { person_id: string | null } | null)?.person_id ?? null;
    if (!personId) return null;
    // The flag write is server-side and person-keyed; a failure here must not lose the seat.
    const { error: flagError } = await supabase.rpc('person_mark_has_trained', {
      _person_id: personId,
      _owner_type: 'academy',
      _owner_id: academyProfileId,
    });
    if (flagError) {
      logger.warn('person_mark_has_trained failed (non-blocking)', {
        errorCode: flagError.code,
      });
    }
    return { personId };
  }

  if (error.code === '23505') {
    // Lost a mint race on uniq_guest_twin_per_academy — the winner's twin IS this person's twin
    // (B1 merges a roster twin onto the profile's person), so the person the caller already holds
    // is the answer. The flag write still happens on THIS path (Codex r2 f11): the winner may have
    // died before its own non-blocking flag call, and the retry is the one that promised a seat.
    if (snapshot.personId) {
      const { error: flagError } = await supabase.rpc('person_mark_has_trained', {
        _person_id: snapshot.personId,
        _owner_type: 'academy',
        _owner_id: academyProfileId,
      });
      if (flagError) {
        logger.warn('person_mark_has_trained failed after a lost mint race (non-blocking)', {
          errorCode: flagError.code,
        });
      }
      return { personId: snapshot.personId };
    }
  }
  logger.error(
    'ensureRosterTwinForRegisteredPlayer create failed',
    new Error(error.message),
    { errorCode: error.code },
  );
  return null;
}
