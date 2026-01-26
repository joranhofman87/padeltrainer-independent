import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';

export function useFollowClub(clubProfileId: string | null) {
  const { user, role } = useAuth();
  const { toast } = useToast();
  
  const [isFollowing, setIsFollowing] = useState(false);
  const [followId, setFollowId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playerProfileId, setPlayerProfileId] = useState<string | null>(null);

  useEffect(() => {
    if (user && role === 'player' && clubProfileId) {
      checkFollowStatus();
    } else {
      setLoading(false);
    }
  }, [user, role, clubProfileId]);

  const checkFollowStatus = async () => {
    try {
      // Get player's profile ID
      const { data: playerProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('user_id', user!.id)
        .single();

      if (!playerProfile) {
        setLoading(false);
        return;
      }

      setPlayerProfileId(playerProfile.id);

      // Check if following
      const { data: follow } = await supabase
        .from('club_followers')
        .select('id')
        .eq('player_id', playerProfile.id)
        .eq('club_profile_id', clubProfileId)
        .maybeSingle();

      setIsFollowing(!!follow);
      setFollowId(follow?.id || null);
    } catch (error) {
      console.error('Error checking club follow status:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleFollow = async () => {
    if (!user || role !== 'player' || !clubProfileId || !playerProfileId) {
      toast({
        title: 'Sign in required',
        description: 'Please sign in as a player to follow clubs',
        variant: 'destructive',
      });
      return;
    }

    try {
      if (isFollowing && followId) {
        // Unfollow
        const { error } = await supabase
          .from('club_followers')
          .delete()
          .eq('id', followId);

        if (error) throw error;

        setIsFollowing(false);
        setFollowId(null);
        toast({ title: 'Unfollowed club' });
      } else {
        // Follow
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
          title: 'Following club!',
          description: "You'll be notified when they add new availability",
        });
      }
    } catch (error: any) {
      toast({
        title: 'Error',
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
