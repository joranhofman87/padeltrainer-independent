import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Calendar, Clock, PartyPopper, CreditCard, Banknote, ExternalLink } from 'lucide-react';
import { getMarketingPath } from '@/lib/domains';
import CycleDetailDisplay from '@/components/cycles/CycleDetailDisplay';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { getActiveCycles, hasPlayerApplied, type Cycle } from '@/lib/cycles';

interface AcademyOpenCyclesProps {
  academyId: string;
  academyName: string;
  academySlug: string;
}

export function AcademyOpenCycles({ academyId, academyName, academySlug }: AcademyOpenCyclesProps) {
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
        const cyclesData = await getActiveCycles('academy', academyId);
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
        console.error('Error fetching academy cycles:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [academyId, user]);

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
          const canApply = !hasApplied && !deadlinePassed;

          return (
            <div key={cycle.id} className="border rounded-lg p-4">
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
                  <CycleDetailDisplay cycle={cycle} />
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
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => navigate(getMarketingPath(`academies/${academySlug}/register/${cycle.id}`, lang || i18n.language))}
                    >
                      {t('application.apply', 'Apply')} <ExternalLink className="h-4 w-4 ml-1" />
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
