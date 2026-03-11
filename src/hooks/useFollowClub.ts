import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import { logger } from '@/lib/logger';

export function useFollowClub(clubProfileId: string | null) {
  const { user, role, profile } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation('common');
  
  const [isFollowing, setIsFollowing] = useState(false);
  const [followId, setFollowId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const playerProfileId = profile?.id ?? null;

  useEffect(() => {
    if (user && role === 'player' && clubProfileId && playerProfileId) {
      checkFollowStatus();
    } else {
      setLoading(false);
    }
  }, [user, role, clubProfileId, playerProfileId]);

  const checkFollowStatus = async () => {
    try {
      const { data: follow } = await supabase
        .from('club_followers')
        .select('id')
        .eq('player_id', playerProfileId!)
        .eq('club_profile_id', clubProfileId!)
        .maybeSingle();

      setIsFollowing(!!follow);
      setFollowId(follow?.id || null);
    } catch (error) {
      logger.error('Error checking club follow status', error as Error, { hook: 'useFollowClub', clubProfileId });
    } finally {
      setLoading(false);
    }
  };

  const toggleFollow = async () => {
    if (!user || role !== 'player' || !clubProfileId || !playerProfileId) {
      toast({
        title: t('locations.signInRequired', 'Sign in required'),
        description: t('locations.signInToFollowClub', 'Please sign in as a player to follow clubs'),
        variant: 'destructive',
      });
      return;
    }

    try {
      if (isFollowing && followId) {
        const { error } = await supabase
          .from('club_followers')
          .delete()
          .eq('id', followId);

        if (error) throw error;

        setIsFollowing(false);
        setFollowId(null);
        toast({ title: t('locations.unfollowedClub', 'Unfollowed club') });
      } else {
        const { data, error } = await supabase
          .from('club_followers')
          .insert({
            player_id: playerProfileId,
            club_profile_id: clubProfileId,
            notify_new_availability: true,
          })
          .select('id')
          .single();

        if (error) throw error;

        setIsFollowing(true);
        setFollowId(data.id);
        toast({
          title: t('locations.followingClub', 'Following club!'),
          description: t('locations.notifyClubUpdates', "You'll be notified when they add new availability"),
        });
      }
    } catch (error: any) {
      toast({
        title: t('error', 'Error'),
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  return {
    isFollowing,
    loading,
    toggleFollow,
    canFollow: user && role === 'player' && clubProfileId,
  };
}
