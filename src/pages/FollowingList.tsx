import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { supabase } from '@/lib/supabaseClient';
import { Users, Bell, BellOff, UserMinus, MapPin } from 'lucide-react';
import { logger } from '@/lib/logger';
import { useTranslation } from 'react-i18next';
import { AppPage, surfaceCardClass } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/utils';

interface FollowedTrainer {
  id: string;
  trainer_id: string;
  notify_new_availability: boolean;
  trainer_user_id: string;
  trainer_slug: string | null;
  full_name: string | null;
  avatar_url: string | null;
  location: string | null;
  hourly_rate: number | null;
}

export default function FollowingList() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();
  const { toast } = useToast();
  const { t } = useTranslation('player');

  const [following, setFollowing] = useState<FollowedTrainer[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [unfollowTarget, setUnfollowTarget] = useState<{ id: string; name: string | null } | null>(null);
  const [unfollowing, setUnfollowing] = useState(false);

  useEffect(() => {
    if (user) {
      fetchFollowing();
    }
  }, [user]);

  const fetchFollowing = async () => {
    try {
      const { data: playerProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('user_id', user!.id)
        .single();

      if (!playerProfile) return;

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

      const trainerIds = follows.map((f) => f.trainer_id);
      const { data: trainers } = await supabase
        .from('trainer_profiles')
        .select('id, user_id, slug, hourly_rate')
        .in('id', trainerIds);

      if (!trainers) {
        setFollowing([]);
        setDataLoading(false);
        return;
      }

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
          trainer_slug: trainer?.slug || null,
          full_name: profile?.full_name || null,
          avatar_url: profile?.avatar_url || null,
          location: profile?.location || null,
          hourly_rate: trainer?.hourly_rate || null,
        };
      });

      setFollowing(enrichedFollowing);
    } catch (error: any) {
      logger.error('Error fetching following', error as Error, { component: 'FollowingList' });
      toast({
        title: t('followingList.notificationsDisabled'),
        description: getFriendlyErrorMessage(error, t('followingList.genericError', 'Something went wrong. Please try again.')),
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
        title: !currentValue ? t('followingList.notificationsEnabled') : t('followingList.notificationsDisabled'),
        description: !currentValue
          ? t('followingList.notificationsEnabledDescription')
          : t('followingList.notificationsDisabledDescription'),
      });
    } catch (error: any) {
      toast({
        title: t('followingList.notificationsDisabled'),
        description: getFriendlyErrorMessage(error, t('followingList.genericError', 'Something went wrong. Please try again.')),
        variant: 'destructive',
      });
    }
  };

  const unfollow = async (followId: string, trainerName: string | null) => {
    setUnfollowing(true);
    try {
      const { error } = await supabase
        .from('trainer_followers')
        .delete()
        .eq('id', followId);

      if (error) throw error;

      setFollowing((prev) => prev.filter((f) => f.id !== followId));
      toast({ title: t('followingList.unfollowed'), description: t('followingList.unfollowedDescription', { name: trainerName || 'the trainer' }) });
    } catch (error: any) {
      toast({
        title: t('followingList.notificationsDisabled'),
        description: getFriendlyErrorMessage(error, t('followingList.genericError', 'Something went wrong. Please try again.')),
        variant: 'destructive',
      });
    } finally {
      setUnfollowing(false);
      setUnfollowTarget(null);
    }
  };

  const getInitials = (name: string | null) => {
    if (!name) return 'T';
    return name.split(' ').map((n) => n[0]).join('').toUpperCase();
  };

  if (loading || dataLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <AppPage width="narrow" as="main" data-testid="page-player-following">
      <PageHeader
        title={t('followingList.title')}
        description={t('followingList.subtitle')}
      />

        {following.length === 0 ? (
          <Card className={cn(surfaceCardClass(), 'p-10 text-center')}>
            <Users className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
            <h3 className="font-semibold mb-2">{t('followingList.notFollowingYet')}</h3>
            <p className="text-muted-foreground mb-4">
              {t('followingList.followDescription')}
            </p>
            <Button onClick={() => navigate(localizePath('/trainers'))}>{t('followingList.browseTrainers')}</Button>
          </Card>
        ) : (
          <div className="space-y-4">
            {following.map((trainer) => (
              <Card key={trainer.id} className={surfaceCardClass()}>
                <CardContent className="p-5">
                  <div className="flex items-center gap-4">
                    <Avatar
                      className="h-14 w-14 cursor-pointer"
                    onClick={() => navigate(localizePath(`/trainer/${trainer.trainer_slug || trainer.trainer_id}`))}
                    >
                      <AvatarImage src={trainer.avatar_url || undefined} />
                      <AvatarFallback>{getInitials(trainer.full_name)}</AvatarFallback>
                    </Avatar>

                    <div
                      className="flex-1 cursor-pointer"
                      onClick={() => navigate(localizePath(`/trainer/${trainer.trainer_slug || trainer.trainer_id}`))}
                    >
                      <h3 className="font-semibold">{trainer.full_name || 'Trainer'}</h3>
                      {trainer.location && (
                        <p className="text-sm text-muted-foreground flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {trainer.location}
                        </p>
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
                        aria-label={t('followingList.unfollow', 'Unfollow')}
                        onClick={() => setUnfollowTarget({ id: trainer.id, name: trainer.full_name })}
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
        <Button variant="outline" onClick={() => navigate(localizePath('/trainers'))}>
          {t('followingList.findMore')}
        </Button>
      </div>

      <ConfirmDeleteDialog
        open={!!unfollowTarget}
        onOpenChange={(next) => { if (!next) setUnfollowTarget(null); }}
        title={t('followingList.unfollowConfirmTitle', 'Unfollow trainer?')}
        description={t('followingList.unfollowConfirm', { name: unfollowTarget?.name || t('followingList.thisTrainer', 'this trainer') })}
        confirmLabel={t('followingList.unfollow', 'Unfollow')}
        cancelLabel={t('common:cancel', 'Cancel')}
        loading={unfollowing}
        onConfirm={() => { if (unfollowTarget) void unfollow(unfollowTarget.id, unfollowTarget.name); }}
      />
    </AppPage>
  );
}