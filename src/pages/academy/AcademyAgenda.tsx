import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { startOfWeek, endOfWeek, addWeeks, format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { supabase } from '@/lib/supabaseClient';
import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AgendaList } from '@/components/agenda/AgendaList';
import { useAcademyAgenda } from '@/lib/agendaSlots';

export default function AcademyAgenda() {
  const { t, i18n } = useTranslation('common');
  const { activeAcademy } = useAcademyContext();
  const locale = i18n.language === 'nl' ? nl : enUS;
  const [weekOffset, setWeekOffset] = useState(0);
  const [trainerFilter, setTrainerFilter] = useState<string>('all');

  const weekStart = startOfWeek(addWeeks(new Date(), weekOffset), { weekStartsOn: 1 });
  const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });

  const { data: trainers = [] } = useQuery({
    queryKey: ['academy-agenda-trainers', activeAcademy?.id],
    queryFn: async () => {
      if (!activeAcademy?.id) return [];
      const { data } = await supabase
        .from('academy_trainers')
        .select('trainer_profile_id')
        .eq('academy_profile_id', activeAcademy.id)
        .eq('status', 'active');
      const ids = (data ?? []).map((r) => (r as { trainer_profile_id: string }).trainer_profile_id);
      if (ids.length === 0) return [];
      const names = await fetchTrainerDisplayNamesByProfileIds(ids, supabase, 'AcademyAgenda');
      return ids.map((id) => ({ id, name: names[id] ?? 'Trainer' })).sort((a, b) => a.name.localeCompare(b.name));
    },
    enabled: !!activeAcademy?.id,
  });

  const { data: slots = [], isLoading } = useAcademyAgenda(
    activeAcademy?.id,
    weekStart.toISOString(),
    weekEnd.toISOString(),
    trainerFilter === 'all' ? null : trainerFilter,
  );

  const rangeLabel = `${format(weekStart, 'd MMM', { locale })} – ${format(weekEnd, 'd MMM yyyy', { locale })}`;

  return (
    <AppPage>
      <PageHeader
        title={t('agenda.title', 'Agenda')}
        description={t('agenda.academySubtitle', "Your academy's sessions this week")}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setWeekOffset((o) => o - 1)} aria-label={t('agenda.prevWeek', 'Previous week')}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium tabular-nums">{rangeLabel}</span>
          <Button variant="outline" size="sm" onClick={() => setWeekOffset((o) => o + 1)} aria-label={t('agenda.nextWeek', 'Next week')}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          {weekOffset !== 0 && (
            <Button variant="ghost" size="sm" onClick={() => setWeekOffset(0)}>
              {t('agenda.thisWeek', 'This week')}
            </Button>
          )}
        </div>
        <Select value={trainerFilter} onValueChange={setTrainerFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder={t('agenda.allTrainers', 'All trainers')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('agenda.allTrainers', 'All trainers')}</SelectItem>
            {trainers.map((tr) => (
              <SelectItem key={tr.id} value={tr.id}>{tr.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <AgendaList
          slots={slots}
          basePath="/app/academy"
          showTrainer={trainerFilter === 'all'}
          showTodaySection={weekOffset === 0}
        />
      )}
    </AppPage>
  );
}
