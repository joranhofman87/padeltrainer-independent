import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { format, parseISO, addMinutes, type Locale } from 'date-fns';
import { nl, es, de, fr, enUS } from 'date-fns/locale';
import {
  DndContext, DragOverlay, useDraggable, useDroppable,
  type DragStartEvent, type DragEndEvent,
  PointerSensor, useSensor, useSensors,
  pointerWithin,
} from '@dnd-kit/core';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, CalendarOff, Clock, GripVertical, Move, Undo2, Lock } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type SlotWithOccupancy, type TrainerAvailabilityWindow } from '@/lib/cycles';

interface ProposalScheduleGridProps {
  slots: SlotWithOccupancy[];
  trainerAvailabilityWindows?: TrainerAvailabilityWindow[];
  onPlayerClick?: (intakeRequestId: string) => void;
  onMovePlayer?: (assignmentId: string, newSlotId: string) => void;
  onMoveSlot?: (slotId: string, newTrainerId: string, newStartTime: string, newEndTime: string) => void;
  onSwapSlots?: (
    slotAId: string, slotANewTrainerId: string, slotANewStart: string, slotANewEnd: string,
    slotBId: string, slotBNewTrainerId: string, slotBNewStart: string, slotBNewEnd: string,
  ) => void;
  onUndo?: (previousSlots: SlotWithOccupancy[]) => void;
}

type Assignment = SlotWithOccupancy['current_assignments'][number];

// ── Undo history item ──
interface UndoItem {
  label: string;
  previousSlots: SlotWithOccupancy[];
}

// ── Helpers ──
const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS };

/** Get English day name (used as internal key) */
function getDayKey(isoString: string): string {
  return format(parseISO(isoString), 'EEEE', { locale: enUS });
}

