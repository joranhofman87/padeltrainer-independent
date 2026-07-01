import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { addMonths, format, parseISO, startOfMonth } from 'date-fns';
import { nl, es, de, fr, enUS, it as itLocale, type Locale } from 'date-fns/locale';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import AgendaMonth from '@/components/agenda/AgendaMonth';
import type { AgendaSlot } from '@/components/agenda/AgendaWeekByTrainer';
import { PublicSlotRow } from './PublicSlotRow';
import { usePublicAvailability, type AvailabilityOwner } from '@/hooks/usePublicAvailability';
import { zonedDateKey } from '@/lib/zonedFormat';
import type { PublicSlot } from '@/lib/publicAvailability';

const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS, it: itLocale };

interface AvailabilityCalendarProps {
  /** Whose availability to show (academy / trainer). */
  owner: AvailabilityOwner;
  /** Called when a visitor taps a slot to book it (single or cyclus). */
  onSelect: (slot: PublicSlot) => void;
  /** Owner IANA timezone so day grouping + times are academy-local, not browser-local. */
  timezone?: string;
  className?: string;
}

/**
 * Public availability as a two-pane MONTH CALENDAR (Calendly-style): the month grid on the left
 * (days marked with session count + free-spots), and the selected day's bookable slots in a panel on
 * the RIGHT on desktop / BELOW on mobile. The first available day is pre-selected; tapping a slot
 * delegates to the caller's booking flow (guest pay-first dialog). Reuses the admin {@link AgendaMonth}
 * grid + the shared {@link PublicSlotRow}. Owner-timezone-correct; renders nothing until there is availability.
 */
export function AvailabilityCalendar({
  owner,
  onSelect,
  timezone = 'Europe/Amsterdam',
  className,
}: AvailabilityCalendarProps) {
  const { t, i18n } = useTranslation('common');
  const { dayGroups, loading } = usePublicAvailability(owner);
  const slots = useMemo(() => dayGroups.flatMap((g) => g.slots), [dayGroups]);
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;

  const [currentDate, setCurrentDate] = useState<Date>(() => startOfMonth(new Date()));
  const [selectedKey, setSelectedKey] = useState<string | null>(null); // owner-tz yyyy-MM-dd
  const jumpedToFirstMonth = useRef(false);

  // Jump to the first month that actually has availability (once, when slots load).
  useEffect(() => {
    if (!jumpedToFirstMonth.current && slots.length) {
      jumpedToFirstMonth.current = true;
      setCurrentDate(startOfMonth(new Date(slots[0].start_time)));
    }
  }, [slots]);

  // Pre-select the first available day in the visible month, and re-select on month nav.
  useEffect(() => {
    const monthPrefix = format(currentDate, 'yyyy-MM');
    const firstInMonth = slots.map((s) => zonedDateKey(s.start_time, timezone)).find((k) => k.startsWith(monthPrefix));
    setSelectedKey(firstInMonth ?? null);
  }, [currentDate, slots, timezone]);

  const agendaSlots: AgendaSlot[] = useMemo(
    () =>
      slots.map((s) => ({
        id: s.id,
        start_time: s.start_time,
        end_time: s.end_time,
        trainer_id: s.trainer_id,
        trainer_name: s.trainer_name ?? '',
        trainer_avatar: null,
        max_participants: s.max_participants,
        booked_count: Math.max(0, s.max_participants - s.spots_left),
        location_id: null,
        location_name: s.location_name,
        location_logo: null,
        is_public: true, // everything here already passed the public-visibility filter
      })),
    [slots],
  );

  const daySlots = useMemo(
    () => (selectedKey ? slots.filter((s) => zonedDateKey(s.start_time, timezone) === selectedKey) : []),
    [selectedKey, slots, timezone],
  );

  if (loading) {
    return (
      <Card className={className}>
        <CardContent className="p-4">
          <Skeleton className="h-8 w-40 mb-3" />
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (slots.length === 0) return null;

  // AgendaMonth keys its cells by the calendar date string; a slot's owner-tz date key matches that.
  const handleDayClick = (day: Date) => setSelectedKey(format(day, 'yyyy-MM-dd'));
  const dayTitle = selectedKey ? format(parseISO(selectedKey), 'EEEE d MMMM', { locale: dateFnsLocale }) : '';

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-primary" />
          {t('booking.pickTitle', 'Boek een training')}
        </CardTitle>
        <CardDescription>{t('booking.pickSubtitle', 'Kies een dag en tijd die jou uitkomt')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 md:flex-row">
          {/* Calendar (left on desktop) */}
          <div className="min-w-0 space-y-3 md:flex-1">
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t('booking.calendar.prevMonth', 'Vorige maand')}
                onClick={() => setCurrentDate((d) => addMonths(d, -1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-semibold capitalize">{format(currentDate, 'MMMM yyyy', { locale: dateFnsLocale })}</span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t('booking.calendar.nextMonth', 'Volgende maand')}
                onClick={() => setCurrentDate((d) => addMonths(d, 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <AgendaMonth slots={agendaSlots} currentDate={currentDate} timezone={timezone} onDayClick={handleDayClick} selectedKey={selectedKey} />
          </div>

          {/* Day detail (right on desktop, below on mobile) */}
          <div className="md:w-72 md:shrink-0 md:border-l md:pl-4">
            <p className="mb-2 text-sm font-semibold capitalize">{dayTitle || t('booking.pickDay', 'Kies een dag')}</p>
            {daySlots.length > 0 ? (
              <div className="space-y-2" role="list">
                {daySlots.map((slot) => (
                  <PublicSlotRow key={slot.id} slot={slot} timezone={timezone} onSelect={onSelect} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('booking.calendar.noSessions', 'Geen sessies op deze dag.')}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
