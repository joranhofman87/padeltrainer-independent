import { supabase } from '@/lib/supabaseClient';
import { buildGuestPlayerDbFields, splitFullName } from '@/lib/profileName';
import { logger } from '@/lib/logger';
import type { TablesInsert, TablesUpdate } from '@/integrations/supabase/types';

/** Owner scope for guest_players dedup/creation. */
export type GuestResolveScope =
  | { kind: 'academy'; academyProfileId: string }
  | { kind: 'trainer'; trainerId: string };

/**
 * Find an existing guest_players row by email within an owner scope.
 *
 * Trainer scope: exact (trainer_id, email) match.
 * Academy scope: matches guests owned by the academy itself OR by any of the
 * academy's active trainers, so academy flows reuse trainer-created guests.
 */
export async function findExistingGuestPlayerIdByEmail(
  email: string,
  scope: GuestResolveScope,
): Promise<string | null> {
  const trimmed = email.trim();
  if (!trimmed) return null;

  if (scope.kind === 'trainer') {
    const { data } = await supabase
      .from('guest_players')
      .select('id')
      .eq('trainer_id', scope.trainerId)
      .eq('email', trimmed)
      .limit(1)
      .maybeSingle();
    return data?.id ?? null;
  }

  const { data: academyTrainers } = await supabase
    .from('academy_trainers')
    .select('trainer_profile_id')
    .eq('academy_profile_id', scope.academyProfileId)
    .eq('status', 'active');

  const trainerIds = (academyTrainers || []).map((t) => t.trainer_profile_id).filter(Boolean);

  let query = supabase.from('guest_players').select('id').eq('email', trimmed);
  if (trainerIds.length > 0) {
    query = query.or(
      `academy_profile_id.eq.${scope.academyProfileId},trainer_id.in.(${trainerIds.join(',')})`,
    );
  } else {
    query = query.eq('academy_profile_id', scope.academyProfileId);
  }

  const { data } = await query.limit(1).maybeSingle();
  return data?.id ?? null;
}

export type ResolveOrCreateGuestPlayerArgs = {
  scope: GuestResolveScope;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  skillRating?: number | null;
  ratingSystem?: string | null;
  birthDate?: string | null;
  linkedProfileId?: string | null;
  source?: string | null;
  hasTrained?: boolean;
  /** When reusing an existing row, fill optional fields that are still null/empty. */
  patchExistingEmptyFields?: boolean;
};

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** Fill phone/rating/birth_date/linked_profile_id on an existing guest, only where empty. */
async function patchExistingGuestEmptyFields(
  guestPlayerId: string,
  args: ResolveOrCreateGuestPlayerArgs,
): Promise<void> {
  const { data: row } = await supabase
    .from('guest_players')
    .select('phone, skill_rating, rating_system, birth_date, linked_profile_id')
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
  if (args.linkedProfileId && isEmptyValue(row.linked_profile_id)) {
    patch.linked_profile_id = args.linkedProfileId;
  }
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
    const existingId = await findExistingGuestPlayerIdByEmail(email, scope);
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
  if (args.linkedProfileId) insertPayload.linked_profile_id = args.linkedProfileId;
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
