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
   * (audit #1). The registered-player twin path sets this, and so does invoice recipient resolution
   * since U2: an invoice attached to a household member on the strength of an address is the same
   * email-alone identity decision the database no longer makes (owner, 2026-08-09).
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
  const legacyArgs: ResolveOrCreateGuestPlayerArgs = {
    scope,
    fullName: snapshot.fullName,
    email,
    phone: snapshot.phone ?? null,
    skillRating: snapshot.skillRating ?? null,
    ratingSystem: snapshot.ratingSystem ?? null,
    birthDate: snapshot.birthDate ?? null,
    source: 'roster_registered_twin',
    hasTrained: true,
    patchExistingEmptyFields: true,
    requireNameMatch: true,
  };

  // Phase 0 only wires the academy flow; any future trainer-scope caller gets the legacy behavior.
  if (scope.kind !== 'academy') return resolveOrCreateGuestPlayer(legacyArgs);
  const academyProfileId = scope.academyProfileId;
  const fullName = snapshot.fullName.trim();
  if (!fullName) return null;

  // (1) Explicit twin — deterministic, race-free, email-independent.
  const twinLookup = await findGuestTwinByProfileId(academyProfileId, snapshot.profileId);
  if (!twinLookup.ok) {
    // Bridge RPCs not deployed yet → pre-bridge behavior (modulo the global name-gating
    // hardenings in the shared helpers, which only ever narrow reuse — never widen it).
    return resolveOrCreateGuestPlayer(legacyArgs);
  }
  if (twinLookup.id) {
    await patchExistingGuestEmptyFields(twinLookup.id, legacyArgs);
    return twinLookup.id;
  }

  // (2) Claim the person's pre-existing guest row (email + EXACT name, ambiguity ⇒ no candidate).
  if (email) {
    const candidateId = await findExistingGuestPlayerIdByEmail(email, scope, fullName, true);
    if (candidateId) {
      const { data: claimedBy, error: claimError } = await supabase.rpc(
        'claim_guest_twin_for_academy' as never,
        {
          _academy_profile_id: academyProfileId,
          _guest_player_id: candidateId,
          _profile_id: snapshot.profileId,
        } as never,
      );
      if (claimError) {
        // Claim RPC unavailable (same migration as the lookup, so effectively unreachable) —
        // degrade to the pre-bridge behavior: reuse the name-matched candidate unstamped.
        await patchExistingGuestEmptyFields(candidateId, legacyArgs);
        return candidateId;
      }
      if ((claimedBy as string | null) === snapshot.profileId) {
        await patchExistingGuestEmptyFields(candidateId, legacyArgs);
        return candidateId;
      }
      // Claimed by ANOTHER profile (someone else's twin — never reuse it), or NULL (unique
      // conflict: OUR twin exists elsewhere / row went out of scope). Re-read and converge.
      const retry = await findGuestTwinByProfileId(academyProfileId, snapshot.profileId);
      if (retry.ok && retry.id) {
        await patchExistingGuestEmptyFields(retry.id, legacyArgs);
        return retry.id;
      }
      // Fall through: mint a fresh twin for THIS person.
    }
  }

  // (3) Mint a fresh twin stamped with the profile id.
  const insertPayload: TablesInsert<'guest_players'> = {
    ...buildGuestInsertPayload(legacyArgs, fullName, email ?? ''),
    twin_of_profile_id: snapshot.profileId,
  };
  const { data, error } = await supabase
    .from('guest_players')
    .insert(insertPayload)
    .select('id')
    .single();
  if (!error) return data?.id ?? null;

  if (error.code === '23505') {
    // Lost a mint race on uniq_guest_twin_per_academy — reuse the winner's twin.
    const winner = await findGuestTwinByProfileId(academyProfileId, snapshot.profileId);
    if (winner.ok && winner.id) return winner.id;
    // Some OTHER unique index: name-gated email recovery (never a blind reuse).
    if (email) return findExistingGuestPlayerIdByEmail(email, scope, fullName, true);
  }
  logger.error(
    'resolveOrCreateGuestTwinForRegisteredPlayer insert failed',
    new Error(error.message),
    { errorCode: error.code },
  );
  return null;
}
