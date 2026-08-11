import { supabase } from '@/lib/supabaseClient';
import { buildGuestPlayerDbFields, splitFullName } from '@/lib/profileName';
import { normalize } from '@/lib/playerSearch';
import { logger } from '@/lib/logger';
import type { TablesInsert, TablesUpdate } from '@/integrations/supabase/types';

/** Owner scope for guest_players dedup/creation. */
export type GuestResolveScope =
  | { kind: 'academy'; academyProfileId: string }
  | { kind: 'trainer'; trainerId: string };

/**
 * Pick the guest to reuse from the email matches. Shared emails are allowed
 * (families share one address), so multiple matches are ambiguous unless the
 * full name singles one out — ambiguity yields null and the caller creates a
 * NEW player (e.g. kid B gets their own record next to kid A).
 */
function pickGuestIdByName(
  rows: Array<{ id: string; full_name: string | null }>,
  fullName?: string | null,
  /**
   * When true, even a SINGLE email match must also match the name before it is reused. Household
   * emails are shared (a parent registered-account and a child guest can carry the same address),
   * so a lone match is NOT proof of same-person — reusing it blindly seats/invoices the WRONG human
   * (audit #1). The registered-player twin path sets this; name-less invoice dedup keeps the shortcut.
   */
  requireNameMatch = false,
): string | null {
  if (rows.length === 0) return null;
  const wanted = (fullName ?? '').trim();
  if (rows.length === 1) {
    if (requireNameMatch && wanted) {
      return normalize(rows[0].full_name ?? '') === normalize(wanted) ? rows[0].id : null;
    }
    return rows[0].id;
  }
  if (wanted) {
    // EXACTLY one name match, or nothing (audit H3): with several same-email SAME-NAME rows there
    // is no signal that distinguishes them — picking the first is a guess, and a wrong guess books/
    // patches a different person's record. Ambiguity yields null → the caller creates a new player.
    const matches = rows.filter((row) => normalize(row.full_name ?? '') === normalize(wanted));
    if (matches.length === 1) return matches[0].id;
  }
  return null;
}

/**
 * Find an existing guest_players row by email within an owner scope.
 *
 * Trainer scope: exact (trainer_id, email) match.
 * Academy scope: matches guests owned by the academy itself OR by any of the
 * academy's active trainers, so academy flows reuse trainer-created guests.
 *
 * Multiple guests may share an email (family members); when more than one
 * matches, the optional fullName disambiguates (diacritic/case-insensitive).
 * Without a unique pick this returns null so callers create a new player.
 */
/**
 * Escape a literal string for a case-insensitive EXACT `ilike` match: emails legitimately contain
 * `_` (and could contain `%`), which `ilike` would treat as wildcards — escaping them (backslash is
 * the default LIKE escape) makes `ilike` an exact, case-folded compare. Every other email path in
 * the system folds case (the link trigger, intake backfill, invoice matching); guest_players.email
 * is NOT lowercased on write, so a case-sensitive `.eq` misses a mixed-case legacy row → duplicate
 * identity (audit #2/#8).
 */
function ilikeExact(s: string): string {
  return s.replace(/([\\%_])/g, '\\$1');
}

export async function findExistingGuestPlayerIdByEmail(
  email: string,
  scope: GuestResolveScope,
  fullName?: string | null,
  requireNameMatch = false,
): Promise<string | null> {
  const trimmed = email.trim();
  if (!trimmed) return null;

  if (scope.kind === 'trainer') {
    const { data } = await supabase
      .from('guest_players')
      .select('id, full_name')
      .eq('trainer_id', scope.trainerId)
      .ilike('email', ilikeExact(trimmed))
      .order('created_at')
      .limit(10);
    return pickGuestIdByName(data ?? [], fullName, requireNameMatch);
  }

  const { data: academyTrainers } = await supabase
    .from('academy_trainers')
    .select('trainer_profile_id')
    .eq('academy_profile_id', scope.academyProfileId)
    .eq('status', 'active');

  const trainerIds = (academyTrainers || [])
    .map((t) => t.trainer_profile_id)
    .filter((id): id is string => Boolean(id));

  // Dedup must see trainer-owned guests (a trainer may have created this person
  // before the academy did). The academy guest_players SELECT policy is scoped to
  // guests already RELATED to the academy (P2-2), so a direct SELECT can no longer
  // see a not-yet-related trainer-owned guest — that would create a DUPLICATE
  // identity. Route the lookup through a SECURITY DEFINER RPC that still returns the
  // candidate ids. Falls back to the narrowed direct query if the RPC is not yet
  // deployed (graceful vs un-migrated prod).
  const { data: rpcRows, error: rpcError } = await supabase.rpc(
    'find_guest_players_by_email_for_academy' as never,
    {
      _email: trimmed,
      _academy_profile_id: scope.academyProfileId,
      _trainer_ids: trainerIds,
    } as never,
  );
  if (!rpcError) {
    return pickGuestIdByName(
      (rpcRows as Array<{ id: string; full_name: string | null }> | null) ?? [],
      fullName,
      requireNameMatch,
    );
  }

  const { data } = await supabase
    .from('guest_players')
    .select('id, full_name')
    .ilike('email', ilikeExact(trimmed))
    .eq('academy_profile_id', scope.academyProfileId)
    .order('created_at')
    .limit(10);
  return pickGuestIdByName(data ?? [], fullName, requireNameMatch);
}

