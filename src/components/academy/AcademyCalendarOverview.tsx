import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  format, parseISO, startOfWeek, endOfWeek, addDays, isToday, isBefore,
} from 'date-fns';
import { nl, es, de, fr, enUS, type Locale } from 'date-fns/locale';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Users, Calendar, AlertTriangle, TrendingUp, MapPin, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
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
  is_marked_full?: boolean;
}

interface TrainerOption { id: string; name: string; }
interface LocationOption { id: string; name: string; }

interface AcademyCalendarOverviewProps {
  slots: SlotSummary[];
  currentDate: Date;
  onDayClick?: (date: Date) => void;
  trainers?: TrainerOption[];
  locations?: LocationOption[];
  onNavigatePrevious: () => void;
  onNavigateNext: () => void;
  onGoToday: () => void;
  dateRangeLabel: string;
  onNewClick?: () => void;
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

function SlotCard({ slot, now, onDayClick, day, t }: {
  slot: SlotSummary; now: Date; onDayClick?: (d: Date) => void; day: Date;
  t: (key: string, fallback: string) => string;
}) {
  const effectivelyFull = slot.is_marked_full || slot.booked_count >= slot.max_participants;
  const hasBookings = slot.booked_count > 0;
  const slotPast = isBefore(parseISO(slot.start_time), now);

  return (
    <button
      onClick={() => onDayClick?.(day)}
      className={cn(
        'w-full text-left p-2 rounded-lg border text-xs transition-colors hover:bg-accent/50',
        slotPast && 'opacity-50',
        effectivelyFull && 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20',
        !effectivelyFull && hasBookings && 'border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20',
        !effectivelyFull && !hasBookings && 'border-border',
      )}
    >
      <div className="font-medium">
        {format(parseISO(slot.start_time), 'HH:mm')}–{format(parseISO(slot.end_time), 'HH:mm')}
      </div>
      {slot.trainer_name && (
        <div className="text-[10px] text-muted-foreground truncate mt-0.5">
          {slot.trainer_name}
        </div>
      )}
      {slot.location_name && (
        <div className="text-[10px] text-muted-foreground truncate flex items-center gap-0.5 mt-0.5">
          <MapPin className="h-2.5 w-2.5 shrink-0" />
          {slot.location_name}
        </div>
      )}
      <div className="mt-1.5 space-y-1">
        {!slot.is_marked_full && (
          <OccupancyBar booked={slot.booked_count} max={slot.max_participants} />
        )}
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            {slot.booked_count}/{slot.max_participants}
          </span>
          {effectivelyFull && (
            <Badge variant="secondary" className="text-[8px] px-1 py-0 h-3.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              {t('calendar.overview.full', 'Full')}
            </Badge>
          )}
        </div>
      </div>
    </button>
  );
}

export default function AcademyCalendarOverview({
  slots, currentDate, onDayClick, trainers = [], locations = [],
  onNavigatePrevious, onNavigateNext, onGoToday, dateRangeLabel, onNewClick,
}: AcademyCalendarOverviewProps) {
  const { t, i18n } = useTranslation('academy');
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;
  const now = new Date();

  const [filterTrainerId, setFilterTrainerId] = useState<string>('all');
  const [filterLocationId, setFilterLocationId] = useState<string>('all');

  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });

  const filteredSlots = useMemo(() => {
    return slots.filter(s => {
      if (filterTrainerId !== 'all' && s.trainer_id !== filterTrainerId) return false;
      if (filterLocationId !== 'all' && s.location_id !== filterLocationId) return false;
      return true;
    });
  }, [slots, filterTrainerId, filterLocationId]);

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  }, [weekStart]);

  // Group slots by day+time for time-row grid
  const weekSlots = useMemo(() => {
    return filteredSlots.filter(s => {
      const d = parseISO(s.start_time);
      return d >= weekStart && d <= weekEnd;
    });
  }, [filteredSlots, weekStart, weekEnd]);

  // Unique time slots sorted chronologically
  const uniqueTimes = useMemo(() => {
    const times = new Set<string>();
    weekSlots.forEach(s => times.add(format(parseISO(s.start_time), 'HH:mm')));
    return Array.from(times).sort();
  }, [weekSlots]);

  // Map: dayKey -> timeKey -> SlotSummary[]
  const slotGrid = useMemo(() => {
    const map = new Map<string, Map<string, SlotSummary[]>>();
    weekSlots.forEach(s => {
      const d = parseISO(s.start_time);
      const dayKey = format(d, 'yyyy-MM-dd');
      const timeKey = format(d, 'HH:mm');
      if (!map.has(dayKey)) map.set(dayKey, new Map());
      const dayMap = map.get(dayKey)!;
      if (!dayMap.has(timeKey)) dayMap.set(timeKey, []);
      dayMap.get(timeKey)!.push(s);
    });
    return map;
  }, [weekSlots]);

  // Stats
  const totalSessions = weekSlots.length;
  const totalCapacity = weekSlots.reduce((s, sl) => s + sl.max_participants, 0);
  const totalBooked = weekSlots.reduce((s, sl) => s + sl.booked_count, 0);
  const fillRate = totalCapacity > 0 ? Math.round((totalBooked / totalCapacity) * 100) : 0;
  const openSpotsCount = weekSlots.filter(s => {
    const d = parseISO(s.start_time);
    return d >= now && !s.is_marked_full && s.booked_count < s.max_participants;
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

      {/* Navigation + Filters Row */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={onNavigatePrevious}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-[140px] text-center font-medium text-sm">
            {dateRangeLabel}
          </div>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={onNavigateNext}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={onGoToday}>
            {t('calendar.today', 'Today')}
          </Button>
          {onNewClick && (
            <Button size="sm" className="h-8 gap-1.5" onClick={onNewClick}>
              <Plus className="h-3.5 w-3.5" />
              {t('calendar.new', 'New')}
            </Button>
          )}
        </div>

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
      </div>

      {/* Week Time-Row Grid */}
      <Card>
        <CardContent className="p-3 sm:p-4">
          <ScrollArea className="w-full">
            <div className="min-w-[700px]">
              {/* Day headers */}
              <div className="grid grid-cols-[60px_repeat(7,1fr)] gap-px mb-px">
                <div />
                {weekDays.map(day => {
                  const today = isToday(day);
                  return (
                    <button
                      key={format(day, 'yyyy-MM-dd')}
                      onClick={() => onDayClick?.(day)}
                      className={cn(
                        'text-center py-2 rounded-t-lg transition-colors hover:bg-accent',
                        today && 'bg-primary/10',
                      )}
                    >
                      <div className="text-[10px] uppercase text-muted-foreground tracking-wide">
                        {format(day, 'EEE', { locale: dateFnsLocale })}
                      </div>
                      <div className={cn('text-sm font-medium', today && 'text-primary font-bold')}>
                        {format(day, 'd')}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Time rows */}
              {uniqueTimes.length === 0 && (
                <div className="text-center text-muted-foreground text-sm py-12 italic">
                  {t('calendar.overview.noSessions', 'No sessions this week')}
                </div>
              )}
              {uniqueTimes.map(timeKey => (
                <div key={timeKey} className="grid grid-cols-[60px_repeat(7,1fr)] gap-px border-t border-border">
                  {/* Time label */}
                  <div className="py-2 pr-2 text-right text-xs text-muted-foreground font-medium">
                    {timeKey}
                  </div>
                  {/* Day cells */}
                  {weekDays.map(day => {
                    const dayKey = format(day, 'yyyy-MM-dd');
                    const cellSlots = slotGrid.get(dayKey)?.get(timeKey) || [];
                    return (
                      <div key={dayKey} className="p-1 min-h-[48px]">
                        <div className="space-y-1">
                          {cellSlots.map(slot => (
                            <SlotCard
                              key={slot.id}
                              slot={slot}
                              now={now}
                              onDayClick={onDayClick}
                              day={day}
                              t={t}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </ScrollArea>

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
