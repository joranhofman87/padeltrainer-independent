import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

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
      console.error('Error fetching followed trainer IDs:', error);
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
