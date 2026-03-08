import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Calendar, Clock, ChevronDown, ChevronUp, UserPlus, PartyPopper, CreditCard, Banknote } from 'lucide-react';
import { getAppUrl } from '@/lib/domains';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useAuth } from '@/hooks/useAuth';
import { getActiveCycles, hasPlayerApplied, type Cycle } from '@/lib/cycles';
import { getPublicAcademyTrainers } from '@/lib/academy';
import CycleApplicationForm from '@/components/cycles/CycleApplicationForm';

interface AcademyOpenCyclesProps {
  academyId: string;
  academyName: string;
}

interface TrainerOption {
  id: string;
  name: string;
}

export function AcademyOpenCycles({ academyId, academyName }: AcademyOpenCyclesProps) {
  const { t, i18n } = useTranslation(['cycles', 'common']);
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  
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
        const [cyclesData, trainersData] = await Promise.all([
          getActiveCycles('academy', academyId),
          getPublicAcademyTrainers(academyId),
        ]);
        
        setCycles(cyclesData);
        setTrainers(trainersData.map(t => ({
          id: t.trainer_profile_id,
          name: t.profile?.full_name || 'Trainer',
        })));

        if (user && cyclesData.length > 0) {
          const appliedSet = new Set<string>();
          for (const cycle of cyclesData) {
            const applied = await hasPlayerApplied(cycle.id, user.id);
            if (applied) appliedSet.add(cycle.id);
          }
          setAppliedCycles(appliedSet);
        }
      } catch (error) {
        console.error('Error fetching academy cycles:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [academyId, user]);

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
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            {t('registration.openCycles', 'Open for Registration')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Calendar className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">{t('registration.noCycles', 'No open registrations')}</p>
            <p className="text-sm mt-1">{t('registration.checkBackLater', 'Check back later for upcoming training cycles.')}</p>
          </div>
        </CardContent>
      </Card>
    );
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
          const canApply = user && !hasApplied && !deadlinePassed;

          return (
            <div key={cycle.id} className={`border rounded-lg p-4 ${showSuccess ? 'border-green-500' : ''}`}>
              <Collapsible
                open={isExpanded}
                onOpenChange={(open) => setExpandedCycleId(open ? cycle.id : null)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-medium">{cycle.name}</h4>
                      {cycle.type === 'event' && (
                        <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-600 border-purple-500/20">
                          <PartyPopper className="h-3 w-3 mr-1" />
                          {t('type.event', 'Event')}
                        </Badge>
                      )}
                    </div>
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
                      {cycle.type === 'event' && cycle.total_price && (
                        <span className="font-medium text-foreground">
                          {new Intl.NumberFormat(i18n.language, { style: 'currency', currency: cycle.currency || 'EUR' }).format(cycle.total_price)}
                        </span>
                      )}
                      {cycle.type === 'event' && (() => {
                        const pm = (cycle.settings as any)?.payment_methods;
                        if (!pm) return null;
                        return (
                          <span className="flex items-center gap-1">
                            {pm === 'online' && <><CreditCard className="h-4 w-4" />{t('paymentBadge.online', 'Pay Online')}</>}
                            {pm === 'cash' && <><Banknote className="h-4 w-4" />{t('paymentBadge.cash', 'Pay at Location')}</>}
                            {pm === 'both' && <><CreditCard className="h-4 w-4" />{t('paymentBadge.both', 'Online or at Location')}</>}
                          </span>
                        );
                      })()}
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
                          trainers={cycle.settings?.show_preferred_trainer ? trainers : undefined}
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
