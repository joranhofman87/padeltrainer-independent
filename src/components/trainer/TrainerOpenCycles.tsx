import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Calendar, Clock, ExternalLink, Info } from 'lucide-react';
import { getMarketingPath } from '@/lib/domains';
import { logger } from '@/lib/logger';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { getActiveCycles, hasPlayerApplied, type Cycle } from '@/lib/cycles';

interface TrainerOpenCyclesProps {
  trainerId: string;
  trainerName: string;
}

export function TrainerOpenCycles({ trainerId, trainerName: _trainerName }: TrainerOpenCyclesProps) {
  const { t, i18n } = useTranslation(['cycles', 'common']);
  const { user } = useAuth();
  const navigate = useNavigate();
  const { lang } = useParams<{ lang: string }>();
  
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [appliedCycles, setAppliedCycles] = useState<Set<string>>(new Set());
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
        logger.error('Error fetching trainer cycles', error instanceof Error ? error : new Error(String(error)), { component: 'TrainerOpenCycles' });
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [trainerId, user]);

  const getRegisterPath = (cycleId: string) => {
    return getMarketingPath(`register/${cycleId}`, lang || i18n.language);
  };

  if (loading || cycles.length === 0) {
    return null;
  }

  return (
    <Card className={flushOnMobileCardClass()}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-primary" />
          {t('registration.openCycles', 'Open for Registration')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {cycles.map(cycle => {
          const hasApplied = appliedCycles.has(cycle.id);
          const canApply = !hasApplied;

          return (
            <div key={cycle.id} className="border rounded-lg p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0 flex-1">
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
                </div>
                
                <div className="flex items-center gap-2 shrink-0">
                  {hasApplied && (
                    <Badge variant="outline" className="text-green-600 border-green-600">
                      {t('application.alreadyApplied', 'Applied')}
                    </Badge>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(getRegisterPath(cycle.id))}
                  >
                    <Info className="h-4 w-4 mr-1" />
                    {t('registration.moreInfo', 'More info')}
                  </Button>
                  {canApply && (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => navigate(getRegisterPath(cycle.id))}
                    >
                      {t('application.apply', 'Apply')}
                      <ExternalLink className="h-4 w-4 ml-1" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
