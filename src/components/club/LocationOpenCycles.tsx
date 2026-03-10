import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Calendar, Clock, ChevronDown, ChevronUp, UserPlus } from 'lucide-react';
import { getAppUrl } from '@/lib/domains';
import CycleDetailDisplay from '@/components/cycles/CycleDetailDisplay';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useAuth } from '@/hooks/useAuth';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { getLocationCycles, hasPlayerApplied, type Cycle } from '@/lib/cycles';
import { supabase } from '@/lib/supabaseClient';
import CycleApplicationForm from '@/components/cycles/CycleApplicationForm';

interface LocationOpenCyclesProps {
  locationId: string;
  locationName: string;
}

interface TrainerOption {
  id: string;
  name: string;
}

export function LocationOpenCycles({ locationId, locationName }: LocationOpenCyclesProps) {
  const { t, i18n } = useTranslation(['cycles', 'common']);
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();
  
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [trainers, setTrainers] = useState<TrainerOption[]>([]);
  const [expandedCycleId, setExpandedCycleId] = useState<string | null>(null);
  const [appliedCycles, setAppliedCycles] = useState<Set<string>>(new Set());
  const [successCycleId, setSuccessCycleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  useEffect(() => {
    async function fetchData() {
      try {
        // Fetch open cycles from trainers + academies at this location
        const cyclesData = await getLocationCycles(locationId);
        setCycles(cyclesData);

        // Fetch trainers at this location for the application form
        const { data: trainerLocations } = await supabase
          .from('trainer_locations')
          .select('trainer_id')
          .eq('location_id', locationId);

        if (trainerLocations && trainerLocations.length > 0) {
          const trainerIds = trainerLocations.map(tl => tl.trainer_id);
          
          const { data: trainerProfiles } = await supabase
            .from('trainer_profiles')
            .select('id, user_id')
            .in('id', trainerIds);

          if (trainerProfiles) {
            const userIds = trainerProfiles.map(tp => tp.user_id);
            const { data: profiles } = await supabase
              .from('profiles')
              .select('id, full_name')
              .in('id', userIds);

            if (profiles) {
              const trainersList = trainerProfiles.map(tp => {
                const p = profiles.find(p => p.id === tp.user_id);
                return {
                  id: tp.id,
                  name: p?.full_name || 'Trainer'
                };
              });
              setTrainers(trainersList);
            }
          }
        }

        // Check which cycles the user has already applied to
        if (user && cyclesData.length > 0) {
          const appliedSet = new Set<string>();
          for (const cycle of cyclesData) {
            const applied = await hasPlayerApplied(cycle.id, user.id);
            if (applied) appliedSet.add(cycle.id);
          }
          setAppliedCycles(appliedSet);
        }
      } catch (error) {
        console.error('Error fetching open cycles:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [locationId, user]);

  const handleSignupRedirect = () => {
    const currentPath = window.location.pathname;
    navigate(getAppUrl(`/signup/player?redirect=${encodeURIComponent(currentPath)}`));
  };

  const handleSuccess = (cycleId: string) => {
    setSuccessCycleId(cycleId);
    setAppliedCycles(prev => new Set(prev).add(cycleId));
    setExpandedCycleId(null);
  };

  const isDeadlinePassed = (cycle: Cycle) => {
    return cycle.enrollment_deadline && new Date(cycle.enrollment_deadline) < new Date();
  };

  if (loading) {
    return null;
  }

  if (cycles.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <Calendar className="h-6 w-6 text-primary" />
          {t('registration.openCycles', 'Open for Registration')}
        </h2>
        <Badge variant="secondary" className="text-sm">
          {cycles.length} {cycles.length === 1 ? t('cycle', 'cycle') : t('cyclesCount', 'cycles')}
        </Badge>
      </div>

      <div className="space-y-4">
        {cycles.map(cycle => {
          const hasApplied = appliedCycles.has(cycle.id);
          const deadlinePassed = isDeadlinePassed(cycle);
          const isExpanded = expandedCycleId === cycle.id;
          const showSuccess = successCycleId === cycle.id;
          const canApply = !hasApplied && !deadlinePassed;

          return (
            <Card key={cycle.id} className={showSuccess ? 'border-green-500' : ''}>
              <Collapsible
                open={isExpanded}
                onOpenChange={(open) => setExpandedCycleId(open ? cycle.id : null)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <CardTitle className="text-lg">{cycle.name}</CardTitle>
                      <CardDescription className="flex flex-wrap gap-3 mt-1">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-4 w-4" />
                          {format(new Date(cycle.start_date), 'd MMM', { locale: dateLocale })} - {format(new Date(cycle.end_date), 'd MMM yyyy', { locale: dateLocale })}
                        </span>
                        {cycle.enrollment_deadline && (
                          <span className="flex items-center gap-1 text-orange-600 dark:text-orange-400">
                            <Clock className="h-4 w-4" />
                            {t('registration.deadline', 'Deadline')}: {format(new Date(cycle.enrollment_deadline), 'd MMM yyyy', { locale: dateLocale })}
                          </span>
                        )}
                      </CardDescription>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      {hasApplied && (
                        <Badge variant="outline" className="text-green-600 border-green-600">
                          {t('application.alreadyApplied', 'Applied')}
                        </Badge>
                      )}
                      {deadlinePassed && !hasApplied && (
                        <Badge variant="destructive">
                          {t('application.deadlinePassed', 'Deadline passed')}
                        </Badge>
                      )}
                    {canApply && (
                        <CollapsibleTrigger asChild>
                          <Button variant="default" size="sm">
                            {isExpanded ? (
                              <>
                                {t('common:close', 'Close')} <ChevronUp className="h-4 w-4 ml-1" />
                              </>
                            ) : (
                              <>
                                {t('application.apply', 'Apply')} <ChevronDown className="h-4 w-4 ml-1" />
                              </>
                            )}
                          </Button>
                        </CollapsibleTrigger>
                      )}
                    </div>
                  </div>
                </CardHeader>

                {cycle.description && (
                  <CardContent className="pt-0 pb-2">
                    <div className="text-sm text-muted-foreground prose prose-sm dark:prose-invert max-w-none" dangerouslySetInnerHTML={{ __html: cycle.description }} />
                  </CardContent>
                )}
                <CardContent className="pt-0 pb-2">
                  <CycleDetailDisplay cycle={cycle} />
                </CardContent>

                <CollapsibleContent>
                  <CardContent className="pt-4 border-t">
                    {showSuccess ? (
                      <Alert className="border-green-500 bg-green-50 dark:bg-green-950/20">
                        <Calendar className="h-4 w-4 text-green-600" />
                        <AlertTitle className="text-green-600">{t('application.success.title')}</AlertTitle>
                        <AlertDescription>
                          {t('application.success.message')}
                        </AlertDescription>
                      </Alert>
                    ) : (
                      user && profile ? (
                        <CycleApplicationForm
                          cycle={cycle}
                          playerId={profile.id}
                          playerUserId={user.id}
                          playerName={profile.full_name || ''}
                          playerEmail={user.email || ''}
                          playerPhone={profile.phone || ''}
                          playerRating={profile.skill_rating ?? undefined}
                          playerRatingSystem={profile.rating_system || 'knltb'}
                          trainers={cycle.settings?.show_preferred_trainer ? trainers : undefined}
                          onSuccess={() => handleSuccess(cycle.id)}
                          onCancel={() => setExpandedCycleId(null)}
                        />
                      ) : (
                        <CycleApplicationForm
                          cycle={cycle}
                          playerId=""
                          playerUserId=""
                          playerName=""
                          playerEmail=""
                          playerPhone=""
                          isGuest
                          trainers={cycle.settings?.show_preferred_trainer ? trainers : undefined}
                          onSuccess={() => handleSuccess(cycle.id)}
                          onCancel={() => setExpandedCycleId(null)}
                        />
                      )
                    )}
                      )
                    )}
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
