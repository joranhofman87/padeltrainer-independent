import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import type { TablesUpdate } from '@/integrations/supabase/types';

/** Owner scope for guest_players dedup/creation. */
export type GuestResolveScope =
  | { kind: 'academy'; academyProfileId: string }
  | { kind: 'trainer'; trainerId: string };

/**
 * The optional facts a registered player's snapshot can contribute to a twin that already exists.
 *
 * What this type USED to describe was a resolve-or-create: an email lookup, a name gate, a reuse
 * decision and an insert. All of it is gone (U2, owner 2026-08-09) — Players are created by
 * `player_create_command` and are never selected from attributes — and with it went the last
 * client-side implementation of "who is this person, judging by their address".
 */
export type GuestFieldPatch = {
  phone?: string | null;
  skillRating?: number | null;
  ratingSystem?: string | null;
  birthDate?: string | null;
};

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** Fill phone/rating/birth_date on an existing guest, only where empty. */
async function patchExistingGuestEmptyFields(
  guestPlayerId: string,
  args: GuestFieldPatch,
): Promise<void> {
  const { data: row } = await supabase
    .from('guest_players')
    .select('phone, skill_rating, rating_system, birth_date')
    .eq('id', guestPlayerId)
    .maybeSingle();
  if (!row) return;

  const patch: TablesUpdate<'guest_players'> = {};
  if (args.phone && isEmptyValue(row.phone)) patch.phone = args.phone;
  if (args.skillRating != null && isEmptyValue(row.skill_rating)) {
    patch.skill_rating = args.skillRating;
  }
  if (args.ratingSystem && isEmptyValue(row.rating_system)) {
    patch.rating_system = args.ratingSystem;
  }
  if (args.birthDate && isEmptyValue(row.birth_date)) patch.birth_date = args.birthDate;
  if (Object.keys(patch).length === 0) return;

  await supabase.from('guest_players').update(patch).eq('id', guestPlayerId);
}

/**
 * Snapshot of a REGISTERED player (a `profiles`-backed person) sourced from the
 * `get_players_overview` RPC — NEVER from a direct `profiles` read (academy managers cannot
 * RLS-read arbitrary profile rows; the overview RPC is SECURITY DEFINER and the sanctioned source).
 */
export type RegisteredPlayerSnapshot = {
  profileId: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  skillRating?: number | null;
  ratingSystem?: string | null;
  birthDate?: string | null;
};

/**
 * Look up the profile's EXPLICIT twin (guest_players.twin_of_profile_id) within the academy's
 * dedup scope, via the SECURITY DEFINER RPC (the scope may include trainer-owned rows the manager
 * cannot SELECT directly). `ok:false` means the bridge RPCs are not deployed (new client against a
 * not-yet-pushed DB) — callers fall back to the legacy email+name flow.
 */
async function findGuestTwinByProfileId(
  academyProfileId: string,
  profileId: string,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  const { data, error } = await supabase.rpc('find_guest_twin_for_academy' as never, {
    _academy_profile_id: academyProfileId,
    _profile_id: profileId,
  } as never);
  if (error) return { ok: false };
  return { ok: true, id: (data as string | null) ?? null };
}

/**
 * Phase 0 of person-unification (docs/PERSON_UNIFICATION_PLAN.md): resolve-or-create the GUEST TWIN
 * for a registered player so the guest-keyed roster/booking/invoice chain can seat them without
 * touching any money math. Bridges the two identity worlds at the UI seam until the full `persons`
 * table lands.
 *
 * Phase 0c (external-audit hardening) made the bridge EXPLICIT — `twin_of_profile_id`:
 *   1. resolve by profile id first (deterministic; no name heuristics on repeat adds; works for
 *      emailless people — they now get ONE twin total, not one per add);
 *   2. else claim the person's pre-existing guest row (email + exact-name match) by compare-and-set
 *      inside a SECURITY DEFINER RPC — a row that is already someone ELSE's twin is never reused;
 *   3. else mint a fresh twin STAMPED with the profile id — the partial unique index
 *      (academy_profile_id, twin_of_profile_id) turns concurrent double-mints into a 23505 the
 *      loser recovers from by re-reading the winner (audit H2: no duplicate seats/invoices).
 *
 * The email merge key stays `lower(trim(email))` and a lone household-email match is only reused on
 * an exact name match (audit #1 — never seat the wrong human). Deliberately does NOT touch
 * `linked_profile_id`: that column is email-inferred by the `link_guest_data_to_profile` trigger
 * and must never drive identity decisions.
 *
 * Unlike the invoice-side {@link resolveOrCreateGuestPlayer} (which returns null as a non-blocking
 * skip), a null here is a HARD failure the roster caller must ABORT on — never silently seat nobody.
 * Scope MUST be `academy` for Phase 0: the academy-owner INSERT branch is the one whose RETURNING
 * passes the own-column SELECT policy (a trainer_id-owned insert by a manager can pass WITH CHECK
 * yet fail RETURNING).
 */