/** Get localized day name for display */
function getLocalizedDayName(englishDay: string, locale: Locale): string {
  const dayIndex = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(englishDay);
  if (dayIndex === -1) return englishDay;
  const ref = new Date(2024, 0, 7 + dayIndex);
  return format(ref, 'EEEE', { locale });
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

/** Convert minutes-since-midnight to "HH:mm" */
function minutesToHHMM(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/** Get minutes-since-midnight from an ISO string */
function isoToMinutes(iso: string): number {
  const d = parseISO(iso);
  return d.getHours() * 60 + d.getMinutes();
}

// ── Boundary check: is a time range within trainer's availability window? ──
function isWithinTrainerWindow(
  trainerId: string,
  startMin: number,
  endMin: number,
  dayLower: string,
  windows?: TrainerAvailabilityWindow[],
): boolean {
  if (!windows || windows.length === 0) return true; // No windows configured = no restriction
  const trainerWindows = windows.find(tw => tw.trainerId === trainerId);
  if (!trainerWindows) return true; // Trainer not in config = allow
  const dayWindows = trainerWindows.windows.filter(w => w.day.toLowerCase() === dayLower);
  if (dayWindows.length === 0) return false; // Trainer doesn't work this day
  return dayWindows.some(w => {
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    const wStart = sh * 60 + (sm || 0);
    const wEnd = eh * 60 + (em || 0);
    return startMin >= wStart && endMin <= wEnd;
  });
}

// ── Draggable Player Chip ──

function DraggablePlayerChip({
  assignment, slotId, onPlayerClick,
}: {
  assignment: Assignment;
  slotId: string;
  onPlayerClick?: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `player-${assignment.id}`,
    data: { type: 'player', assignmentId: assignment.id, sourceSlotId: slotId, assignment },
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

// ── Draggable Slot Card ──

function DraggableSlotCard({
  slot, onPlayerClick, canDragSlot,
}: {
  slot: SlotWithOccupancy;
  onPlayerClick?: (id: string) => void;
  canDragSlot: boolean;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `slot-drag-${slot.id}`,
    data: { type: 'slot', slotId: slot.id, slot },
    disabled: !canDragSlot,
  });

  const duration = getDurationMinutes(slot.start_time, slot.end_time);
  const maxP = slot.max_participants || 4;
  const currentP = slot.current_assignments.length;
  const avgConf = getAvgConfidence(slot);
  const isFull = currentP >= maxP;
  const isEmpty = currentP === 0;

  return (
    <Card
      ref={setDragRef}
      className={cn(
        'border-l-4 transition-all h-full',
        isEmpty ? 'border-l-border opacity-60' : getConfidenceBorder(avgConf),
        isDragging && 'opacity-30 scale-95',
      )}
    >
      <CardContent className="p-2.5 space-y-1.5">
        {/* Drag handle + time */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            {canDragSlot && (
              <button
                {...listeners}
                {...attributes}
                className="cursor-grab active:cursor-grabbing p-0.5 touch-none text-muted-foreground hover:text-foreground"
                aria-label="Drag slot"
              >
                <Move className="h-3.5 w-3.5" />
              </button>
            )}
            <span className="text-xs font-semibold">
              {getTimeRange(slot.start_time, slot.end_time)}
            </span>
          </div>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
            <Clock className="h-2.5 w-2.5" />
            {duration}'
          </Badge>
        </div>

        {/* Occupancy */}
        <div className="flex items-center justify-between text-xs">
          <span className={cn('flex items-center gap-1 font-medium', getOccupancyColor(currentP, maxP))}>
            <Users className="h-3 w-3" />
            {currentP}/{maxP}
            {isFull && (
              <Badge variant="default" className="text-[9px] px-1 py-0 h-3.5 ml-1">FULL</Badge>
            )}
          </span>
          {avgConf > 0 && (
            <span className="text-muted-foreground text-[10px]">ø {avgConf}%</span>
          )}
        </div>

        {/* Player chips */}
        {currentP > 0 && (
          <div className="flex flex-col gap-1">
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
          <p className="text-[10px] text-muted-foreground italic">No players</p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Blocked Slot Card (non-interactive) ──

function BlockedSlotCard({ slot }: { slot: SlotWithOccupancy }) {
  const { t } = useTranslation('cycles');
  const duration = getDurationMinutes(slot.start_time, slot.end_time);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Card className="border-l-4 border-l-muted-foreground/30 h-full opacity-50 bg-[repeating-linear-gradient(135deg,transparent,transparent_4px,hsl(var(--muted))_4px,hsl(var(--muted))_6px)]">
            <CardContent className="p-2.5 space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <Lock className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs font-semibold text-muted-foreground">
                    {getTimeRange(slot.start_time, slot.end_time)}
                  </span>
                </div>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
                  <Clock className="h-2.5 w-2.5" />
                  {duration}'
                </Badge>
              </div>
              <p className="text-[10px] text-muted-foreground italic">
                {t('proposals.existingLesson', { defaultValue: 'Existing lesson' })}
              </p>
            </CardContent>
          </Card>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('proposals.blockedSlotTooltip', { defaultValue: 'This time is already booked in the trainer\'s agenda' })}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── Droppable Cell ──

function DroppableCell({
  cellId, children, hasSlot,
}: {
  cellId: string;
  children?: React.ReactNode;
  hasSlot: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: cellId,
    data: { type: 'cell', cellId },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'min-h-[60px] h-full rounded-md border border-dashed border-transparent transition-all p-0.5',
        !hasSlot && 'border-border/30',
        isOver && !hasSlot && 'border-primary/50 bg-primary/5 scale-[1.01]',
        isOver && hasSlot && 'ring-1 ring-primary/30',
      )}
    >
      {children}
    </div>
  );
}

// ── Drag Overlays ──

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

function SlotDragOverlay({ slot }: { slot: SlotWithOccupancy }) {
  const duration = getDurationMinutes(slot.start_time, slot.end_time);
  const currentP = slot.current_assignments.length;
  const maxP = slot.max_participants || 4;

  return (
    <Card className="border-l-4 border-l-primary shadow-xl w-[220px]">
      <CardContent className="p-2.5 space-y-1">
        <div className="flex items-center gap-1">
          <Move className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold">
            {getTimeRange(slot.start_time, slot.end_time)}
          </span>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5 ml-auto">
            <Clock className="h-2.5 w-2.5" />{duration}'
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Users className="h-3 w-3" />{currentP}/{maxP} players
        </span>
      </CardContent>
    </Card>
  );
}

// ── Main Grid ──

export default function ProposalScheduleGrid({
  slots, trainerAvailabilityWindows, onPlayerClick, onMovePlayer, onMoveSlot, onSwapSlots, onUndo,
}: ProposalScheduleGridProps) {
  const { t, i18n } = useTranslation('cycles');
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;
  const [activeData, setActiveData] = useState<{
    type: 'player' | 'slot';
    assignment?: Assignment;
    slot?: SlotWithOccupancy;
  } | null>(null);

  // Undo stack — stores previous slot snapshots
  const [undoStack, setUndoStack] = useState<UndoItem[]>([]);
  const previousSlotsRef = useRef<SlotWithOccupancy[]>(slots);

  // Keep ref in sync but don't trigger re-renders
  useEffect(() => {
    previousSlotsRef.current = slots;
  }, [slots]);

  const pushUndo = useCallback((label: string) => {
    setUndoStack(prev => [...prev.slice(-9), { label, previousSlots: previousSlotsRef.current }]);
  }, []);

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    setUndoStack(prev => prev.slice(0, -1));
    onUndo?.(last.previousSlots);
  }, [undoStack, onUndo]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const canDragSlot = !!onMoveSlot;

  // Collect days from availability windows
  const availabilityDaySet = useMemo(() => {
    const days = new Set<string>();
    trainerAvailabilityWindows?.forEach(tw => {
      tw.windows.forEach(w => {
        const capitalized = w.day.charAt(0).toUpperCase() + w.day.slice(1).toLowerCase();
        days.add(capitalized);
      });
    });
    return days;
  }, [trainerAvailabilityWindows]);

  // Group by day
  const dayGroups = useMemo(() => {
    const groups = new Map<string, SlotWithOccupancy[]>();
    slots.forEach(slot => {
      const day = getDayKey(slot.start_time);
      const existing = groups.get(day) || [];
      existing.push(slot);
      groups.set(day, existing);
    });
    return groups;
  }, [slots]);

  const availableDays = useMemo(() => {
    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return dayOrder.filter(d => dayGroups.has(d) || availabilityDaySet.has(d));
  }, [dayGroups, availabilityDaySet]);

  const [selectedDay, setSelectedDay] = useState<string>('');

  useEffect(() => {
    if (availableDays.length > 0 && !availableDays.includes(selectedDay)) {
      setSelectedDay(availableDays[0]);
    }
  }, [availableDays, selectedDay]);

  const daySlots = useMemo(() => dayGroups.get(selectedDay) || [], [dayGroups, selectedDay]);

  // Get availability windows for the selected day
  const dayAvailabilityWindows = useMemo(() => {
    if (!trainerAvailabilityWindows) return [];
    const selectedDayLower = selectedDay.toLowerCase();
    return trainerAvailabilityWindows
      .map(tw => ({
        ...tw,
        dayWindows: tw.windows.filter(w => w.day.toLowerCase() === selectedDayLower),
      }))
      .filter(tw => tw.dayWindows.length > 0);
  }, [trainerAvailabilityWindows, selectedDay]);

  // Get unique trainers for columns
  const trainers = useMemo(() => {
    const map = new Map<string, { id: string; name: string; avatar: string | null }>();
    daySlots.forEach(slot => {
      if (!map.has(slot.trainer_id)) {
        map.set(slot.trainer_id, {
          id: slot.trainer_id,
          name: slot.trainer_name,
          avatar: slot.trainer_avatar,
        });
      }
    });
    dayAvailabilityWindows.forEach(tw => {
      if (!map.has(tw.trainerId)) {
        map.set(tw.trainerId, {
          id: tw.trainerId,
          name: tw.trainerName,
          avatar: tw.trainerAvatar || null,
        });
      }
    });
    return Array.from(map.values());
  }, [daySlots, dayAvailabilityWindows]);

  // Compute time rows
  const timeRows = useMemo(() => {
    let earliest = Infinity;
    let latest = -Infinity;

    daySlots.forEach(slot => {
      const startMin = isoToMinutes(slot.start_time);
      const endMin = isoToMinutes(slot.end_time);
      const snappedStart = Math.floor(startMin / 30) * 30;
      const snappedEnd = Math.ceil(endMin / 30) * 30;
      if (snappedStart < earliest) earliest = snappedStart;
      if (snappedEnd > latest) latest = snappedEnd;
    });

    dayAvailabilityWindows.forEach(tw => {
      tw.dayWindows.forEach(w => {
        const [sh, sm] = w.start.split(':').map(Number);
        const [eh, em] = w.end.split(':').map(Number);
        const startMin = sh * 60 + sm;
        const endMin = eh * 60 + em;
        const snappedStart = Math.floor(startMin / 30) * 30;
        const snappedEnd = Math.ceil(endMin / 30) * 30;
        if (snappedStart < earliest) earliest = snappedStart;
        if (snappedEnd > latest) latest = snappedEnd;
      });
    });

    if (earliest === Infinity) return [];

    const rows: number[] = [];
    for (let m = earliest; m < latest; m += 30) {
      rows.push(m);
    }
    return rows;
  }, [daySlots, dayAvailabilityWindows]);

  // Build a lookup: trainerId -> timeRowMinute -> slot
  const slotLookup = useMemo(() => {
    const lookup = new Map<string, SlotWithOccupancy>();
    daySlots.forEach(slot => {
      const startMin = Math.floor(isoToMinutes(slot.start_time) / 30) * 30;
      const key = `${slot.trainer_id}__${startMin}`;
      lookup.set(key, slot);
    });
    return lookup;
  }, [daySlots]);

  // Row spans
  const slotRowSpans = useMemo(() => {
    const spans = new Map<string, number>();
    daySlots.forEach(slot => {
      const startMin = Math.floor(isoToMinutes(slot.start_time) / 30) * 30;
      const endMin = Math.ceil(isoToMinutes(slot.end_time) / 30) * 30;
      spans.set(slot.id, Math.max(1, (endMin - startMin) / 30));
    });
    return spans;
  }, [daySlots]);

  // Occupied cells
  const occupiedCells = useMemo(() => {
    const occupied = new Map<string, string>();
    daySlots.forEach(slot => {
      const startMin = Math.floor(isoToMinutes(slot.start_time) / 30) * 30;
      const span = slotRowSpans.get(slot.id) || 1;
      for (let i = 1; i < span; i++) {
        occupied.set(`${slot.trainer_id}__${startMin + i * 30}`, slot.id);
      }
    });
    return occupied;
  }, [daySlots, slotRowSpans]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (!data) return;
    if (data.type === 'player') {
      setActiveData({ type: 'player', assignment: data.assignment as Assignment });
    } else if (data.type === 'slot') {
      setActiveData({ type: 'slot', slot: data.slot as SlotWithOccupancy });
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const currentActive = activeData;
    setActiveData(null);
    const { active, over } = event;
    if (!over) return;

    const activeType = active.data.current?.type;
    const selectedDayLower = selectedDay.toLowerCase();

    // Player drag → drop onto a slot-based droppable cell
    if (activeType === 'player' && onMovePlayer) {
      const assignmentId = active.data.current?.assignmentId as string;
      const sourceSlotId = active.data.current?.sourceSlotId as string;

      const overCellId = over.id as string;
      if (!overCellId.startsWith('cell__')) return;

      const parts = overCellId.split('__');
      const trainerId = parts[1];
      const timeRow = parseInt(parts[2]);

      // Find the slot at this cell
      const targetSlot = slotLookup.get(`${trainerId}__${timeRow}`);
      let resolvedSlot: SlotWithOccupancy | undefined = targetSlot;
      if (!resolvedSlot) {
        for (const slot of daySlots) {
          if (slot.trainer_id !== trainerId) continue;
          const sMin = Math.floor(isoToMinutes(slot.start_time) / 30) * 30;
          const span = slotRowSpans.get(slot.id) || 1;
          if (timeRow >= sMin && timeRow < sMin + span * 30) {
            resolvedSlot = slot;
            break;
          }
        }
      }

      if (!resolvedSlot || resolvedSlot.id === sourceSlotId) return;
      if (resolvedSlot.is_blocked) return; // Can't drop onto blocked slots
      // #3: Player duration compatibility check
      // Find the source slot to compare durations
      const sourceSlot = daySlots.find(s => s.id === sourceSlotId);
      if (sourceSlot) {
        const sourceDuration = getDurationMinutes(sourceSlot.start_time, sourceSlot.end_time);
        const targetDuration = getDurationMinutes(resolvedSlot.start_time, resolvedSlot.end_time);
        if (sourceDuration !== targetDuration) {
          toast.warning(
            t('proposals.durationMismatch', {
              defaultValue: 'Duration mismatch: player is in a {{source}}min slot, target is {{target}}min',
              source: sourceDuration,
              target: targetDuration,
            })
          );
          return;
        }
      }

      pushUndo(t('proposals.undoPlayerMove', { defaultValue: 'Player move' }));
      onMovePlayer(assignmentId, resolvedSlot.id);
      return;
    }

    // Slot drag → move to new cell
    if (activeType === 'slot' && onMoveSlot && currentActive?.slot) {
      const slot = currentActive.slot;
      const overCellId = over.id as string;
      if (!overCellId.startsWith('cell__')) return;

      const parts = overCellId.split('__');
      const newTrainerId = parts[1];
      const newTimeRowMinute = parseInt(parts[2]);

      const oldStartMin = Math.floor(isoToMinutes(slot.start_time) / 30) * 30;

      // No change?
      if (newTrainerId === slot.trainer_id && newTimeRowMinute === oldStartMin) return;

      // Compute new start/end preserving duration
      const duration = getDurationMinutes(slot.start_time, slot.end_time);
      const refDate = parseISO(slot.start_time);
      const newStart = new Date(refDate);
      newStart.setHours(Math.floor(newTimeRowMinute / 60), newTimeRowMinute % 60, 0, 0);
      const newEnd = addMinutes(newStart, duration);

      const newStartMin = newTimeRowMinute;
      const newEndMin = newTimeRowMinute + duration;

      // #6: Boundary check — is the new position within the trainer's availability window?
      if (!isWithinTrainerWindow(newTrainerId, newStartMin, newEndMin, selectedDayLower, trainerAvailabilityWindows)) {
        toast.warning(t('proposals.outsideAvailability', { defaultValue: 'Cannot move here — outside trainer\'s availability window' }));
        return;
      }

      // Overlap detection
      const overlappingSlot = daySlots.find(other => {
        if (other.id === slot.id) return false;
        if (other.trainer_id !== newTrainerId) return false;
        const otherStartMin = isoToMinutes(other.start_time);
        const otherEndMin = otherStartMin + getDurationMinutes(other.start_time, other.end_time);
        return newStartMin < otherEndMin && newEndMin > otherStartMin;
      });

      if (overlappingSlot) {
        // If the overlapping slot is empty (no players), allow swap
        if (overlappingSlot.current_assignments.length === 0 && onSwapSlots) {
          // #2: Duration validation on swap
          const overlappingDuration = getDurationMinutes(overlappingSlot.start_time, overlappingSlot.end_time);
          if (overlappingDuration !== duration) {
            toast.warning(
              t('proposals.swapDurationMismatch', {
                defaultValue: 'Cannot swap — slots have different durations ({{a}}min vs {{b}}min)',
                a: duration,
                b: overlappingDuration,
              })
            );
            return;
          }

          const oldStart = slot.start_time;
          const oldEnd = slot.end_time;
          const oldTrainerId = slot.trainer_id;

          // #6: Also check boundary for the empty slot going to old position
          const oldSlotStartMin = isoToMinutes(oldStart);
          const oldSlotEndMin = oldSlotStartMin + overlappingDuration;
          if (!isWithinTrainerWindow(oldTrainerId, oldSlotStartMin, oldSlotEndMin, selectedDayLower, trainerAvailabilityWindows)) {
            toast.warning(t('proposals.outsideAvailability', { defaultValue: 'Cannot move here — outside trainer\'s availability window' }));
            return;
          }

          pushUndo(t('proposals.undoSlotSwap', { defaultValue: 'Slot swap' }));
          onSwapSlots(
            slot.id, newTrainerId, newStart.toISOString(), newEnd.toISOString(),
            overlappingSlot.id, oldTrainerId, oldStart, oldEnd,
          );
        } else {
          toast.warning(t('proposals.slotOverlap', 'Cannot move here — overlaps with an existing slot'));
        }
        return;
      }

      pushUndo(t('proposals.undoSlotMove', { defaultValue: 'Slot move' }));
      onMoveSlot(slot.id, newTrainerId, newStart.toISOString(), newEnd.toISOString());
    }
  }, [activeData, onMovePlayer, onMoveSlot, onSwapSlots, slotLookup, daySlots, slotRowSpans, selectedDay, trainerAvailabilityWindows, pushUndo, t]);

  if (slots.length === 0 && (!trainerAvailabilityWindows || trainerAvailabilityWindows.length === 0)) {
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
      {/* Day tabs + Undo button */}
      <div className="flex items-center justify-between gap-3">
        <Tabs value={selectedDay} onValueChange={setSelectedDay} className="flex-1">
          <TabsList className="flex-wrap h-auto gap-1">
            {availableDays.map(day => {
              const dayS = dayGroups.get(day) || [];
              const playerCount = dayS.reduce((sum, s) => sum + s.current_assignments.length, 0);
              return (
                <TabsTrigger key={day} value={day} className="text-xs sm:text-sm">
                  {getLocalizedDayName(day, dateFnsLocale)}
                  <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0 h-4">
                    {playerCount}
                  </Badge>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>

        {undoStack.length > 0 && onUndo && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleUndo}
            className="shrink-0 gap-1.5"
          >
            <Undo2 className="h-3.5 w-3.5" />
            {t('common:undo', { defaultValue: 'Undo' })}
            <span className="text-muted-foreground text-[10px]">({undoStack[undoStack.length - 1].label})</span>
          </Button>
        )}
      </div>

      {/* Time-row × Trainer-column grid */}
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="overflow-x-auto">
          <div
            className="relative grid gap-px bg-border/30 rounded-lg"
            style={{
              gridTemplateColumns: `64px repeat(${trainers.length}, minmax(200px, 1fr))`,
              gridTemplateRows: `auto repeat(${timeRows.length}, minmax(60px, auto))`,
            }}
          >
            {/* Header: empty corner */}
            <div className="bg-background rounded-tl-lg" style={{ gridRow: 1, gridColumn: 1 }} />

            {/* Header: trainer columns */}
            {trainers.map((trainer, colIdx) => (
              <div
                key={trainer.id}
                style={{ gridRow: 1, gridColumn: colIdx + 2 }}
                className="bg-background p-2 flex items-center gap-2 border-b border-border"
              >
                <Avatar className="h-6 w-6">
                  <AvatarImage src={trainer.avatar || undefined} />
                  <AvatarFallback className="text-[10px]">
                    {trainer.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="text-xs font-semibold truncate">{trainer.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {daySlots.filter(s => s.trainer_id === trainer.id).length} slots
                  </p>
                </div>
              </div>
            ))}

            {/* Grid body */}
            {timeRows.map((rowMinute, rowIdx) => {
              const gridRow = rowIdx + 2;
              return (
                <React.Fragment key={`row-${rowMinute}`}>
                  {/* Time label */}
                  <div
                    style={{ gridRow, gridColumn: 1 }}
                    className="bg-background px-2 py-1 flex items-start justify-end border-r border-border"
                  >
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {minutesToHHMM(rowMinute)}
                    </span>
                  </div>

                  {/* Trainer cells */}
                  {trainers.map((trainer, colIdx) => {
                    const cellKey = `${trainer.id}__${rowMinute}`;
                    const gridColumn = colIdx + 2;

                    const occupyingSlotId = occupiedCells.get(cellKey);
                    if (occupyingSlotId) {
                      const cellId = `cell__${trainer.id}__${rowMinute}`;
                      return (
                        <div
                          key={cellKey}
                          style={{ gridRow, gridColumn }}
                          className="bg-background p-0.5"
                        >
                          <DroppableCell cellId={cellId} hasSlot={true}>
                            {/* Occupied by slot spanning from above */}
                          </DroppableCell>
                        </div>
                      );
                    }

                    const slot = slotLookup.get(cellKey);
                    const rowSpan = slot ? (slotRowSpans.get(slot.id) || 1) : 1;
                    const cellId = `cell__${trainer.id}__${rowMinute}`;

                    return (
                      <div
                        key={cellKey}
                        style={{
                          gridRow: rowSpan > 1 ? `${gridRow} / span ${rowSpan}` : gridRow,
                          gridColumn,
                        }}
                        className="bg-background p-0.5"
                      >
                        <DroppableCell cellId={cellId} hasSlot={!!slot}>
                          {slot && slot.is_blocked ? (
                            <BlockedSlotCard slot={slot} />
                          ) : slot ? (
                            <DraggableSlotCard
                              slot={slot}
                              onPlayerClick={onPlayerClick}
                              canDragSlot={canDragSlot}
                            />
                          ) : null}
                        </DroppableCell>
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        <DragOverlay dropAnimation={null}>
          {activeData?.type === 'player' && activeData.assignment && (
            <PlayerDragOverlay assignment={activeData.assignment} />
          )}
          {activeData?.type === 'slot' && activeData.slot && (
            <SlotDragOverlay slot={activeData.slot} />
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
