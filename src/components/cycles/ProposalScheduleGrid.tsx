import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, CalendarOff, Clock, ArrowRightLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type SlotWithOccupancy } from '@/lib/cycles';

interface ProposalScheduleGridProps {
  slots: SlotWithOccupancy[];
  onPlayerClick?: (intakeRequestId: string) => void;
  onMovePlayer?: (assignmentId: string, intakeRequestId: string) => void;
}

function getDayName(isoString: string): string {
  return format(parseISO(isoString), 'EEEE');
}

function getTimeRange(startIso: string, endIso: string): string {
  return `${format(parseISO(startIso), 'HH:mm')} – ${format(parseISO(endIso), 'HH:mm')}`;
}

function getDurationMinutes(startIso: string, endIso: string): number {
  return Math.round((parseISO(endIso).getTime() - parseISO(startIso).getTime()) / 60000);
}

function getAvgConfidence(slot: SlotWithOccupancy): number {
  if (slot.current_assignments.length === 0) return 0;
  const sum = slot.current_assignments.reduce((s, a) => s + (a.confidence_score || 0), 0);
  return Math.round(sum / slot.current_assignments.length);
}

function getConfidenceBorder(score: number): string {
  if (score >= 80) return 'border-emerald-400 dark:border-emerald-700';
  if (score >= 60) return 'border-amber-400 dark:border-amber-700';
  if (score > 0) return 'border-red-400 dark:border-red-700';
  return 'border-border';
}

function getOccupancyColor(current: number, max: number): string {
  if (current === 0) return 'text-muted-foreground';
  if (current >= max) return 'text-emerald-600 dark:text-emerald-400';
  if (current >= max * 0.5) return 'text-amber-600 dark:text-amber-400';
  return 'text-muted-foreground';
}

