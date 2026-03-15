import { useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO } from 'date-fns';
import { DndContext, DragOverlay, useDraggable, useDroppable, type DragStartEvent, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, CalendarOff, Clock, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type SlotWithOccupancy } from '@/lib/cycles';

interface ProposalScheduleGridProps {
  slots: SlotWithOccupancy[];
  onPlayerClick?: (intakeRequestId: string) => void;
  onMovePlayer?: (assignmentId: string, newSlotId: string) => void;
}

type Assignment = SlotWithOccupancy['current_assignments'][number];

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
  if (score >= 80) return 'border-l-emerald-500 dark:border-l-emerald-600';
  if (score >= 60) return 'border-l-amber-500 dark:border-l-amber-600';
  if (score > 0) return 'border-l-red-500 dark:border-l-red-600';
  return 'border-l-border';
}

function getOccupancyColor(current: number, max: number): string {
  if (current === 0) return 'text-muted-foreground';
  if (current >= max) return 'text-primary';
  return 'text-muted-foreground';
}

// ── Draggable Player Chip ──
function DraggablePlayerChip({
  assignment,
  slotId,
  onPlayerClick,
}: {
  assignment: Assignment;
  slotId: string;
  onPlayerClick?: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `player-${assignment.id}`,
    data: { assignmentId: assignment.id, sourceSlotId: slotId, assignment },
  });

  const confScore = assignment.confidence_score || 0;
  const confClass = confScore >= 80
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
    : confScore >= 60
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
      : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex items-center gap-1 bg-muted rounded-md pl-1.5 pr-2 py-1 text-xs transition-colors',
        isDragging ? 'opacity-30' : 'hover:bg-accent',
      )}
    >
      <button
        {...listeners}
        {...attributes}
        className="cursor-grab active:cursor-grabbing p-0.5 touch-none"
        aria-label="Drag player"
      >
        <GripVertical className="h-3 w-3 text-muted-foreground" />
      </button>
      <button
        onClick={() => onPlayerClick?.(assignment.intake_request_id)}
        className="flex items-center gap-1 cursor-pointer min-w-0"
      >
        <span className="font-medium truncate max-w-[90px]">{assignment.player_name}</span>
        {assignment.player_rating != null && (
          <span className="text-muted-foreground text-[10px]">{assignment.player_rating}</span>
        )}
        {confScore > 0 && (
          <Badge variant="secondary" className={cn('text-[9px] px-1 py-0 h-3.5 shrink-0', confClass)}>
            {confScore}%
          </Badge>
        )}
      </button>
    </div>
  );
}

