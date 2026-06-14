import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { getTrainerAcademy } from '@/lib/academy';

/**
 * Single source of truth for "is the current trainer affiliated with an academy"
 * (an ACTIVE academy_trainers membership — getTrainerAcademy already filters
 * status='active'). Academy trainers skip onboarding and have every financial /
 * business surface hidden, because the academy manages those things for them.
 *
 * Consumed by TrainerLayout (onboarding skip + route guards), TrainerSidebar (nav),
 * and the in-page financial hides (slot detail, player detail, profile, add-slot).
 * One stable query key keeps every surface consistent — no half-locked state where
 * the nav is hidden but the page is still reachable, or vice-versa.
 *
 * `isResolved` is false only while the (enabled) query is still in flight, so callers
 * can block render until affiliation is known and avoid a flash of financial content
 * or a wrongful bounce into onboarding on first load.
 */
export function useIsAcademyTrainer(): { isAcademyTrainer: boolean; isResolved: boolean } {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['is-academy-trainer', user?.id],
    queryFn: async () => {
      if (!user) return false;
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!trainerProfile) return false;
      const academy = await getTrainerAcademy(trainerProfile.id);
      return !!academy;
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  return {
    isAcademyTrainer: query.data ?? false,
    isResolved: !user || query.isFetched,
  };
}