export type ResolveOrCreateGuestPlayerArgs = {
  scope: GuestResolveScope;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  skillRating?: number | null;
  ratingSystem?: string | null;
  birthDate?: string | null;
  source?: string | null;
  hasTrained?: boolean;
  /** When reusing an existing row, fill optional fields that are still null/empty. */
  patchExistingEmptyFields?: boolean;
  /**
   * Require the name to match even on a SINGLE email hit before reusing it (audit #1). Set by the
   * registered-player twin path, where a lone household-email match may be a DIFFERENT family member.
   */
  requireNameMatch?: boolean;
};

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** Fill phone/rating/birth_date on an existing guest, only where empty. */
async function patchExistingGuestEmptyFields(
  guestPlayerId: string,
  args: ResolveOrCreateGuestPlayerArgs,
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
 * Resolve-or-create a guest player within a trainer/academy scope.
 *
 * Select-by-email-then-insert — NEVER upsert. NOTE: the guest_players partial unique EMAIL indexes
 * were DROPPED in migration 20260611220000 (families legitimately share an address), so there is no
 * DB uniqueness backstop on email anymore — dedup relies entirely on the case-insensitive select
 * below. The 23505 recovery branch is now defensive-only (a race on some OTHER unique index, e.g. the
 * M-17 active-booking indexes aren't on this table); it can no longer fire on an email collision.
 *
 * Emailless guests are allowed: no email means no dedup, plain insert.
 * Returns the guest_players id, or null when there is nothing to create or
 * the write failed (callers treat this as non-blocking).
 */
/** Build the guest_players insert payload from resolve args (shared by the generic + twin paths). */
function buildGuestInsertPayload(
  args: ResolveOrCreateGuestPlayerArgs,
  fullName: string,
  email: string,
): TablesInsert<'guest_players'> {
  const { first_name, last_name } = splitFullName(fullName);
  const nameFields = buildGuestPlayerDbFields(first_name, last_name);
  const ownerFields =
    args.scope.kind === 'academy'
      ? { academy_profile_id: args.scope.academyProfileId }
      : { trainer_id: args.scope.trainerId };

  const insertPayload: TablesInsert<'guest_players'> = { ...nameFields, ...ownerFields };
  if (email) insertPayload.email = email;
  if (args.phone) insertPayload.phone = args.phone;
  if (args.skillRating != null) insertPayload.skill_rating = args.skillRating;
  if (args.ratingSystem) insertPayload.rating_system = args.ratingSystem;
  if (args.birthDate) insertPayload.birth_date = args.birthDate;
  if (args.source) insertPayload.source = args.source;
  if (args.hasTrained !== undefined) insertPayload.has_trained = args.hasTrained;
  return insertPayload;
}

export async function resolveOrCreateGuestPlayer(
  args: ResolveOrCreateGuestPlayerArgs,
): Promise<string | null> {
  const { scope } = args;
  const fullName = args.fullName.trim();
  if (!fullName) return null;
  const email = (args.email ?? '').trim();

  if (email) {
    const existingId = await findExistingGuestPlayerIdByEmail(
      email,
      scope,
      args.fullName,
      args.requireNameMatch,
    );
    if (existingId) {
      if (args.patchExistingEmptyFields) {
        await patchExistingGuestEmptyFields(existingId, args);
      }
      return existingId;
    }
  }

  const { data, error } = await supabase
    .from('guest_players')
    .insert(buildGuestInsertPayload(args, fullName, email))
    .select('id')
    .single();

  if (error) {
    // Unique violation: a concurrent writer created the same email — reuse it. The recovery
    // re-select carries the SAME name gate as the primary lookup (audit fix-verify): without it, a
    // requireNameMatch caller racing on a shared household email would reuse the WRONG family
    // member's row here.
    if (error.code === '23505' && email) {
      const racedId = await findExistingGuestPlayerIdByEmail(
        email,
        scope,
        args.fullName,
        args.requireNameMatch,
      );
      if (racedId) return racedId;
    }
    logger.error(
      'resolveOrCreateGuestPlayer insert failed',
      new Error(error.message),
      { scopeKind: scope.kind, errorCode: error.code },
    );
    return null;
  }

  return data?.id ?? null;
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
  _snapshot: RegisteredPlayerSnapshot,
): Promise<string | null> {
  // No legacy args are built: the 'roster_registered_twin' source is itself part of the retired
  // bridge, and constructing the payload would invite a future edit to "just" pass it on.
  //
  // ABC-18 — the find → claim → mint twin bridge is RETIRED.
  //
  // Every step asserted "this guest row IS that registered person" on evidence the caller
  // supplied: `find_guest_twin_for_academy` matched a mutable email plus a name, the claim RPC
  // stamped `twin_of_profile_id` from that match, and the mint wrote the stamp directly.
  // Downstream that stamp was read as identity — profile visibility, invoices, rebooking,
  // recipient routing.
  //
  // Both RPCs are revoked and the column is frozen, so the old path could only fail. What it
  // did on failure was the real hazard: the claim-error branch reused the untrusted candidate
  // anyway, and the mint retried by writing the stamp. A permission error must never become
  // "reuse someone else's row".
  //
  // This now resolves the GUEST-ONLY, unverified path: a plain guest row for the scope, with no
  // assertion about which account it belongs to.
  //
  // It does NOT fall back to the email+name guest resolver either. That would hand a registered
  // person a guest SURROGATE on exactly the mutable-PII match this containment rejects, and the
  // surrogate would then flow into cycle booking and invoicing as if it were that account.
  // Admitting a registered player needs canonical membership or an attestation, and neither
  // exists yet — so this fails closed and the caller surfaces it.
  logger.warn(
    'ABC-18: registered-player admission is unavailable until canonical membership exists',
    { scopeKind: scope.kind },
  );
  return null;
}
