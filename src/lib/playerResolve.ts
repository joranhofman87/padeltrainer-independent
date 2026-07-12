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
): string | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0].id;
  const wanted = (fullName ?? '').trim();
  if (wanted) {
    const match = rows.find((row) => normalize(row.full_name ?? '') === normalize(wanted));
    if (match) return match.id;
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
export async function findExistingGuestPlayerIdByEmail(
  email: string,
  scope: GuestResolveScope,
  fullName?: string | null,
): Promise<string | null> {
  const trimmed = email.trim();
  if (!trimmed) return null;

  if (scope.kind === 'trainer') {
    const { data } = await supabase
      .from('guest_players')
      .select('id, full_name')
      .eq('trainer_id', scope.trainerId)
      .eq('email', trimmed)
      .order('created_at')
      .limit(10);
    return pickGuestIdByName(data ?? [], fullName);
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
    );
  }

  const { data } = await supabase
    .from('guest_players')
    .select('id, full_name')
    .eq('email', trimmed)
    .eq('academy_profile_id', scope.academyProfileId)
    .order('created_at')
    .limit(10);
  return pickGuestIdByName(data ?? [], fullName);
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
 * Select-by-email-then-insert — NEVER upsert: the guest_players unique email
 * indexes are PARTIAL (WHERE email <> '' ..., migration 20260224171306) and
 * PostgREST upserts cannot target partial indexes (Postgres 42P10). On an
 * insert unique-violation (23505, a concurrent writer won the race) the email
 * is re-selected and that id returned.
 *
 * Emailless guests are allowed: no email means no dedup, plain insert.
 * Returns the guest_players id, or null when there is nothing to create or
 * the write failed (callers treat this as non-blocking).
 */
export async function resolveOrCreateGuestPlayer(
  args: ResolveOrCreateGuestPlayerArgs,
): Promise<string | null> {
  const { scope } = args;
  const fullName = args.fullName.trim();
  if (!fullName) return null;
  const email = (args.email ?? '').trim();

  if (email) {
    const existingId = await findExistingGuestPlayerIdByEmail(email, scope, args.fullName);
    if (existingId) {
      if (args.patchExistingEmptyFields) {
        await patchExistingGuestEmptyFields(existingId, args);
      }
      return existingId;
    }
  }

  const { first_name, last_name } = splitFullName(fullName);
  const nameFields = buildGuestPlayerDbFields(first_name, last_name);
  const ownerFields =
    scope.kind === 'academy'
      ? { academy_profile_id: scope.academyProfileId }
      : { trainer_id: scope.trainerId };

  const insertPayload: TablesInsert<'guest_players'> = { ...nameFields, ...ownerFields };
  if (email) insertPayload.email = email;
  if (args.phone) insertPayload.phone = args.phone;
  if (args.skillRating != null) insertPayload.skill_rating = args.skillRating;
  if (args.ratingSystem) insertPayload.rating_system = args.ratingSystem;
  if (args.birthDate) insertPayload.birth_date = args.birthDate;
  if (args.source) insertPayload.source = args.source;
  if (args.hasTrained !== undefined) insertPayload.has_trained = args.hasTrained;

  const { data, error } = await supabase
    .from('guest_players')
    .insert(insertPayload)
    .select('id')
    .single();

  if (error) {
    // Unique violation: a concurrent writer created the same email — reuse it.
    if (error.code === '23505' && email) {
      const racedId = await findExistingGuestPlayerIdByEmail(email, scope);
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
