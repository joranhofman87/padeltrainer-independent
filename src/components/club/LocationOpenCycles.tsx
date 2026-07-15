import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Calendar, Clock, ExternalLink, Info } from 'lucide-react';
import { getMarketingPath } from '@/lib/domains';
import { logger } from '@/lib/logger';
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

export function LocationOpenCycles({ locationId, locationName: _locationName, clubSlug }: LocationOpenCyclesProps) {
  const { t, i18n } = useTranslation(['cycles', 'common']);
  const { user } = useAuth();
  const navigate = useNavigate();
  const { lang } = useParams<{ lang: string }>();
  
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [appliedCycles, setAppliedCycles] = useState<Set<string>>(new Set());
  const [academySlugs, setAcademySlugs] = useState<Record<string, string>>({});
  const [trainerAcademySlugs, setTrainerAcademySlugs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  useEffect(() => {
    async function fetchData() {
      try {
        const cyclesData = await getLocationCycles(locationId);
        setCycles(cyclesData);

        // Fetch academy slugs for academy-owned cycles
        const academyOwnerIds = [...new Set(cyclesData.filter(c => c.owner_type === 'academy').map(c => c.owner_id))];
        if (academyOwnerIds.length > 0) {
          const { data: academies } = await supabase
            .from('academy_profiles')
            .select('id, slug')
            .in('id', academyOwnerIds);
          if (academies) {
            const slugMap: Record<string, string> = {};
            academies.forEach(a => { slugMap[a.id] = a.slug; });
            setAcademySlugs(slugMap);
          }
        }

        // Fetch academy slugs for trainer-owned cycles via the anon-readable view.
        // The slug is resolved through academy_profiles_public because neither the
        // academy_trainers nor academy_profiles base tables are anon-readable.
        const trainerOwnerIds = [...new Set(cyclesData.filter(c => c.owner_type === 'trainer').map(c => c.owner_id))];
        if (trainerOwnerIds.length > 0) {
          const { data: trainerAcademies } = await supabase
            .from('academy_trainers_public')
            .select('trainer_profile_id, academy_profile_id')
            .in('trainer_profile_id', trainerOwnerIds);
          if (trainerAcademies && trainerAcademies.length > 0) {
            const academyIds = [...new Set(
              trainerAcademies.map(ta => ta.academy_profile_id).filter((id): id is string => Boolean(id)),
            )];
            const { data: academies } = await supabase
              .from('academy_profiles_public')
              .select('id, slug')
              .in('id', academyIds);
            const slugById = new Map((academies || []).map(a => [a.id, a.slug]));
            const tMap: Record<string, string> = {};
            trainerAcademies.forEach(ta => {
              const tpid = ta.trainer_profile_id;
              const slug = slugById.get(ta.academy_profile_id);
              if (tpid && slug) tMap[tpid] = slug;
            });
            setTrainerAcademySlugs(tMap);
          }
        }

        if (user && cyclesData.length > 0) {
          const appliedSet = new Set<string>();
          for (const cycle of cyclesData) {
            const applied = await hasPlayerApplied(cycle.id, user.id);
            if (applied) appliedSet.add(cycle.id);
          }
          setAppliedCycles(appliedSet);
        }
      } catch (error) {
        logger.error('Error fetching open cycles', error instanceof Error ? error : new Error(String(error)), { component: 'LocationOpenCycles' });
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [locationId, user]);

  const getRegisterPath = (cycle: Cycle) => {
    const currentLang = lang || i18n.language;
    if (cycle.owner_type === 'club' && clubSlug) {
      return getMarketingPath(`clubs/${clubSlug}/register/${cycle.id}`, currentLang);
    }
    if (cycle.owner_type === 'academy' && academySlugs[cycle.owner_id]) {
      return getMarketingPath(`academies/${academySlugs[cycle.owner_id]}/register/${cycle.id}`, currentLang);
    }
    if (cycle.owner_type === 'trainer' && trainerAcademySlugs[cycle.owner_id]) {
      return getMarketingPath(`academies/${trainerAcademySlugs[cycle.owner_id]}/register/${cycle.id}`, currentLang);
    }
    return getMarketingPath(`register/${cycle.id}`, currentLang);
  };

  if (loading || cycles.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold flex items-center gap-2">
        <Calendar className="h-6 w-6 text-primary" />
        {t('registration.openCycles', 'Open for Registration')}
      </h2>

      <div className="space-y-4">
        {cycles.map(cycle => {
          const hasApplied = appliedCycles.has(cycle.id);
          const canApply = !hasApplied;

          return (
            <div key={cycle.id} className="border rounded-lg p-4 bg-card">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0 flex-1">
                  <h4 className="font-medium">{cycle.name}</h4>
                  <div className="flex flex-wrap gap-3 mt-1 text-sm text-muted-foreground">
                    {cycle.is_always_open ? (
                      <Badge variant="secondary" className="text-xs">
                        {t('alwaysOpen.badge', 'Always open')}
                      </Badge>
                    ) : (
                      <>
                        <span className="flex items-center gap-1">
                          <Calendar className="h-4 w-4" />
                          {cycle.start_date && cycle.end_date && (
                            <>{format(new Date(cycle.start_date), 'd MMM', { locale: dateLocale })} - {format(new Date(cycle.end_date), 'd MMM yyyy', { locale: dateLocale })}</>
                          )}
                        </span>
                        {cycle.enrollment_deadline && (
                          <span className="flex items-center gap-1 text-orange-600 dark:text-orange-400">
                            <Clock className="h-4 w-4" />
                            {t('registration.deadline', 'Deadline')}: {format(new Date(cycle.enrollment_deadline), 'd MMM yyyy', { locale: dateLocale })}
                          </span>
                        )}
                      </>
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
                      {t('application.apply', 'Apply')}
                      <ExternalLink className="h-4 w-4 ml-1" />
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
