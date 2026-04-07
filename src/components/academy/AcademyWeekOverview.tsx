import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO, startOfWeek, addDays, getDay } from 'date-fns';
import { nl, es, de, fr, enUS, type Locale } from 'date-fns/locale';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Users, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type SlotWithBookings } from '@/components/trainer/CalendarSlotCard';

const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS, it };

interface AcademyWeekOverviewProps {
  slots: SlotWithBookings[];
  currentDate: Date;
  trainers: { id: string; name: string; avatar: string | null }[];
  onDayClick?: (date: Date) => void;
}

export default function AcademyWeekOverview({
  slots, currentDate, trainers, onDayClick,
}: AcademyWeekOverviewProps) {
  const { i18n } = useTranslation();
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;

  const weekStart = useMemo(() => startOfWeek(currentDate, { weekStartsOn: 1 }), [currentDate]);
  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      return {
        date,
        dayKey: format(date, 'yyyy-MM-dd'),
        label: format(date, 'EEE', { locale: dateFnsLocale }),
        dateLabel: format(date, 'd MMM', { locale: dateFnsLocale }),
        isToday: format(date, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd'),
      };
    });
  }, [weekStart, dateFnsLocale]);

  const slotsByDay = useMemo(() => {
    const map = new Map<string, SlotWithBookings[]>();
    weekDays.forEach(d => map.set(d.dayKey, []));
    slots.forEach(slot => {
      const dayKey = format(parseISO(slot.start_time), 'yyyy-MM-dd');
      const existing = map.get(dayKey);
      if (existing) existing.push(slot);
    });
    // Sort each day's slots
    map.forEach(daySlots => daySlots.sort((a, b) => a.start_time.localeCompare(b.start_time)));
    return map;
  }, [slots, weekDays]);

  const trainerMap = useMemo(() => new Map(trainers.map(t => [t.id, t])), [trainers]);

  return (
    <div className={cn('grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2')}>
      {weekDays.map(day => {
        const daySlots = slotsByDay.get(day.dayKey) || [];
        const totalPlayers = daySlots.reduce((s, sl) => s + sl.booked_players.length, 0);

        return (
          <div
            key={day.dayKey}
            className={cn(
              'border rounded-lg p-2 space-y-2 cursor-pointer hover:border-primary/50 transition-colors min-h-[120px]',
              day.isToday && 'ring-1 ring-primary/30 bg-primary/5',
            )}
            onClick={() => onDayClick?.(day.date)}
          >
            {/* Day header */}
            <div className="text-center">
              <p className="text-xs font-semibold capitalize">{day.label}</p>
              <p className="text-[10px] text-muted-foreground">{day.dateLabel}</p>
            </div>

            {/* Stats */}
            <div className="flex items-center justify-center gap-2 text-[10px] text-muted-foreground">
              <span>{daySlots.length} slots</span>
              <span>·</span>
              <span>{totalPlayers} <Users className="h-2.5 w-2.5 inline" /></span>
            </div>

            {/* Slot cards */}
            <div className="space-y-1">
              {daySlots.map(slot => {
                const trainer = slot.trainer_id ? trainerMap.get(slot.trainer_id) : null;
                const initials = trainer?.name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'T';
                const maxP = slot.max_participants || 4;
                const currentP = slot.booked_players.length;

                return (
                  <div
                    key={slot.id}
                    className={cn(
                      'rounded border p-1.5 text-[10px] space-y-0.5',
                      currentP >= maxP ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/20' :
                      currentP > 0 ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/20' :
                      'border-border',
                    )}
                  >
                    <div className="flex items-center gap-1">
                      <Avatar className="h-4 w-4">
                        <AvatarImage src={trainer?.avatar || undefined} alt={trainer?.name} />
                        <AvatarFallback className="text-[6px]">{initials}</AvatarFallback>
                      </Avatar>
                      <span className="font-medium truncate">
                        {format(parseISO(slot.start_time), 'HH:mm')}–{format(parseISO(slot.end_time), 'HH:mm')}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Users className="h-2.5 w-2.5" />
                      <span>{currentP}/{maxP}</span>
                    </div>
                  </div>
                );
              })}

              {daySlots.length === 0 && (
                <p className="text-[10px] text-muted-foreground text-center italic">—</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
