import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  format, parseISO, startOfWeek, endOfWeek, addDays, isToday, isBefore,
} from 'date-fns';
import { nl, es, de, fr, enUS, type Locale } from 'date-fns/locale';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { Users, Calendar, AlertTriangle, TrendingUp, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS };

interface SlotSummary {
  id: string;
  start_time: string;
  end_time: string;
  trainer_name?: string;
  trainer_id?: string;
  trainer_avatar?: string | null;
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
  
}

function CompactSlotCard({ slot, isPast }: { slot: SlotSummary; isPast: boolean }) {
  const effectivelyFull = slot.is_marked_full || slot.booked_count >= slot.max_participants;
  const hasBookings = slot.booked_count > 0;
  const initials = slot.trainer_name?.split(' ').map(n => n[0]).join('').toUpperCase() || '?';

  const tooltipText = [
    slot.trainer_name,
    slot.location_name,
    `${slot.booked_count}/${slot.max_participants} players`,
  ].filter(Boolean).join(' · ');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-1.5 px-1.5 py-1 rounded-md text-xs transition-colors h-[30px]',
            'border-l-[3px]',
            isPast && 'opacity-50',
            effectivelyFull
              ? 'border-l-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20'
              : hasBookings
                ? 'border-l-amber-500 bg-amber-50/50 dark:bg-amber-950/20'
                : 'border-l-muted-foreground/20 bg-muted/30',
          )}
        >
          <Avatar className="h-5 w-5 shrink-0">
            <AvatarImage src={slot.trainer_avatar || undefined} alt={slot.trainer_name} />
            <AvatarFallback className="text-[7px] bg-muted">{initials}</AvatarFallback>
          </Avatar>
          <span className="font-medium truncate">
            {format(parseISO(slot.start_time), 'HH:mm')}–{format(parseISO(slot.end_time), 'HH:mm')}
          </span>
          <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
            {slot.booked_count}/{slot.max_participants}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
}

export default function AcademyCalendarOverview({
  slots, currentDate, onDayClick, trainers = [], locations = [],
  onNavigatePrevious, onNavigateNext, onGoToday, dateRangeLabel,
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

  const weekSlots = useMemo(() => {
    return filteredSlots.filter(s => {
      const d = parseISO(s.start_time);
      return d >= weekStart && d <= weekEnd;
    });
  }, [filteredSlots, weekStart, weekEnd]);

  // Group slots by day, sorted by start_time
  const slotsByDay = useMemo(() => {
    const map = new Map<string, SlotSummary[]>();
    weekDays.forEach(d => map.set(format(d, 'yyyy-MM-dd'), []));
    weekSlots.forEach(s => {
      const dayKey = format(parseISO(s.start_time), 'yyyy-MM-dd');
      map.get(dayKey)?.push(s);
    });
    map.forEach(daySlots => daySlots.sort((a, b) => a.start_time.localeCompare(b.start_time)));
    return map;
  }, [weekSlots, weekDays]);

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
    <TooltipProvider delayDuration={200}>
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

        {/* Week Day-Column Grid */}
        <Card>
          <CardContent className="p-3 sm:p-4">
            <ScrollArea className="w-full">
              <div className="grid grid-cols-7 gap-1 min-w-[600px]">
                {weekDays.map(day => {
                  const dayKey = format(day, 'yyyy-MM-dd');
                  const today = isToday(day);
                  const daySlots = slotsByDay.get(dayKey) || [];

                  return (
                    <div key={dayKey} className="min-w-0">
                      {/* Day header */}
                      <button
                        onClick={() => onDayClick?.(day)}
                        className={cn(
                          'w-full text-center py-2 rounded-lg transition-colors hover:bg-accent mb-1',
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

                      {/* Slot cards */}
                      <div className="space-y-0.5">
                        {daySlots.map(slot => (
                          <button
                            key={slot.id}
                            className="w-full text-left cursor-pointer"
                            onClick={() => onDayClick?.(day)}
                          >
                            <CompactSlotCard
                              slot={slot}
                              isPast={isBefore(parseISO(slot.start_time), now)}
                            />
                          </button>
                        ))}
                        {daySlots.length === 0 && (
                          <p className="text-[10px] text-muted-foreground text-center italic py-4">—</p>
                        )}
                      </div>
                    </div>
                  );
                })}
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
    </TooltipProvider>
  );
}
