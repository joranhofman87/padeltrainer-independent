import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO, getDay } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, CalendarOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type IntakeRequestWithProposal } from '@/lib/cycles';

interface ProposalScheduleGridProps {
  requests: IntakeRequestWithProposal[];
  onBlockClick?: (request: IntakeRequestWithProposal) => void;
}

interface SlotBlock {
  request: IntakeRequestWithProposal;
  startMinutes: number;
  endMinutes: number;
  trainerId: string;
  trainerName: string;
  trainerAvatar?: string | null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function minutesFromMidnight(isoString: string): number {
  const d = parseISO(isoString);
  return d.getHours() * 60 + d.getMinutes();
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function getConfidenceColor(score: number): string {
  if (score >= 80) return 'bg-emerald-100 border-emerald-300 text-emerald-900 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-200';
  if (score >= 60) return 'bg-amber-100 border-amber-300 text-amber-900 dark:bg-amber-950 dark:border-amber-800 dark:text-amber-200';
  return 'bg-red-100 border-red-300 text-red-900 dark:bg-red-950 dark:border-red-800 dark:text-red-200';
}

export default function ProposalScheduleGrid({ requests, onBlockClick }: ProposalScheduleGridProps) {
  const { t } = useTranslation('cycles');

  // Only show requests that have proposals
  const proposedRequests = useMemo(
    () => requests.filter(r => r.proposal && r.proposal.slot_start),
    [requests]
  );

  // Group by day of week
  const dayGroups = useMemo(() => {
    const groups = new Map<string, SlotBlock[]>();
    proposedRequests.forEach(req => {
      const p = req.proposal!;
      const dayName = p.slot_day;
      const block: SlotBlock = {
        request: req,
        startMinutes: minutesFromMidnight(p.slot_start),
        endMinutes: minutesFromMidnight(p.slot_end),
        trainerId: p.trainer_id,
        trainerName: p.trainer_name,
        trainerAvatar: p.trainer_avatar,
      };
      const existing = groups.get(dayName) || [];
      existing.push(block);
      groups.set(dayName, existing);
    });
    return groups;
  }, [proposedRequests]);

  // Available days in order
  const availableDays = useMemo(() => {
    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return dayOrder.filter(d => dayGroups.has(d));
  }, [dayGroups]);

  const [selectedDay, setSelectedDay] = useState<string>(availableDays[0] || '');

  // Trainers for selected day
  const dayBlocks = dayGroups.get(selectedDay) || [];
  
  const trainers = useMemo(() => {
    const map = new Map<string, { id: string; name: string; avatar?: string | null }>();
    dayBlocks.forEach(b => {
      if (!map.has(b.trainerId)) {
        map.set(b.trainerId, { id: b.trainerId, name: b.trainerName, avatar: b.trainerAvatar });
      }
    });
    return Array.from(map.values());
  }, [dayBlocks]);

  // Time range for the day (30-min increments)
  const { timeSlots, minTime, maxTime } = useMemo(() => {
    if (dayBlocks.length === 0) return { timeSlots: [], minTime: 0, maxTime: 0 };
    const allStarts = dayBlocks.map(b => b.startMinutes);
    const allEnds = dayBlocks.map(b => b.endMinutes);
    const minT = Math.floor(Math.min(...allStarts) / 30) * 30;
    const maxT = Math.ceil(Math.max(...allEnds) / 30) * 30;
    const slots: number[] = [];
    for (let t = minT; t < maxT; t += 30) {
      slots.push(t);
    }
    return { timeSlots: slots, minTime: minT, maxTime: maxT };
  }, [dayBlocks]);

  if (proposedRequests.length === 0) {
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

  const ROW_HEIGHT = 48; // px per 30-min slot
  const totalHeight = timeSlots.length * ROW_HEIGHT;

  return (
    <div className="space-y-4">
      {/* Day tabs */}
      <Tabs value={selectedDay} onValueChange={setSelectedDay}>
        <TabsList>
          {availableDays.map(day => {
            const count = (dayGroups.get(day) || []).length;
            return (
              <TabsTrigger key={day} value={day}>
                {day.slice(0, 3)} ({count})
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {/* Grid */}
      {trainers.length > 0 && timeSlots.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <div className="min-w-[600px]">
              {/* Header row with trainer names */}
              <div className="flex border-b bg-muted/50">
                <div className="w-20 shrink-0 px-3 py-3 text-xs font-medium text-muted-foreground border-r">
                  {t('proposals.time', 'Time')}
                </div>
                {trainers.map(trainer => (
                  <div key={trainer.id} className="flex-1 min-w-[180px] px-3 py-3 border-r last:border-r-0">
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={trainer.avatar || undefined} />
                        <AvatarFallback className="text-xs">
                          {trainer.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-medium truncate">{trainer.name}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Time grid body */}
              <div className="relative" style={{ height: totalHeight }}>
                {/* Time labels and horizontal lines */}
                {timeSlots.map((time, idx) => (
                  <div
                    key={time}
                    className="absolute w-full flex border-b border-border/50"
                    style={{ top: idx * ROW_HEIGHT, height: ROW_HEIGHT }}
                  >
                    <div className="w-20 shrink-0 px-3 py-1 text-xs text-muted-foreground border-r flex items-start pt-1.5">
                      {formatTime(time)}
                    </div>
                    {trainers.map(trainer => (
                      <div
                        key={trainer.id}
                        className="flex-1 min-w-[180px] border-r last:border-r-0 bg-background"
                      />
                    ))}
                  </div>
                ))}

                {/* Proposal blocks overlay */}
                {trainers.map((trainer, trainerIdx) => {
                  const trainerBlocks = dayBlocks.filter(b => b.trainerId === trainer.id);
                  const leftOffset = 80 + trainerIdx * Math.max(180, 0); // Approximate - we'll use CSS positioning
                  
                  return trainerBlocks.map(block => {
                    const topPx = ((block.startMinutes - minTime) / 30) * ROW_HEIGHT;
                    const heightPx = ((block.endMinutes - block.startMinutes) / 30) * ROW_HEIGHT;
                    const req = block.request;
                    const score = req.proposal!.confidence_score;
                    const groupCount = req.proposal!.group_members.length;

                    return (
                      <div
                        key={req.id}
                        className="absolute px-1 py-0.5"
                        style={{
                          top: topPx,
                          height: heightPx,
                          // Position in the trainer's column using CSS calc
                          left: `calc(80px + ${trainerIdx} * ((100% - 80px) / ${trainers.length}))`,
                          width: `calc((100% - 80px) / ${trainers.length})`,
                        }}
                      >
                        <button
                          onClick={() => onBlockClick?.(req)}
                          className={cn(
                            'w-full h-full rounded-md border px-2 py-1 text-left transition-shadow hover:shadow-md overflow-hidden cursor-pointer',
                            getConfidenceColor(score)
                          )}
                        >
                          <div className="flex flex-col h-full justify-between">
                            <div>
                              <div className="text-xs font-semibold truncate">{req.full_name}</div>
                              {req.rating && (
                                <div className="text-[10px] opacity-75">⭐ {req.rating}</div>
                              )}
                            </div>
                            <div className="flex items-center justify-between gap-1">
                              {groupCount > 0 && (
                                <span className="text-[10px] flex items-center gap-0.5">
                                  <Users className="h-3 w-3" />+{groupCount}
                                </span>
                              )}
                              <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 ml-auto">
                                {Math.round(score)}%
                              </Badge>
                            </div>
                          </div>
                        </button>
                      </div>
                    );
                  });
                })}
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
