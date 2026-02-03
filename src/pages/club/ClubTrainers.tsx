import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { Users, Calendar, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useClubContext } from '@/components/club/ClubLayout';
import { getClubTrainers, updateTrainerVisibility } from '@/lib/club';
import { supabase } from '@/integrations/supabase/client';
import { CreateClubTrainerDialog } from '@/components/club/CreateClubTrainerDialog';
import { EditClubTrainerDialog } from '@/components/club/EditClubTrainerDialog';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';

interface TrainerWithProfile {
  id: string;
  trainer_id: string;
  is_primary: boolean;
  relationship_type: string;
  show_on_club_page: boolean;
  trainer_profiles: {
    id: string;
    user_id: string;
    slug: string | null;
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
  const localizePath = useLocalizedPathFn();
  const { activeClub } = useClubContext();
  const [trainers, setTrainers] = useState<TrainerWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingVisibility, setUpdatingVisibility] = useState<string | null>(null);

  const fetchData = async () => {
    if (!activeClub) return;

    try {
      const trainersData = await getClubTrainers(activeClub.id);

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
      logger.error('Error fetching club trainers', error as Error, { component: 'ClubTrainers', clubId: activeClub?.id });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [activeClub]);

  const handleVisibilityToggle = async (trainerLocationId: string, showOnClubPage: boolean, hasName: boolean) => {
    if (!hasName && showOnClubPage) {
      toast.error(t('trainers.incompleteProfile'));
      return;
    }

    setUpdatingVisibility(trainerLocationId);
    const success = await updateTrainerVisibility(trainerLocationId, showOnClubPage);
    
    if (success) {
      setTrainers(prev => prev.map(trainer => 
        trainer.id === trainerLocationId 
          ? { ...trainer, show_on_club_page: showOnClubPage }
          : trainer
      ));
      toast.success(showOnClubPage ? t('trainers.visibilityPublic') : t('trainers.visibilityHidden'));
    } else {
      toast.error('Failed to update visibility');
    }
    setUpdatingVisibility(null);
  };

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Skeleton className="h-10 w-48 mb-6" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">{t('trainers.title')}</h2>
          <p className="text-muted-foreground">{t('trainers.description')}</p>
        </div>
        {activeClub && (
          <CreateClubTrainerDialog
            clubProfileId={activeClub.id}
            locationId={activeClub.location_id}
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
          {trainers.map(trainer => {
            const hasName = !!trainer.profile?.full_name;
            const isVisible = trainer.show_on_club_page;

            return (
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
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {trainer.trainer_profiles.is_verified && (
                          <Badge variant="secondary" className="text-xs">Verified</Badge>
                        )}
                        <Badge variant="outline" className="text-xs">Club Trainer</Badge>
                        <Badge 
                          variant={isVisible ? 'default' : 'secondary'} 
                          className="text-xs flex items-center gap-1"
                        >
                          {isVisible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                          {isVisible ? t('trainers.visibilityPublic') : t('trainers.visibilityHidden')}
                        </Badge>
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

                  {/* Visibility Toggle */}
                  <div className="pt-2 border-t">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center justify-between">
                            <Label 
                              htmlFor={`visibility-${trainer.id}`}
                              className={`text-sm ${!hasName ? 'text-muted-foreground' : ''}`}
                            >
                              {t('trainers.showOnClubPage')}
                            </Label>
                            <Switch
                              id={`visibility-${trainer.id}`}
                              checked={isVisible}
                              onCheckedChange={(checked) => handleVisibilityToggle(trainer.id, checked, hasName)}
                              disabled={updatingVisibility === trainer.id || (!hasName && !isVisible)}
                            />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{hasName ? t('trainers.visibilityHint') : t('trainers.incompleteProfile')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>

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
                      onClick={() => navigate(localizePath(`/trainer/${trainer.trainer_profiles?.slug || trainer.trainer_id}`))}
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
            );
          })}
        </div>
      )}
    </div>
  );
}
