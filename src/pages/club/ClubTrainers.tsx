import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Users, Calendar, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { getUserClubProfiles, getClubTrainers } from '@/lib/club';
import { supabase } from '@/integrations/supabase/client';
import { ClubNavigation } from '@/components/club/ClubNavigation';
import { CreateClubTrainerDialog } from '@/components/club/CreateClubTrainerDialog';
import { EditClubTrainerDialog } from '@/components/club/EditClubTrainerDialog';

interface TrainerWithProfile {
  id: string;
  trainer_id: string;
  is_primary: boolean;
  relationship_type: string;
  trainer_profiles: {
    id: string;
    user_id: string;
    hourly_rate: number | null;
    experience_years: number | null;
    specializations: string[] | null;
    is_verified: boolean | null;
  };
  profile?: {
    full_name: string | null;
    avatar_url: string | null;
  };
}

export default function ClubTrainers() {
  const { t } = useTranslation('club');
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [trainers, setTrainers] = useState<TrainerWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [clubData, setClubData] = useState<{ id: string; locationId: string } | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  const fetchData = async () => {
    if (!user) return;

    try {
      const userClubs = await getUserClubProfiles(user.id);
      if (userClubs.length === 0) {
        navigate('/club');
        return;
      }

      const clubId = userClubs[0].id;
      const locationId = userClubs[0].location_id;
      setClubData({ id: clubId, locationId });
      
      const trainersData = await getClubTrainers(clubId);

      // Fetch profiles for trainers
      const userIds = trainersData.map((t: any) => t.trainer_profiles.user_id);
      const { data: profiles } = await supabase
        .from('profiles_public')
        .select('user_id, full_name, avatar_url')
        .in('user_id', userIds);

      const trainersWithProfiles = trainersData.map((trainer: any) => ({
        ...trainer,
        profile: profiles?.find(p => p.user_id === trainer.trainer_profiles.user_id),
      }));

      setTrainers(trainersWithProfiles);
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [user, navigate]);

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8">
          <Skeleton className="h-10 w-48 mb-6" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-semibold">{t('trainers.title')}</h1>
        </div>
        <ClubNavigation />
      </div>

      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <p className="text-muted-foreground">{t('trainers.description')}</p>
          {clubData && (
            <CreateClubTrainerDialog
              clubProfileId={clubData.id}
              locationId={clubData.locationId}
              onTrainerCreated={fetchData}
            />
          )}
        </div>

        {trainers.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">{t('trainers.empty')}</h3>
              <p className="text-muted-foreground">{t('trainers.emptyDescription')}</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {trainers.map(trainer => (
              <Card key={trainer.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-start gap-4">
                    <Avatar className="h-14 w-14">
                      <AvatarImage src={trainer.profile?.avatar_url || ''} />
                      <AvatarFallback>{getInitials(trainer.profile?.full_name)}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-lg truncate">
                        {trainer.profile?.full_name || 'Trainer'}
                      </CardTitle>
                      <div className="flex items-center gap-2 mt-1">
                        {trainer.trainer_profiles.is_verified && (
                          <Badge variant="secondary" className="text-xs">Verified</Badge>
                        )}
                        <Badge variant="outline" className="text-xs">Club Trainer</Badge>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    {trainer.trainer_profiles.hourly_rate && (
                      <span className="font-semibold text-primary">
                        €{trainer.trainer_profiles.hourly_rate}/hour
                      </span>
                    )}
                    {trainer.trainer_profiles.experience_years && (
                      <span className="text-muted-foreground">
                        {trainer.trainer_profiles.experience_years}y exp.
                      </span>
                    )}
                  </div>

                  {trainer.trainer_profiles.specializations && trainer.trainer_profiles.specializations.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {trainer.trainer_profiles.specializations.slice(0, 3).map(spec => (
                        <Badge key={spec} variant="outline" className="text-xs">
                          {spec}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-2">
                    <EditClubTrainerDialog
                      trainerId={trainer.trainer_id}
                      userId={trainer.trainer_profiles.user_id}
                      trainerName={trainer.profile?.full_name || 'Trainer'}
                      onTrainerUpdated={fetchData}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(`/trainer/${trainer.trainer_id}`)}
                    >
                      <ExternalLink className="h-4 w-4 mr-2" />
                      {t('trainers.viewProfile', 'Profile')}
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => navigate(`/club/calendar?trainer=${trainer.trainer_id}`)}
                    >
                      <Calendar className="h-4 w-4 mr-2" />
                      {t('trainers.viewCalendar')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
