import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { format, addMonths, subMonths } from 'date-fns';
import { nl, es, de, fr, enUS, it as itLocale, type Locale } from 'date-fns/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';
import { fetchLinkedGuestBookingRows } from '@/lib/playerBookings';
import { logger } from '@/lib/logger';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { surfaceCardClass } from '@/components/ui/app-page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import AgendaMonth from '@/components/agenda/AgendaMonth';
import type { AgendaSlot } from '@/components/agenda/AgendaWeekByTrainer';

const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS, it: itLocale };

/** Raw shape of a non-cancelled booking joined to its availability slot. */
interface BookingSlotRow {
  status: string;
  availability_slots: {
    start_time: string;
    end_time: string;
    trainer_id: string | null;
    max_participants: number | null;
    location_id: string | null;
    locations: { name: string } | null;
  } | null;
}

export default function PlayerAgenda() {
  const { t, i18n } = useTranslation('player');
  const { user, profile, loading } = useAuth();
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;

  const [currentDate, setCurrentDate] = useState(new Date());
  const [slots, setSlots] = useState<AgendaSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(true);

  const fetchSlots = useCallback(async (playerId: string) => {
    setLoadingSlots(true);
    // Linked-guest visibility (rebook go-live B2): also surface sessions booked on behalf of this
    // player under a guest record linked to their profile (academy add / captain rebook). The
    // player_id query is untouched; the supplementary linked-guest rows are best-effort (never
    // block the player's own agenda) and arrive as a superset of BookingSlotRow's fields.
    const [{ data, error }, guestRows] = await Promise.all([
      supabase
        .from('bookings')
        .select(`
          status,
          availability_slots(
            start_time,
            end_time,
            trainer_id,
            max_participants,
            location_id,
            locations(name)
          )
        `)
        .eq('player_id', playerId)
        .neq('status', 'cancelled'),
      fetchLinkedGuestBookingRows(),
    ]);

    if (error) {
      logger.error('Failed to load player agenda bookings', new Error(error.message), {
        component: 'PlayerAgenda',
        code: error.code,
        details: error.details,
      });
      setSlots([]);
      setLoadingSlots(false);
      return;
    }

    const guestActive = (guestRows as unknown as BookingSlotRow[]).filter((r) => r.status !== 'cancelled');
    const rows = [...((data as unknown as BookingSlotRow[] | null) || []), ...guestActive];
    const validRows = rows.filter((r) => r.availability_slots?.start_time);

    const trainerIds = [
      ...new Set(
        validRows
          .map((r) => r.availability_slots?.trainer_id)
          .filter((id): id is string => !!id),
      ),
    ];

    const nameByTrainerId = trainerIds.length > 0
      ? await fetchTrainerDisplayNamesByProfileIds(trainerIds, supabase, 'PlayerAgenda')
      : new Map<string, string>();

    const mapped: AgendaSlot[] = validRows.map((r, idx) => {
      const s = r.availability_slots!;
      return {
        id: `${s.trainer_id ?? 'na'}-${s.start_time}-${idx}`,
        start_time: s.start_time,
        end_time: s.end_time,
        trainer_id: s.trainer_id,
        trainer_name: (s.trainer_id && nameByTrainerId.get(s.trainer_id)) || t('agenda.trainerFallback', 'Trainer'),
        trainer_avatar: null,
        max_participants: s.max_participants ?? 0,
        booked_count: 1,
        location_id: s.location_id,
        location_name: s.locations?.name ?? null,
        location_logo: null,
        is_public: true,
      };
    });

    setSlots(mapped);
    setLoadingSlots(false);
  }, [t]);

  useEffect(() => {
    if (user && profile?.id) {
      fetchSlots(profile.id);
    }
  }, [user, profile?.id, fetchSlots]);

  if (loading || loadingSlots) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }

  const monthLabel = format(currentDate, 'MMMM yyyy', { locale: dateFnsLocale });

  const monthNav = (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => setCurrentDate(subMonths(currentDate, 1))}
        aria-label={t('agenda.previousMonth', 'Previous month')}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="min-w-[10ch] text-center text-sm font-medium capitalize tabular-nums">
        {monthLabel}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => setCurrentDate(addMonths(currentDate, 1))}
        aria-label={t('agenda.nextMonth', 'Next month')}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );

  return (
    <AppPage as="main" data-testid="page-player-agenda">
      <PageHeader
        title={t('agenda.title', 'Agenda')}
        description={t('agenda.subtitle', 'Een maandoverzicht van je geplande trainingen.')}
        actions={monthNav}
      />

      {slots.length === 0 ? (
        <Card className={cn(surfaceCardClass(), 'p-12 text-center')}>
          <div className="mb-4 text-6xl">📅</div>
          <h3 className="mb-2 text-xl font-semibold">{t('agenda.empty', 'Nog geen geplande trainingen')}</h3>
          <p className="text-muted-foreground">
            {t('agenda.emptyDescription', 'Zodra je een training boekt, verschijnt die hier in je agenda.')}
          </p>
        </Card>
      ) : (
        <AgendaMonth
          slots={slots}
          currentDate={currentDate}
          onDayClick={(day) => setCurrentDate(day)}
        />
      )}
    </AppPage>
  );
}
