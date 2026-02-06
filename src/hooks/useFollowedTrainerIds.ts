import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { logger } from '@/lib/logger';

export function useFollowedTrainerIds() {
  const { user, role, profile } = useAuth();
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [followCount, setFollowCount] = useState(0);

  useEffect(() => {
    if (user && role === 'player' && profile?.id) {
      fetchFollowedIds();
    } else {
      setFollowedIds(new Set());
      setFollowCount(0);
      setLoading(false);
    }
  }, [user, role, profile?.id]);

  const fetchFollowedIds = async () => {
    if (!profile?.id) return;

    try {
      const { data, count } = await supabase
        .from('trainer_followers')
        .select('trainer_id', { count: 'exact' })
        .eq('player_id', profile.id);

      if (data) {
        setFollowedIds(new Set(data.map(f => f.trainer_id)));
        setFollowCount(count || data.length);
      }
    } catch (error) {
      logger.error('Error fetching followed trainer IDs', error as Error, { hook: 'useFollowedTrainerIds', profileId: profile?.id });
    } finally {
      setLoading(false);
    }
  };

  const refetch = () => {
    setLoading(true);
    fetchFollowedIds();
  };

  return {
    followedIds,
    followCount,
    loading,
    isFollowing: (trainerId: string) => followedIds.has(trainerId),
    refetch,
  };
}
