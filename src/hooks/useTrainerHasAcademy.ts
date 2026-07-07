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

/**
 * Whether the signed-in trainer may EDIT their sessions/slots/cycles/bookings/
 * players. Academy-employed trainers are VIEW-ONLY — the academy manages the
 * schedule, roster, cycles and money on their behalf; the trainer only views,
 * marks attendance, and writes coaching notes. Independent trainers keep full
 * editing.
 *
 * Fails CLOSED while membership is loading (`canEdit === false`) so an academy
 * trainer never flashes an editing control on a cold cache; an independent
 * trainer's controls appear a beat after the (cached, shared) query resolves.
 */
export function useTrainerCanEdit(): { canEdit: boolean; isLoading: boolean } {
  const { data: hasAcademy = false, isLoading } = useTrainerHasAcademy();
  return { canEdit: !isLoading && !hasAcademy, isLoading };
}
