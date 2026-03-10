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
import { getActiveCycles, hasPlayerApplied, type Cycle } from '@/lib/cycles';
import CycleApplicationForm from '@/components/cycles/CycleApplicationForm';

interface TrainerOpenCyclesProps {
  trainerId: string;
  trainerName: string;
}

export function TrainerOpenCycles({ trainerId, trainerName }: TrainerOpenCyclesProps) {
  const { t, i18n } = useTranslation(['cycles', 'common']);
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [expandedCycleId, setExpandedCycleId] = useState<string | null>(null);
  const [appliedCycles, setAppliedCycles] = useState<Set<string>>(new Set());
  const [successCycleId, setSuccessCycleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  useEffect(() => {
    async function fetchData() {
      try {
        const cyclesData = await getActiveCycles('trainer', trainerId);
        setCycles(cyclesData);

        if (user && cyclesData.length > 0) {
          const appliedSet = new Set<string>();
          for (const cycle of cyclesData) {
            const applied = await hasPlayerApplied(cycle.id, user.id);
            if (applied) appliedSet.add(cycle.id);
          }
          setAppliedCycles(appliedSet);
        }
      } catch (error) {
        console.error('Error fetching trainer cycles:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [trainerId, user]);

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

  if (loading || cycles.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            {t('registration.openCycles', 'Open for Registration')}
          </CardTitle>
          <Badge variant="secondary" className="text-sm">
            {cycles.length} {cycles.length === 1 ? t('cycle', 'cycle') : t('cyclesCount', 'cycles')}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {cycles.map(cycle => {
          const hasApplied = appliedCycles.has(cycle.id);
          const deadlinePassed = isDeadlinePassed(cycle);
          const isExpanded = expandedCycleId === cycle.id;
          const showSuccess = successCycleId === cycle.id;
          const canApply = !hasApplied && !deadlinePassed;

          return (
            <div key={cycle.id} className={`border rounded-lg p-4 ${showSuccess ? 'border-green-500' : ''}`}>
              <Collapsible
                open={isExpanded}
                onOpenChange={(open) => setExpandedCycleId(open ? cycle.id : null)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <h4 className="font-medium">{cycle.name}</h4>
                    <div className="flex flex-wrap gap-3 mt-1 text-sm text-muted-foreground">
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
                    </div>
                    {cycle.description && (
                      <div className="text-sm text-muted-foreground mt-2 prose prose-sm dark:prose-invert max-w-none" dangerouslySetInnerHTML={{ __html: cycle.description }} />
                    )}
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
                    {!user && !deadlinePassed && (
                      <Button variant="default" size="sm" onClick={handleSignupRedirect}>
                        <UserPlus className="h-4 w-4 mr-1" />
                        {t('application.signUpAndApply')}
                      </Button>
                    )}
                  </div>
                </div>

                <CollapsibleContent>
                  <div className="pt-4 mt-4 border-t">
                    {showSuccess ? (
                      <Alert className="border-green-500 bg-green-50 dark:bg-green-950/20">
                        <Calendar className="h-4 w-4 text-green-600" />
                        <AlertTitle className="text-green-600">{t('application.success.title')}</AlertTitle>
                        <AlertDescription>
                          {t('application.success.message')}
                        </AlertDescription>
                      </Alert>
                    ) : (
                      user && profile && (
                        <CycleApplicationForm
                          cycle={cycle}
                          playerId={profile.id}
                          playerUserId={user.id}
                          playerName={profile.full_name || ''}
                          playerEmail={user.email || ''}
                          playerPhone={profile.phone || ''}
                          playerRating={profile.skill_rating ?? undefined}
                          playerRatingSystem={profile.rating_system || 'knltb'}
                          trainers={[{ id: trainerId, name: trainerName }]}
                          onSuccess={() => handleSuccess(cycle.id)}
                          onCancel={() => setExpandedCycleId(null)}
                        />
                      )
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