// ── Droppable Slot Card ──
function DroppableSlotCard({
  slot,
  onPlayerClick,
}: {
  slot: SlotWithOccupancy;
  onPlayerClick?: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `slot-${slot.id}`,
    data: { slotId: slot.id },
  });

  const duration = getDurationMinutes(slot.start_time, slot.end_time);
  const maxP = slot.max_participants || 4;
  const currentP = slot.current_assignments.length;
  const avgConf = getAvgConfidence(slot);
  const isFull = currentP >= maxP;
  const isEmpty = currentP === 0;

  return (
    <Card
      ref={setNodeRef}
      className={cn(
        'border-l-4 transition-all',
        isEmpty ? 'border-l-border opacity-60' : getConfidenceBorder(avgConf),
        isOver && !isFull && 'ring-2 ring-primary/50 shadow-lg scale-[1.02]',
        isOver && isFull && 'ring-2 ring-destructive/50',
      )}
    >
      <CardContent className="p-3 space-y-2">
        {/* Time + duration */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">
            {getTimeRange(slot.start_time, slot.end_time)}
          </span>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
            <Clock className="h-2.5 w-2.5" />
            {duration}'
          </Badge>
        </div>

        {/* Occupancy + confidence */}
        <div className="flex items-center justify-between text-xs">
          <span className={cn('flex items-center gap-1 font-medium', getOccupancyColor(currentP, maxP))}>
            <Users className="h-3 w-3" />
            {currentP}/{maxP}
            {isFull && (
              <Badge variant="default" className="text-[9px] px-1 py-0 h-3.5 ml-1">FULL</Badge>
            )}
          </span>
          {avgConf > 0 && (
            <span className="text-muted-foreground">ø {avgConf}%</span>
          )}
        </div>

        {/* Player chips */}
        {currentP > 0 && (
          <div className="flex flex-col gap-1 pt-1">
            {slot.current_assignments.map(assignment => (
              <DraggablePlayerChip
                key={assignment.id}
                assignment={assignment}
                slotId={slot.id}
                onPlayerClick={onPlayerClick}
              />
            ))}
          </div>
        )}

        {isEmpty && (
          <p className="text-xs text-muted-foreground italic pt-1">No players assigned</p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Drag Overlay (ghost while dragging) ──
function PlayerDragOverlay({ assignment }: { assignment: Assignment }) {
  const confScore = assignment.confidence_score || 0;
  const confClass = confScore >= 80
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
    : confScore >= 60
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
      : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';

  return (
    <div className="flex items-center gap-1 bg-muted rounded-md px-2 py-1 text-xs shadow-lg border border-border">
      <GripVertical className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium">{assignment.player_name}</span>
      {assignment.player_rating != null && (
        <span className="text-muted-foreground text-[10px]">{assignment.player_rating}</span>
      )}
      {confScore > 0 && (
        <Badge variant="secondary" className={cn('text-[9px] px-1 py-0 h-3.5', confClass)}>
          {confScore}%
        </Badge>
      )}
    </div>
  );
}

// ── Main Grid ──
export default function ProposalScheduleGrid({ slots, onPlayerClick, onMovePlayer }: ProposalScheduleGridProps) {
  const { t } = useTranslation('cycles');
  const [activeAssignment, setActiveAssignment] = useState<Assignment | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Group by day
  const dayGroups = useMemo(() => {
    const groups = new Map<string, SlotWithOccupancy[]>();
    slots.forEach(slot => {
      const day = getDayName(slot.start_time);
      const existing = groups.get(day) || [];
      existing.push(slot);
      groups.set(day, existing);
    });
    groups.forEach(daySlots => {
      daySlots.sort((a, b) => a.start_time.localeCompare(b.start_time));
    });
    return groups;
  }, [slots]);

  const availableDays = useMemo(() => {
    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return dayOrder.filter(d => dayGroups.has(d));
  }, [dayGroups]);

  const [selectedDay, setSelectedDay] = useState<string>('');

  useEffect(() => {
    if (availableDays.length > 0 && !availableDays.includes(selectedDay)) {
      setSelectedDay(availableDays[0]);
    }
  }, [availableDays, selectedDay]);

  const daySlots = useMemo(() => dayGroups.get(selectedDay) || [], [dayGroups, selectedDay]);

  // Group by trainer (for columns)
  const trainerColumns = useMemo(() => {
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

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.assignment) {
      setActiveAssignment(data.assignment as Assignment);
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveAssignment(null);
    const { active, over } = event;
    if (!over || !onMovePlayer) return;

    const assignmentId = active.data.current?.assignmentId as string;
    const sourceSlotId = active.data.current?.sourceSlotId as string;
    const targetSlotId = over.data.current?.slotId as string;

    if (!assignmentId || !targetSlotId || sourceSlotId === targetSlotId) return;

    onMovePlayer(assignmentId, targetSlotId);
  }, [onMovePlayer]);

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
                {day}
                <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0 h-4">
                  {playerCount}
                </Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {/* Trainer columns with drag & drop */}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${Math.min(trainerColumns.length, 4)}, minmax(240px, 1fr))`,
          }}
        >
          {trainerColumns.map(({ trainer, slots: trainerSlots }) => (
            <div key={trainer.id} className="space-y-3">
              {/* Trainer column header */}
              <div className="flex items-center gap-2 px-1 pb-2 border-b border-border">
                <Avatar className="h-7 w-7">
                  <AvatarImage src={trainer.avatar || undefined} />
                  <AvatarFallback className="text-xs">
                    {trainer.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{trainer.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {trainerSlots.length} {trainerSlots.length === 1 ? 'slot' : 'slots'} · {trainerSlots.reduce((s, sl) => s + sl.current_assignments.length, 0)} players
                  </p>
                </div>
              </div>

              {/* Slot cards stacked vertically */}
              <div className="space-y-2">
                {trainerSlots.map(slot => (
                  <DroppableSlotCard
                    key={slot.id}
                    slot={slot}
                    onPlayerClick={onPlayerClick}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeAssignment && <PlayerDragOverlay assignment={activeAssignment} />}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
