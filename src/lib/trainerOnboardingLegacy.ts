import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

export type TrainerOnboardingLegacyRow = {
  completed_at: string | null;
  current_step: number;
};

export type PostgrestErrorLike = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

export function isPostgrestError(value: unknown): value is PostgrestErrorLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('code' in value || 'message' in value || 'details' in value || 'hint' in value)
  );
}

/** Log Supabase/PostgREST errors with code, message, details, hint (not shown in UI). */
export function logSupabaseError(
  message: string,
  error: unknown,
  context: Record<string, unknown>,
): void {
  const fields = getPostgrestErrorFields(error);
  const err =
    error instanceof Error
      ? error
      : new Error(fields.message ?? message);
  logger.error(message, err, {
    ...context,
    supabaseCode: fields.code,
    supabaseMessage: fields.message,
    supabaseDetails: fields.details,
    supabaseHint: fields.hint,
  });
}

export function getPostgrestErrorFields(error: unknown): PostgrestErrorLike {
  if (isPostgrestError(error)) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: typeof error === 'string' ? error : undefined };
}

/** True for unique violation on trainer_onboarding.user_id (HTTP 409 / code 23505). */
export function isTrainerOnboardingDuplicateError(error: unknown): boolean {
  const { code } = getPostgrestErrorFields(error);
  return code === '23505';
}

/**
 * Ensure a legacy trainer_onboarding row exists for the user.
 * Safe under concurrent init (signup + double mount): insert once, on conflict re-fetch.
 */
export async function ensureTrainerOnboardingRow(
  userId: string,
): Promise<{ created: boolean; row: TrainerOnboardingLegacyRow }> {
  const { data: existing, error: selectError } = await supabase
    .from('trainer_onboarding')
    .select('completed_at, current_step')
    .eq('user_id', userId)
    .maybeSingle();

  if (selectError) {
    logSupabaseError('trainer_onboarding select failed', selectError, { userId });
    throw selectError;
  }

  if (existing) {
    return { created: false, row: existing };
  }

  const { error: insertError } = await supabase.from('trainer_onboarding').insert({
    user_id: userId,
    current_step: 1,
  });

  if (!insertError) {
    const row = await fetchTrainerOnboardingRow(userId);
    return { created: true, row };
  }

  if (isTrainerOnboardingDuplicateError(insertError)) {
    logSupabaseError('trainer_onboarding insert duplicate (continuing)', insertError, {
      userId,
    });
    const row = await fetchTrainerOnboardingRow(userId);
    return { created: false, row };
  }

  logSupabaseError('trainer_onboarding insert failed', insertError, { userId });
  throw insertError;
}

async function fetchTrainerOnboardingRow(
  userId: string,
): Promise<TrainerOnboardingLegacyRow> {
  const { data, error } = await supabase
    .from('trainer_onboarding')
    .select('completed_at, current_step')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logSupabaseError('trainer_onboarding refetch failed', error, { userId });
    throw error;
  }

  if (!data) {
    const err = new Error('trainer_onboarding row missing after ensure');
    logSupabaseError('trainer_onboarding row missing after ensure', err, { userId });
    throw err;
  }

  return data;
}
