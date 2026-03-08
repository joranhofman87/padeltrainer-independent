import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { getRatingSystems, type RatingSystemConfig } from '@/lib/ratingSystems';

/**
 * Hook to get the trainer's preferred rating system.
 * Returns the system config and code, plus a loading state.
 * If trainerId is passed, fetches for that trainer; otherwise uses current user.
 */
export function useTrainerRatingSystem(trainerId?: string) {
  const { user } = useAuth();
  const [trainerRatingSystem, setTrainerRatingSystem] = useState<string | null>(null);
  const [systemConfig, setSystemConfig] = useState<RatingSystemConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      setLoading(true);
      try {
        let ratingSystemCode: string | null = null;

        if (trainerId) {
          const { data } = await supabase
            .from('trainer_profiles')
            .select('trainer_rating_system')
            .eq('id', trainerId)
            .maybeSingle();
          ratingSystemCode = data?.trainer_rating_system || null;
        } else if (user) {
          const { data } = await supabase
            .from('trainer_profiles')
            .select('trainer_rating_system')
            .eq('user_id', user.id)
            .maybeSingle();
          ratingSystemCode = data?.trainer_rating_system || null;
        }

        setTrainerRatingSystem(ratingSystemCode);

        if (ratingSystemCode) {
          const systems = await getRatingSystems();
          const config = systems.find(s => s.code === ratingSystemCode) || null;
          setSystemConfig(config);
        }
      } finally {
        setLoading(false);
      }
    }
    fetch();
  }, [user, trainerId]);

  return { trainerRatingSystem, systemConfig, loading };
}
