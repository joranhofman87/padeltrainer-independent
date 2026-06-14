import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { startOfWeek, endOfWeek, addWeeks, format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { AgendaList } from '@/components/agenda/AgendaList';
import { useTrainerAgenda } from '@/lib/agendaSlots';

export default function TrainerAgenda() {
  const { t, i18n } = useTranslation('common');
  const { user } = useAuth();
  const locale = i18n.language === 'nl' ? nl : enUS;
  const [weekOffset, setWeekOffset] = useState(0);

  const weekStart = startOfWeek(addWeeks(new Date(), weekOffset), { weekStartsOn: 1 });
  const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
  const { data: slots = [], isLoading } = useTrainerAgenda(
    user?.id,
    weekStart.toISOString(),
    weekEnd.toISOString(),
  );

  const rangeLabel = `${format(weekStart, 'd MMM', { locale })} – ${format(weekEnd, 'd MMM yyyy', { locale })}`;

  return (
    <AppPage>
      <PageHeader
        title={t('agenda.title', 'Agenda')}
        description={t('agenda.trainerSubtitle', "What's coming up for you this week")}
      />
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={() => setWeekOffset((o) => o - 1)} aria-label={t('agenda.prevWeek', 'Previous week')}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tabular-nums">{rangeLabel}</span>
          {weekOffset !== 0 && (
            <Button variant="ghost" size="sm" onClick={() => setWeekOffset(0)}>
              {t('agenda.thisWeek', 'This week')}
            </Button>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => setWeekOffset((o) => o + 1)} aria-label={t('agenda.nextWeek', 'Next week')}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <AgendaList slots={slots} basePath="/app/trainer" showTodaySection={weekOffset === 0} />
      )}
    </AppPage>
  );
}
