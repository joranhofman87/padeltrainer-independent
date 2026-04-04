import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  format, parseISO, startOfWeek, endOfWeek, addDays, isToday, isBefore,
} from 'date-fns';
import { nl, es, de, fr, enUS, type Locale } from 'date-fns/locale';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Users, Calendar, AlertTriangle, TrendingUp, MapPin } from 'lucide-react';
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
  location_id?: string | null;
}

interface TrainerOption {
  id: string;
  name: string;
}

interface LocationOption {
  id: string;
  name: string;
}

interface AcademyCalendarOverviewProps {
  slots: SlotSummary[];
  currentDate: Date;
  onDayClick?: (date: Date) => void;
  trainers?: TrainerOption[];
  locations?: LocationOption[];
}

function OccupancyBar({ booked, max }: { booked: number; max: number }) {
  const pct = max > 0 ? Math.min((booked / max) * 100, 100) : 0;
  const isFull = booked >= max;
  return (
    <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
      <div
        className={cn(
          'h-full rounded-full transition-all',
          isFull ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-muted-foreground/20',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function AcademyCalendarOverview({
  slots, currentDate, onDayClick, trainers = [], locations = [],
}: AcademyCalendarOverviewProps) {
  const { t, i18n } = useTranslation('academy');
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;
  const now = new Date();

  // Local filter state
  const [filterTrainerId, setFilterTrainerId] = useState<string>('all');
  const [filterLocationId, setFilterLocationId] = useState<string>('all');

  // Week boundaries
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });

  // Filter slots
  const filteredSlots = useMemo(() => {
    return slots.filter(s => {
      if (filterTrainerId !== 'all' && s.trainer_id !== filterTrainerId) return false;
      if (filterLocationId !== 'all' && s.location_id !== filterLocationId) return false;
      return true;
    });
  }, [slots, filterTrainerId, filterLocationId]);

  // Week days
  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  }, [weekStart]);

  // Group slots by day key
  const slotsByDay = useMemo(() => {
    const map = new Map<string, SlotSummary[]>();
    filteredSlots.forEach(s => {
      const d = parseISO(s.start_time);
      if (d >= weekStart && d <= weekEnd) {
        const key = format(d, 'yyyy-MM-dd');
        const arr = map.get(key) || [];
        arr.push(s);
        map.set(key, arr);
      }
    });
    // Sort each day's slots by time
    map.forEach((daySlots, key) => {
      daySlots.sort((a, b) => a.start_time.localeCompare(b.start_time));
    });
    return map;
  }, [filteredSlots, weekStart, weekEnd]);

  // Stats from filtered slots (week only)
  const weekSlots = useMemo(() => {
    return filteredSlots.filter(s => {
      const d = parseISO(s.start_time);
      return d >= weekStart && d <= weekEnd;
    });
  }, [filteredSlots, weekStart, weekEnd]);

  const totalSessions = weekSlots.length;
  const totalCapacity = weekSlots.reduce((s, sl) => s + sl.max_participants, 0);
  const totalBooked = weekSlots.reduce((s, sl) => s + sl.booked_count, 0);
  const fillRate = totalCapacity > 0 ? Math.round((totalBooked / totalCapacity) * 100) : 0;

  const openSpotsCount = weekSlots.filter(s => {
    const d = parseISO(s.start_time);
    return d >= now && s.booked_count < s.max_participants;
  }).length;

  return (
    <div className="space-y-4">
      {/* Stats Row */}
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

      {/* Filters */}
      {(trainers.length > 1 || locations.length > 1) && (
        <div className="flex items-center gap-2 flex-wrap">
          {locations.length > 1 && (
            <Select value={filterLocationId} onValueChange={setFilterLocationId}>
              <SelectTrigger className="w-[180px] h-8">
                <SelectValue placeholder={t('calendar.allLocations', 'All Locations')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('calendar.allLocations', 'All Locations')}</SelectItem>
                {locations.map(loc => (
                  <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {trainers.length > 1 && (
            <Select value={filterTrainerId} onValueChange={setFilterTrainerId}>
              <SelectTrigger className="w-[180px] h-8">
                <SelectValue placeholder={t('calendar.allTrainers', 'All Trainers')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('calendar.allTrainers', 'All Trainers')}</SelectItem>
                {trainers.map(tr => (
                  <SelectItem key={tr.id} value={tr.id}>{tr.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* Week Grid */}
      <Card>
        <CardContent className="p-3 sm:p-4">
          <div className="grid grid-cols-7 gap-2">
            {weekDays.map(day => {
              const dayKey = format(day, 'yyyy-MM-dd');
              const daySlots = slotsByDay.get(dayKey) || [];
              const today = isToday(day);
              const isPast = isBefore(day, new Date(format(now, 'yyyy-MM-dd')));

              return (
                <div key={dayKey} className="min-w-0">
                  {/* Day Header */}
                  <button
                    onClick={() => onDayClick?.(day)}
                    className={cn(
                      'w-full text-center py-1.5 rounded-md mb-2 transition-colors hover:bg-accent',
                      today && 'bg-primary/10 font-bold',
                    )}
                  >
                    <div className="text-[10px] uppercase text-muted-foreground">
                      {format(day, 'EEE', { locale: dateFnsLocale })}
                    </div>
                    <div className={cn('text-sm', today && 'text-primary')}>
                      {format(day, 'd')}
                    </div>
                  </button>

                  {/* Slot Cards */}
                  <ScrollArea className="max-h-[400px]">
                    <div className="space-y-1.5">
                      {daySlots.length === 0 && (
                        <div className="text-[10px] text-muted-foreground/50 text-center py-4 italic">
                          —
                        </div>
                      )}
                      {daySlots.map(slot => {
                        const isFull = slot.booked_count >= slot.max_participants;
                        const hasBookings = slot.booked_count > 0;
                        const slotPast = isBefore(parseISO(slot.start_time), now);

                        return (
                          <button
                            key={slot.id}
                            onClick={() => onDayClick?.(day)}
                            className={cn(
                              'w-full text-left p-2 rounded-md border text-xs transition-colors hover:bg-accent/50',
                              slotPast && 'opacity-50',
                              isFull && 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20',
                              !isFull && hasBookings && 'border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20',
                            )}
                          >
                            {/* Time */}
                            <div className="font-medium">
                              {format(parseISO(slot.start_time), 'HH:mm')}–{format(parseISO(slot.end_time), 'HH:mm')}
                            </div>
                            {/* Trainer */}
                            {slot.trainer_name && (
                              <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                                {slot.trainer_name}
                              </div>
                            )}
                            {/* Location */}
                            {slot.location_name && (
                              <div className="text-[10px] text-muted-foreground truncate flex items-center gap-0.5 mt-0.5">
                                <MapPin className="h-2.5 w-2.5 shrink-0" />
                                {slot.location_name}
                              </div>
                            )}
                            {/* Occupancy */}
                            <div className="mt-1.5 space-y-1">
                              <OccupancyBar booked={slot.booked_count} max={slot.max_participants} />
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] text-muted-foreground">
                                  {slot.booked_count}/{slot.max_participants}
                                </span>
                                {isFull && (
                                  <Badge variant="secondary" className="text-[8px] px-1 py-0 h-3.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                                    {t('calendar.overview.full', 'Full')}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 mt-4 pt-3 border-t text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              {t('calendar.overview.fullyBooked', 'Fully booked')}
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              {t('calendar.overview.partiallyBooked', 'Partially booked')}
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-muted-foreground/30" />
              {t('calendar.overview.noBookings', 'No bookings')}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
