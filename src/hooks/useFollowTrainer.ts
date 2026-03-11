import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import { logger } from '@/lib/logger';

export function useFollowTrainer(trainerProfileId: string | null) {
  const { user, role, profile } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation('player');
  
  const [isFollowing, setIsFollowing] = useState(false);
  const [followId, setFollowId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const playerProfileId = profile?.id ?? null;

  useEffect(() => {
    if (user && role === 'player' && trainerProfileId && playerProfileId) {
      checkFollowStatus();
    } else {
      setLoading(false);
    }
  }, [user, role, trainerProfileId, playerProfileId]);

  const checkFollowStatus = async () => {
    try {
      const { data: follow } = await supabase
        .from('trainer_followers')
        .select('id')
        .eq('player_id', playerProfileId!)
        .eq('trainer_id', trainerProfileId!)
        .maybeSingle();

      setIsFollowing(!!follow);
      setFollowId(follow?.id || null);
    } catch (error) {
      logger.error('Error checking follow status', error as Error, { hook: 'useFollowTrainer', trainerProfileId });
    } finally {
      setLoading(false);
    }
  };

  const toggleFollow = async () => {
    if (!user || role !== 'player' || !trainerProfileId || !playerProfileId) {
      toast({
        title: t('followingList.signInRequired', 'Sign in required'),
        description: t('followingList.signInToFollow', 'Please sign in as a player to follow trainers'),
        variant: 'destructive',
      });
      return;
    }

    try {
      if (isFollowing && followId) {
        const { error } = await supabase
          .from('trainer_followers')
          .delete()
          .eq('id', followId);

        if (error) throw error;

        setIsFollowing(false);
        setFollowId(null);
        toast({ title: t('followingList.unfollowed', 'Unfollowed trainer') });
      } else {
        const { data, error } = await supabase
          .from('trainer_followers')
          .insert({
            player_id: playerProfileId,
            trainer_id: trainerProfileId,
            notify_new_availability: true,
          })
          .select('id')
          .single();

        if (error) throw error;

        setIsFollowing(true);
        setFollowId(data.id);
        toast({
          title: t('followingList.followingTrainer', 'Following trainer!'),
          description: t('followingList.notifyAvailability', "You'll be notified when they add new availability"),
        });
      }
    } catch (error: any) {
      toast({
        title: t('common:error', 'Error'),
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  return {
    isFollowing,
    loading,
    toggleFollow,
    canFollow: user && role === 'player' && trainerProfileId,
  };
}