export default function ProposalScheduleGrid({ slots, onPlayerClick, onMovePlayer }: ProposalScheduleGridProps) {
  const { t } = useTranslation('cycles');

  // Group by day
  const dayGroups = useMemo(() => {
    const groups = new Map<string, SlotWithOccupancy[]>();
    slots.forEach(slot => {
      const day = getDayName(slot.start_time);
      const existing = groups.get(day) || [];
      existing.push(slot);
      groups.set(day, existing);
    });
    // Sort slots within each day by time then trainer
    groups.forEach((daySlots, day) => {
      daySlots.sort((a, b) => a.start_time.localeCompare(b.start_time));
      groups.set(day, daySlots);
    });
    return groups;
  }, [slots]);

  const availableDays = useMemo(() => {
    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return dayOrder.filter(d => dayGroups.has(d));
  }, [dayGroups]);

  const [selectedDay, setSelectedDay] = useState<string>(availableDays[0] || '');

  if (slots.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <CalendarOff className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-muted-foreground font-medium">
            {t('proposals.noProposals', 'No proposals to display')}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            {t('proposals.noProposalsHint', 'Generate proposals first to see the schedule view')}
          </p>
        </CardContent>
      </Card>
    );
  }

  const daySlots = dayGroups.get(selectedDay) || [];

  // Group by trainer within the day
  const trainerGroups = useMemo(() => {
    const groups = new Map<string, { trainer: { id: string; name: string; avatar: string | null }; slots: SlotWithOccupancy[] }>();
    daySlots.forEach(slot => {
      const existing = groups.get(slot.trainer_id);
      if (existing) {
        existing.slots.push(slot);
      } else {
        groups.set(slot.trainer_id, {
          trainer: { id: slot.trainer_id, name: slot.trainer_name, avatar: slot.trainer_avatar },
          slots: [slot],
        });
      }
    });
    return Array.from(groups.values());
  }, [daySlots]);

  return (
    <div className="space-y-4">
      {/* Day tabs */}
      <Tabs value={selectedDay} onValueChange={setSelectedDay}>
        <TabsList className="flex-wrap h-auto gap-1">
          {availableDays.map(day => {
            const dayS = dayGroups.get(day) || [];
            const playerCount = dayS.reduce((sum, s) => sum + s.current_assignments.length, 0);
            return (
              <TabsTrigger key={day} value={day} className="text-xs sm:text-sm">
                {day.slice(0, 3)}
                <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0 h-4">
                  {playerCount}
                </Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {/* Trainer sections */}
      <div className="space-y-6">
        {trainerGroups.map(({ trainer, slots: trainerSlots }) => (
          <div key={trainer.id} className="space-y-3">
            {/* Trainer header */}
            <div className="flex items-center gap-2 px-1">
              <Avatar className="h-7 w-7">
                <AvatarImage src={trainer.avatar || undefined} />
                <AvatarFallback className="text-xs">
                  {trainer.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                </AvatarFallback>
              </Avatar>
              <span className="text-sm font-semibold">{trainer.name}</span>
              <span className="text-xs text-muted-foreground">
                ({trainerSlots.length} {trainerSlots.length === 1 ? 'slot' : 'slots'})
              </span>
            </div>

            {/* Slot cards grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {trainerSlots.map(slot => {
                const duration = getDurationMinutes(slot.start_time, slot.end_time);
                const maxP = slot.max_participants || 4;
                const currentP = slot.current_assignments.length;
                const avgConf = getAvgConfidence(slot);
                const isFull = currentP >= maxP;
                const isEmpty = currentP === 0;

                return (
                  <Card
                    key={slot.id}
                    className={cn(
                      'border-l-4 transition-shadow hover:shadow-md',
                      isEmpty ? 'border-l-border opacity-60' : getConfidenceBorder(avgConf),
                    )}
                  >
                    <CardContent className="p-3 space-y-2">
                      {/* Time + duration header */}
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">
                          {getTimeRange(slot.start_time, slot.end_time)}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
                            <Clock className="h-2.5 w-2.5" />
                            {duration}'
                          </Badge>
                        </div>
                      </div>

                      {/* Occupancy + confidence */}
                      <div className="flex items-center justify-between text-xs">
                        <span className={cn('flex items-center gap-1 font-medium', getOccupancyColor(currentP, maxP))}>
                          <Users className="h-3 w-3" />
                          {currentP}/{maxP} {t('proposals.players', 'players')}
                          {isFull && (
                            <Badge variant="default" className="text-[9px] px-1 py-0 h-3.5 ml-1">
                              {t('proposals.full', 'FULL')}
                            </Badge>
                          )}
                        </span>
                        {avgConf > 0 && (
                          <span className="text-muted-foreground">
                            ø {avgConf}%
                          </span>
                        )}
                      </div>

                      {/* Player chips */}
                      {currentP > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {slot.current_assignments.map(assignment => (
                            <div
                              key={assignment.id}
                              className="group flex items-center gap-1 bg-muted rounded-md pl-2 pr-1 py-1 text-xs hover:bg-accent transition-colors"
                            >
                              <button
                                onClick={() => onPlayerClick?.(assignment.intake_request_id)}
                                className="flex items-center gap-1 cursor-pointer"
                              >
                                <span className="font-medium truncate max-w-[100px]">
                                  {assignment.player_name}
                                </span>
                                {assignment.player_rating && (
                                  <span className="text-muted-foreground text-[10px]">
                                    {assignment.player_rating}
                                  </span>
                                )}
                                {assignment.confidence_score && (
                                  <Badge
                                    variant="secondary"
                                    className={cn(
                                      'text-[9px] px-1 py-0 h-3.5',
                                      assignment.confidence_score >= 80 ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' :
                                      assignment.confidence_score >= 60 ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' :
                                      'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
                                    )}
                                  >
                                    {assignment.confidence_score}%
                                  </Badge>
                                )}
                              </button>
                              {onMovePlayer && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onMovePlayer(assignment.id, assignment.intake_request_id);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background transition-all"
                                  title={t('proposals.movePlayer', 'Move player')}
                                >
                                  <ArrowRightLeft className="h-3 w-3 text-muted-foreground" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Empty slot indicator */}
                      {isEmpty && (
                        <p className="text-xs text-muted-foreground italic pt-1">
                          {t('proposals.emptySlot', 'No players assigned')}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
