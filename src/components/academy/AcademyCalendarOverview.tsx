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
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ChevronLeft, ChevronRight, ChevronDown, Lock } from 'lucide-react';
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
  ?: boolean;
}

interface TrainerOption { id: string; name: string; }
interface LocationOption { id: string; name: string; }

interface AcademyCalendarOverviewProps {
  slots: SlotSummary[];
  currentDate: Date;
  onDayClick?: (date: Date) => void;
  onSlotClick?: (slotId: string) => void;
  trainers?: TrainerOption[];
  locations?: LocationOption[];
  onNavigatePrevious: () => void;
  onNavigateNext: () => void;
  onGoToday: () => void;
  dateRangeLabel: string;
}

/* ── Occupancy Dots ── */
function OccupancyDots({ booked, max }: { booked: number; max: number }) {
  const displayMax = Math.min(max, 6);
  const scaledBooked = max <= 6 ? booked : Math.round((booked / max) * 6);
  const filled = Math.min(scaledBooked, displayMax);

  return (
    <span className="inline-flex gap-[2px] items-center">
      {Array.from({ length: displayMax }, (_, i) => (
        <span
          key={i}
          className={cn(
            'w-[5px] h-[5px] rounded-full',
            i < filled
              ? filled === displayMax
                ? 'bg-emerald-500'
                : 'bg-amber-500'
              : 'bg-muted-foreground/20',
          )}
        />
      ))}
    </span>
  );
}

/* ── Summary status for a group of slots ── */
function getGroupStatus(slots: SlotSummary[]): 'full' | 'partial' | 'empty' {
  const allFull = slots.every(s => s. || s.booked_count >= s.max_participants);
  if (allFull) return 'full';
  const anyBooked = slots.some(s => s.booked_count > 0);
  return anyBooked ? 'partial' : 'empty';
}

const statusDotColor: Record<string, string> = {
  full: 'bg-emerald-500',
  partial: 'bg-amber-500',
  empty: 'bg-muted-foreground/30',
};

/* ── Trainer Day Block ── */
function TrainerDayBlock({
  trainerName,
  trainerAvatar,
  slots,
  isPast,
  onSlotClick,
  defaultOpen,
}: {
  trainerName: string;
  trainerAvatar?: string | null;
  slots: SlotSummary[];
  isPast: boolean;
  onSlotClick?: (slotId: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const status = getGroupStatus(slots);
  const initials = trainerName?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || '?';
  const firstName = trainerName?.split(' ')[0] || '?';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'rounded-lg border bg-card transition-colors',
          isPast && 'opacity-50',
        )}
      >
        {/* Header — always visible */}
        <CollapsibleTrigger asChild>
          <button
            className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-accent/50 rounded-t-lg transition-colors"
            onClick={(e) => {
              // Allow collapsible toggle; double-click navigates
            }}
          >
            <Avatar className="h-7 w-7 shrink-0">
              <AvatarImage src={trainerAvatar || undefined} alt={trainerName} />
              <AvatarFallback className="text-[9px] bg-muted">{initials}</AvatarFallback>
            </Avatar>
            <span className="text-xs font-medium truncate">{firstName}</span>
            <span className={cn('w-2 h-2 rounded-full shrink-0', statusDotColor[status])} />
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
              {slots.length}
            </span>
            <ChevronDown className={cn(
              'h-3 w-3 text-muted-foreground transition-transform shrink-0',
              open && 'rotate-180',
            )} />
          </button>
        </CollapsibleTrigger>

        {/* Expanded: time list */}
        <CollapsibleContent>
          <div className="px-2 pb-1.5 space-y-0.5">
            {slots.map(slot => (
              <button
                key={slot.id}
                className="w-full flex items-center justify-between gap-1 py-0.5 text-left hover:bg-accent/30 rounded px-1 transition-colors"
                onClick={() => onSlotClick?.(slot.id)}
              >
                <span className="text-[11px] text-muted-foreground tabular-nums flex items-center gap-1">
                  {slot. && <Lock className="h-2.5 w-2.5 text-amber-500" />}
                  {format(parseISO(slot.start_time), 'HH:mm')}–{format(parseISO(slot.end_time), 'HH:mm')}
                </span>
                <OccupancyDots booked={slot.booked_count} max={slot.max_participants} />
              </button>
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/* ── Main Component ── */
export default function AcademyCalendarOverview({
  slots, currentDate, onDayClick, onSlotClick, trainers = [], locations = [],
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

  // Group by day → trainer
  const groupedByDayTrainer = useMemo(() => {
    const map = new Map<string, Map<string, SlotSummary[]>>();
    weekDays.forEach(d => map.set(format(d, 'yyyy-MM-dd'), new Map()));

    weekSlots.forEach(s => {
      const dayKey = format(parseISO(s.start_time), 'yyyy-MM-dd');
      const trainerId = s.trainer_id || 'unknown';
      const dayMap = map.get(dayKey);
      if (!dayMap) return;
      if (!dayMap.has(trainerId)) dayMap.set(trainerId, []);
      dayMap.get(trainerId)!.push(s);
    });

    // Sort each trainer's slots by start_time, sort trainers by earliest slot
    map.forEach(dayMap => {
      dayMap.forEach(trainerSlots => trainerSlots.sort((a, b) => a.start_time.localeCompare(b.start_time)));
      const sorted = [...dayMap.entries()].sort((a, b) =>
        (a[1][0]?.start_time || '').localeCompare(b[1][0]?.start_time || '')
      );
      dayMap.clear();
      sorted.forEach(([k, v]) => dayMap.set(k, v));
    });

    return map;
  }, [weekSlots, weekDays]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-4">
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

        {/* Week Day-Column Grid — Trainer-Grouped */}
        <Card>
          <CardContent className="p-3 sm:p-4">
            <ScrollArea className="w-full">
              <div className="grid grid-cols-7 gap-1.5 min-w-[700px]">
                {weekDays.map(day => {
                  const dayKey = format(day, 'yyyy-MM-dd');
                  const today = isToday(day);
                  const trainerMap = groupedByDayTrainer.get(dayKey) || new Map();
                  const trainerEntries = [...trainerMap.entries()];
                  const trainerCount = trainerEntries.length;

                  return (
                    <div key={dayKey} className="min-w-0">
                      {/* Day header */}
                      <button
                        onClick={() => onDayClick?.(day)}
                        className={cn(
                          'w-full text-center py-2 rounded-lg transition-colors hover:bg-accent mb-1.5',
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

                      {/* Trainer blocks */}
                      <div className="space-y-1">
                        {trainerEntries.map(([trainerId, trainerSlots]) => (
                          <TrainerDayBlock
                            key={trainerId}
                            trainerName={trainerSlots[0]?.trainer_name || 'Unknown'}
                            trainerAvatar={trainerSlots[0]?.trainer_avatar}
                            slots={trainerSlots}
                            isPast={trainerSlots.every(s => isBefore(parseISO(s.end_time), now))}
                            onSlotClick={onSlotClick}
                            defaultOpen={trainerCount <= 3}
                          />
                        ))}
                        {trainerCount === 0 && (
                          <p className="text-[10px] text-muted-foreground text-center italic py-4">—</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>

            {/* Legend */}
            <div className="flex items-center gap-4 mt-4 pt-3 border-t text-[10px] text-muted-foreground flex-wrap">
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
              <span className="flex items-center gap-1">
                <Lock className="h-2.5 w-2.5 text-amber-500" />
                {t('calendar.overview.private', 'Private')}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
