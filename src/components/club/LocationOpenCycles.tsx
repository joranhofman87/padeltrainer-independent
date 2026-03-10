import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Calendar, Clock, ExternalLink, Info } from 'lucide-react';
import { getMarketingPath } from '@/lib/domains';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { getLocationCycles, hasPlayerApplied, type Cycle } from '@/lib/cycles';
import { supabase } from '@/lib/supabaseClient';

interface LocationOpenCyclesProps {
  locationId: string;
  locationName: string;
  clubSlug?: string;
}

export function LocationOpenCycles({ locationId, locationName, clubSlug }: LocationOpenCyclesProps) {
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
        const cyclesData = await getLocationCycles(locationId);
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
        console.error('Error fetching open cycles:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [locationId, user]);

  const isDeadlinePassed = (cycle: Cycle) => {
    return cycle.enrollment_deadline && new Date(cycle.enrollment_deadline) < new Date();
  };

  const getRegisterPath = (cycle: Cycle) => {
    const currentLang = lang || i18n.language;
    // Club-owned cycles go to club registration page, others to generic
    if (cycle.owner_type === 'club' && clubSlug) {
      return getMarketingPath(`clubs/${clubSlug}/register/${cycle.id}`, currentLang);
    }
    return getMarketingPath(`register/${cycle.id}`, currentLang);
  };

  if (loading || cycles.length === 0) {
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
          const canApply = !hasApplied && !deadlinePassed;

          return (
            <div key={cycle.id} className="border rounded-lg p-4 bg-card">
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(getRegisterPath(cycle))}
                  >
                    <Info className="h-4 w-4 mr-1" />
                    {t('registration.moreInfo', 'More info')}
                  </Button>
                  {canApply && (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => navigate(getRegisterPath(cycle))}
                    >
                      {t('application.apply', 'Apply')} <ExternalLink className="h-4 w-4 ml-1" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
