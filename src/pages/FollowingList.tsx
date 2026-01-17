import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { ArrowLeft, Users, Bell, BellOff, UserMinus, MapPin } from 'lucide-react';

interface FollowedTrainer {
  id: string;
  trainer_id: string;
  notify_new_availability: boolean;
  trainer_user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  location: string | null;
  hourly_rate: number | null;
}

export default function FollowingList() {
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [following, setFollowing] = useState<FollowedTrainer[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (role !== 'player') {
        navigate('/trainer');
      }
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    if (user && role === 'player') {
      fetchFollowing();
    }
  }, [user, role]);

  const fetchFollowing = async () => {
    try {
      // Get player's profile ID
      const { data: playerProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('user_id', user!.id)
        .single();

      if (!playerProfile) return;

      // Get followed trainers
      const { data: follows, error } = await supabase
        .from('trainer_followers')
        .select('id, trainer_id, notify_new_availability')
        .eq('player_id', playerProfile.id);

      if (error) throw error;
      if (!follows || follows.length === 0) {
        setFollowing([]);
        setDataLoading(false);
        return;
      }

      // Get trainer profiles
      const trainerIds = follows.map((f) => f.trainer_id);
      const { data: trainers } = await supabase
        .from('trainer_profiles')
        .select('id, user_id, hourly_rate')
        .in('id', trainerIds);

      if (!trainers) {
        setFollowing([]);
        setDataLoading(false);
        return;
      }

      // Get user profiles (using public view to protect PII)
      const userIds = trainers.map((t) => t.user_id);
      const { data: profiles } = await supabase
        .from('profiles_public')
        .select('user_id, full_name, avatar_url, location')
        .in('user_id', userIds);

      const profileMap = new Map(profiles?.map((p) => [p.user_id, p]) || []);
      const trainerMap = new Map(trainers.map((t) => [t.id, t]));

      const enrichedFollowing: FollowedTrainer[] = follows.map((f) => {
        const trainer = trainerMap.get(f.trainer_id);
        const profile = trainer ? profileMap.get(trainer.user_id) : null;
        return {
          id: f.id,
          trainer_id: f.trainer_id,
          notify_new_availability: f.notify_new_availability,
          trainer_user_id: trainer?.user_id || '',
          full_name: profile?.full_name || null,
          avatar_url: profile?.avatar_url || null,
          location: profile?.location || null,
          hourly_rate: trainer?.hourly_rate || null,
        };
      });

      setFollowing(enrichedFollowing);
    } catch (error: any) {
      console.error('Error fetching following:', error);
      toast({
        title: 'Error loading data',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setDataLoading(false);
    }
  };

  const toggleNotification = async (followId: string, currentValue: boolean) => {
    try {
      const { error } = await supabase
        .from('trainer_followers')
        .update({ notify_new_availability: !currentValue })
        .eq('id', followId);

      if (error) throw error;

      setFollowing((prev) =>
        prev.map((f) =>
          f.id === followId ? { ...f, notify_new_availability: !currentValue } : f
        )
      );

      toast({
        title: !currentValue ? 'Notifications enabled' : 'Notifications disabled',
        description: !currentValue
          ? "You'll receive emails when this trainer adds availability"
          : "You won't receive availability notifications",
      });
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const unfollow = async (followId: string, trainerName: string | null) => {
    if (!confirm(`Unfollow ${trainerName || 'this trainer'}?`)) return;

    try {
      const { error } = await supabase
        .from('trainer_followers')
        .delete()
        .eq('id', followId);

      if (error) throw error;

      setFollowing((prev) => prev.filter((f) => f.id !== followId));
      toast({ title: 'Unfollowed', description: `You unfollowed ${trainerName || 'the trainer'}` });
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const getInitials = (name: string | null) => {
    if (!name) return 'T';
    return name.split(' ').map((n) => n[0]).join('').toUpperCase();
  };

  if (loading || dataLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/player')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-3">
            <Users className="h-6 w-6 text-primary" />
            <span className="font-bold text-xl">Following</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">Trainers You Follow</h1>
          <p className="text-muted-foreground">
            Manage your followed trainers and notification preferences.
          </p>
        </div>

        {following.length === 0 ? (
          <Card className="p-8 text-center">
            <Users className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
            <h3 className="font-semibold mb-2">Not following any trainers yet</h3>
            <p className="text-muted-foreground mb-4">
              Follow trainers to get notified when they add new availability slots.
            </p>
            <Button onClick={() => navigate('/trainers')}>Browse Trainers</Button>
          </Card>
        ) : (
          <div className="space-y-4">
            {following.map((trainer) => (
              <Card key={trainer.id}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <Avatar
                      className="h-14 w-14 cursor-pointer"
                      onClick={() => navigate(`/trainer/${trainer.trainer_user_id}`)}
                    >
                      <AvatarImage src={trainer.avatar_url || undefined} />
                      <AvatarFallback>{getInitials(trainer.full_name)}</AvatarFallback>
                    </Avatar>

                    <div
                      className="flex-1 cursor-pointer"
                      onClick={() => navigate(`/trainer/${trainer.trainer_user_id}`)}
                    >
                      <h3 className="font-semibold">{trainer.full_name || 'Trainer'}</h3>
                      {trainer.location && (
                        <p className="text-sm text-muted-foreground flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {trainer.location}
                        </p>
                      )}
                      {trainer.hourly_rate && (
                        <Badge variant="secondary" className="mt-1">
                          €{trainer.hourly_rate}/hr
                        </Badge>
                      )}
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        {trainer.notify_new_availability ? (
                          <Bell className="h-4 w-4 text-primary" />
                        ) : (
                          <BellOff className="h-4 w-4 text-muted-foreground" />
                        )}
                        <Switch
                          checked={trainer.notify_new_availability}
                          onCheckedChange={() =>
                            toggleNotification(trainer.id, trainer.notify_new_availability)
                          }
                        />
                      </div>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => unfollow(trainer.id, trainer.full_name)}
                      >
                        <UserMinus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="mt-8 text-center">
          <Button variant="outline" onClick={() => navigate('/trainers')}>
            Find More Trainers
          </Button>
        </div>
      </main>
    </div>
  );
}
