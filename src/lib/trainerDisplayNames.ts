import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { logger } from '@/lib/logger';

const DEFAULT_TRAINER_LABEL = 'Trainer';

/**
 * Resolve trainer display names without PostgREST embeds from trainer_profiles → profiles.
 * Production schema has no FK between trainer_profiles.user_id and profiles for embedding.
 */
export async function fetchTrainerDisplayNamesByProfileIds(
  trainerProfileIds: string[],
  client: SupabaseClient<Database>,
  logContext = 'trainerDisplayNames',
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = [...new Set(trainerProfileIds.filter((id): id is string => !!id?.trim()))];
  if (ids.length === 0) return map;

  const { data: trainerProfiles, error: tpError } = await client
    .from('trainer_profiles')
    .select('id, user_id, business_name')
    .in('id', ids);

  if (tpError) {
    logger.error('Failed to load trainer profiles for display names', new Error(tpError.message), {
      component: logContext,
      code: tpError.code,
      details: tpError.details,
      hint: tpError.hint,
    });
    return map;
  }

  const rows = trainerProfiles || [];
  const userIdsNeedingProfile = rows
    .filter((tp) => !tp.business_name?.trim())
    .map((tp) => tp.user_id)
    .filter((id): id is string => !!id);

  const nameByUserId = new Map<string, string>();

  if (userIdsNeedingProfile.length > 0) {
    const { data: publicProfiles, error: publicError } = await client
      .from('profiles_public')
      .select('user_id, full_name')
      .in('user_id', userIdsNeedingProfile);

    if (publicError) {
      logger.error('Failed to load profiles_public for trainer names', new Error(publicError.message), {
        component: logContext,
        code: publicError.code,
        details: publicError.details,
      });
    } else {
      (publicProfiles || []).forEach((p) => {
        const name = p.full_name?.trim();
        if (name) nameByUserId.set(p.user_id, name);
      });
    }

    const stillMissing = userIdsNeedingProfile.filter((uid) => !nameByUserId.has(uid));
    if (stillMissing.length > 0) {
      const { data: profiles, error: profileError } = await client
        .from('profiles')
        .select('user_id, full_name')
        .in('user_id', stillMissing);

      if (profileError) {
        logger.error('Failed to load profiles for trainer names', new Error(profileError.message), {
          component: logContext,
          code: profileError.code,
          details: profileError.details,
        });
      } else {
        (profiles || []).forEach((p) => {
          const name = p.full_name?.trim();
          if (name && !nameByUserId.has(p.user_id)) {
            nameByUserId.set(p.user_id, name);
          }
        });
      }
    }
  }

  rows.forEach((tp) => {
    map.set(
      tp.id,
      tp.business_name?.trim() || nameByUserId.get(tp.user_id) || DEFAULT_TRAINER_LABEL,
    );
  });

  return map;
}
