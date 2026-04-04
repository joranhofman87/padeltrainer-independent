import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  format, parseISO, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addDays, isSameMonth, isSameDay, isToday, isBefore,
} from 'date-fns';
import { nl, es, de, fr, enUS, type Locale } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Users, Calendar, AlertTriangle, TrendingUp, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS };

interface SlotSummary {
  id: string;
  start_time: string;
  end_time: string;
  trainer_name?: string;
  trainer_id?: string;
  max_participants: number;
  booked_count: number;
  location_name?: string | null;
}

interface AcademyCalendarOverviewProps {
  slots: SlotSummary[];
  currentDate: Date;
  onDayClick?: (date: Date) => void;
}

export default function AcademyCalendarOverview({
  slots, currentDate, onDayClick,
}: AcademyCalendarOverviewProps) {
  const { t, i18n } = useTranslation('academy');
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;
  const now = new Date();

  // Build month calendar grid
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });

  const calendarDays = useMemo(() => {
    const days: Date[] = [];
    let d = calStart;
    while (d <= calEnd) {
      days.push(d);
      d = addDays(d, 1);
    }
    return days;
  }, [calStart, calEnd]);

  // Index slots by day
  const slotsByDay = useMemo(() => {
    const map = new Map<string, SlotSummary[]>();
    slots.forEach(s => {
      const key = format(parseISO(s.start_time), 'yyyy-MM-dd');
      const arr = map.get(key) || [];
      arr.push(s);
      map.set(key, arr);
    });
    return map;
  }, [slots]);

  // Week stats (current week = week of currentDate)
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });

  const weekSlots = useMemo(() => {
    return slots.filter(s => {
      const d = parseISO(s.start_time);
      return d >= weekStart && d <= weekEnd;
    });
  }, [slots, weekStart, weekEnd]);

  const totalSessions = weekSlots.length;
  const totalCapacity = weekSlots.reduce((s, sl) => s + sl.max_participants, 0);
  const totalBooked = weekSlots.reduce((s, sl) => s + sl.booked_count, 0);
  const fillRate = totalCapacity > 0 ? Math.round((totalBooked / totalCapacity) * 100) : 0;

  // Open spots this week (future only)
  const openSpotsCount = weekSlots.filter(s => {
    const d = parseISO(s.start_time);
    return d >= now && s.booked_count < s.max_participants;
  }).length;

  // Fully booked days
  const fullyBookedDays = useMemo(() => {
    let count = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i);
      const dayKey = format(day, 'yyyy-MM-dd');
      const daySlots = slotsByDay.get(dayKey) || [];
      if (daySlots.length > 0 && daySlots.every(s => s.booked_count >= s.max_participants)) {
        count++;
      }
    }
    return count;
  }, [weekStart, slotsByDay]);

  // Upcoming sessions (today + tomorrow)
  const upcomingSessions = useMemo(() => {
    const todayKey = format(now, 'yyyy-MM-dd');
    const tomorrowKey = format(addDays(now, 1), 'yyyy-MM-dd');
    const todaySlots = (slotsByDay.get(todayKey) || []).filter(s => parseISO(s.start_time) >= now);
    const tomorrowSlots = slotsByDay.get(tomorrowKey) || [];
    return [...todaySlots, ...tomorrowSlots]
      .sort((a, b) => a.start_time.localeCompare(b.start_time))
      .slice(0, 6);
  }, [slotsByDay, now]);

  // Day names header
  const dayNames = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) =>
      format(addDays(startOfWeek(new Date(), { weekStartsOn: 1 }), i), 'EEEEE', { locale: dateFnsLocale })
    );
  }, [dateFnsLocale]);

  function getDayOccupancy(dayKey: string): 'empty' | 'partial' | 'full' | 'none' {
    const daySlots = slotsByDay.get(dayKey) || [];
    if (daySlots.length === 0) return 'none';
    const allFull = daySlots.every(s => s.booked_count >= s.max_participants);
    if (allFull) return 'full';
    const anyBooked = daySlots.some(s => s.booked_count > 0);
    if (anyBooked) return 'partial';
    return 'empty';
  }

  return (
    <div className="space-y-6">
      {/* Week Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Calendar className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalSessions}</p>
              <p className="text-xs text-muted-foreground">{t('calendar.overview.sessionsThisWeek', 'Sessions this week')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10">
              <TrendingUp className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-2xl font-bold">{fillRate}%</p>
              <p className="text-xs text-muted-foreground">{t('calendar.overview.fillRate', 'Fill rate')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500/10">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-2xl font-bold">{openSpotsCount}</p>
              <p className="text-xs text-muted-foreground">{t('calendar.overview.openSpots', 'Slots with open spots')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10">
              <Users className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalBooked}/{totalCapacity}</p>
              <p className="text-xs text-muted-foreground">{t('calendar.overview.playersBooked', 'Players booked')}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Month Mini Calendar */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {format(currentDate, 'MMMM yyyy', { locale: dateFnsLocale })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-7 gap-1">
              {/* Day name headers */}
              {dayNames.map((name, i) => (
                <div key={i} className="text-center text-[10px] font-medium text-muted-foreground uppercase py-1">
                  {name}
                </div>
              ))}
              {/* Calendar days */}
              {calendarDays.map(day => {
                const dayKey = format(day, 'yyyy-MM-dd');
                const inMonth = isSameMonth(day, currentDate);
                const today = isToday(day);
                const occupancy = getDayOccupancy(dayKey);
                const daySlotCount = (slotsByDay.get(dayKey) || []).length;

                return (
                  <button
                    key={dayKey}
                    onClick={() => onDayClick?.(day)}
                    className={cn(
                      'relative aspect-square flex flex-col items-center justify-center rounded-md text-xs transition-colors',
                      inMonth ? 'hover:bg-accent' : 'text-muted-foreground/40',
                      today && 'ring-1 ring-primary font-bold',
                    )}
                  >
                    <span>{format(day, 'd')}</span>
                    {daySlotCount > 0 && (
                      <div className="flex gap-0.5 mt-0.5">
                        <div className={cn(
                          'w-1.5 h-1.5 rounded-full',
                          occupancy === 'full' ? 'bg-emerald-500' :
                          occupancy === 'partial' ? 'bg-amber-500' :
                          'bg-muted-foreground/30',
                        )} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {/* Legend */}
            <div className="flex items-center gap-4 mt-3 pt-3 border-t text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> {t('calendar.overview.fullyBooked', 'Fully booked')}</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> {t('calendar.overview.partiallyBooked', 'Partially booked')}</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/30" /> {t('calendar.overview.noBookings', 'No bookings')}</span>
            </div>
          </CardContent>
        </Card>

        {/* Upcoming Sessions */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('calendar.overview.upcoming', 'Upcoming')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {upcomingSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">{t('calendar.overview.noUpcoming', 'No upcoming sessions')}</p>
            ) : (
              upcomingSessions.map(s => {
                const startDate = parseISO(s.start_time);
                const isSessionToday = isSameDay(startDate, now);
                return (
                  <div key={s.id} className="flex items-center gap-2 p-2 rounded-md border text-xs">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge variant={isSessionToday ? 'default' : 'secondary'} className="text-[9px] px-1.5 py-0 h-4">
                          {isSessionToday ? t('calendar.overview.today', 'Today') : t('calendar.overview.tomorrow', 'Tomorrow')}
                        </Badge>
                        <span className="font-medium">
                          {format(startDate, 'HH:mm')}–{format(parseISO(s.end_time), 'HH:mm')}
                        </span>
                      </div>
                      {s.trainer_name && (
                        <p className="text-muted-foreground truncate mt-0.5">{s.trainer_name}</p>
                      )}
                    </div>
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      <Users className="h-2.5 w-2.5 mr-0.5" />
                      {s.booked_count}/{s.max_participants}
                    </Badge>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>

      {/* Alerts */}
      {(openSpotsCount > 0 || fullyBookedDays > 0) && (
        <div className="flex flex-wrap gap-3">
          {openSpotsCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span>{openSpotsCount} {t('calendar.overview.slotsWithOpenSpots', 'slots with open spots this week')}</span>
            </div>
          )}
          {fullyBookedDays > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 text-sm">
              <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>{fullyBookedDays} {t('calendar.overview.fullyBookedDays', 'fully booked days')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
