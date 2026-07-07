import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { getTrainerAcademy } from '@/lib/academy';
import { useAuth } from '@/hooks/useAuth';

/**
 * Whether the signed-in trainer belongs to an academy. Academy-employed trainers
 * get a reduced /app/trainer/* surface (TrainerLayout's RESTRICTED_PATHS_FOR_ACADEMY,
 * the slim sidebar, and the Sessions hub hide what the academy manages for them).
 *
 * Shares one cache entry across TrainerLayout / TrainerSessions via the query key.
 */
export function useTrainerHasAcademy() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['trainer-has-academy', user?.id],
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
}