export async function resolveOrCreateGuestTwinForRegisteredPlayer(
  scope: GuestResolveScope,
  snapshot: RegisteredPlayerSnapshot,
): Promise<string | null> {
  const email = (snapshot.email ?? '').trim().toLowerCase() || null;
  const fieldPatch: GuestFieldPatch = {
    phone: snapshot.phone ?? null,
    skillRating: snapshot.skillRating ?? null,
    ratingSystem: snapshot.ratingSystem ?? null,
    birthDate: snapshot.birthDate ?? null,
  };

  // Only the academy flow is wired. A trainer-scope caller used to fall back to resolve-or-create
  // by address and name; there is no such fallback any more, because "we do not support this scope
  // yet" is not a reason to start guessing who somebody is. Callers ABORT on null.
  if (scope.kind !== 'academy') {
    logger.error(
      'resolveOrCreateGuestTwinForRegisteredPlayer called with an unsupported scope',
      new Error('trainer scope is not wired'),
      { scopeKind: scope.kind },
    );
    return null;
  }
  const academyProfileId = scope.academyProfileId;
  const fullName = snapshot.fullName.trim();
  if (!fullName) return null;

  // (1) Explicit twin — deterministic, race-free, email-independent.
  const twinLookup = await findGuestTwinByProfileId(academyProfileId, snapshot.profileId);
  if (!twinLookup.ok) {
    // The bridge RPC is unreachable. That used to degrade to matching on the address; it now fails,
    // because a lookup that cannot answer is not permission to guess. The caller aborts rather than
    // seating the wrong human.
    logger.error(
      'resolveOrCreateGuestTwinForRegisteredPlayer could not read the twin bridge',
      new Error('find_guest_twin_for_academy unavailable'),
      { academyProfileId },
    );
    return null;
  }
  if (twinLookup.id) {
    await patchExistingGuestEmptyFields(twinLookup.id, fieldPatch);
    return twinLookup.id;
  }

  // (2) REMOVED (U2, owner 2026-08-09). What stood here claimed the person's pre-existing guest row
  // by email plus an exact name match, and STAMPED it with `twin_of_profile_id`. That stamp is not
  // an inert label: `mint_person_for_guest` treats it as the explicit operator assertion that
  // authorizes joining the guest's person to the profile's (rule B1, which slice 1 deliberately
  // kept). So this path took an attribute match and laundered it into an authorized merge — the
  // exact decision the database stopped making, reintroduced one layer above it, with no human
  // anywhere in the loop: the roster UI supplies a profile id and nothing else.
  //
  // A registered player who also has a guest record on the same address now gets their own twin,
  // and the two are proposed for a claim rather than joined. That is the same cost the rest of U2
  // pays for not guessing, and it is paid in the same currency: a proposal a person can act on.

  // (3) Mint a fresh twin stamped with the profile id — through the one create command, so the
  // create is idempotent, authorized in one place, and files a duplicate proposal if this Player
  // looks like one the academy already has. The stamp is honest here in a way it was not above:
  // the row is BRAND NEW and carries nothing, so asserting it is this account holder adds no data
  // to their person; the operator picked the profile by id from the academy's own overview.
  const { data: created, error } = await supabase.rpc('player_create_command', {
    _creation_request_id: crypto.randomUUID(),
    _owner_type: 'academy',
    _owner_id: academyProfileId,
    _full_name: fullName,
    _email: email,
    _phone: snapshot.phone ?? null,
    _skill_rating: snapshot.skillRating ?? null,
    _rating_system: snapshot.ratingSystem ?? null,
    _birth_date: snapshot.birthDate ?? null,
    _source: 'roster_registered_twin',
    _twin_of_profile_id: snapshot.profileId,
  });
  if (!error) {
    const guestPlayerId = (created as { guest_player_id: string | null } | null)?.guest_player_id ?? null;
    if (guestPlayerId) {
      await supabase.from('guest_players').update({ has_trained: true }).eq('id', guestPlayerId);
    }
    return guestPlayerId;
  }

  if (error.code === '23505') {
    // Lost a mint race on uniq_guest_twin_per_academy — the winner's twin IS this person's twin,
    // found by profile id and not by any attribute.
    const winner = await findGuestTwinByProfileId(academyProfileId, snapshot.profileId);
    if (winner.ok && winner.id) return winner.id;
  }
  logger.error(
    'resolveOrCreateGuestTwinForRegisteredPlayer create failed',
    new Error(error.message),
    { errorCode: error.code },
  );
  return null;
}
