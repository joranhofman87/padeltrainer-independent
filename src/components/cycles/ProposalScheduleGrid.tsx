import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { format, parseISO, addMinutes, addDays, getDay, type Locale } from 'date-fns';
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
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, CalendarOff, Clock, GripVertical, Move, Undo2, Lock, LockOpen, Pencil, Trash2, Search, PanelRightClose, PanelRightOpen, UserCircle, AlertTriangle, UserPlus, Plus, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { type SlotWithOccupancy, type TrainerAvailabilityWindow, type IntakeRequestWithProposal } from '@/lib/cycles';

export interface UnplacedPlayer {
  id: string;
  full_name: string;
  rating: number | null;
  rating_system: string | null;
  preferred_days: string[];
  lesson_type: string | string[];
  skip_reason?: string | null;
  sessions_per_week?: number;
}

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
  onDeleteSlot?: (slotId: string) => void;
  onCreateSlot?: (trainerId: string, startTime: string, endTime: string) => void;
  onUndo?: (previousSlots: SlotWithOccupancy[]) => void;
  onToggleSlotPrivacy?: (slotId: string, value: boolean) => void;
  unplacedPlayers?: UnplacedPlayer[];
  allPlayers?: UnplacedPlayer[];
  onAssignPlayer?: (intakeRequestId: string, slotId: string) => void;
  onUnassignPlayer?: (assignmentId: string) => void;
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
  const sum = slot.current_assignments.reduce((s, a) => s + (a.confidence_score ?? computeManualScore(a, slot, undefined)), 0);
  return Math.round(sum / slot.current_assignments.length);
}

function getConfidenceBorder(score: number): string {
  if (score >= 80) return 'border-l-emerald-500 dark:border-l-emerald-600';
  if (score >= 60) return 'border-l-amber-500 dark:border-l-amber-600';
  if (score > 0) return 'border-l-red-500 dark:border-l-red-600';
  return 'border-l-border';
}

/** Compute a basic match score for manually assigned players (confidence_score is null) */
function computeManualScore(
  assignment: Assignment,
  slot: SlotWithOccupancy,
  playerInfo?: UnplacedPlayer,
): number {
  let score = 0;
  // Day match: 50 pts
  if (playerInfo) {
    const slotDay = format(parseISO(slot.start_time), 'EEEE', { locale: enUS }).toLowerCase();
    const dayOk = !playerInfo.preferred_days?.length || playerInfo.preferred_days.map(d => d.toLowerCase()).includes(slotDay);
    if (dayOk) score += 50;
  } else {
    score += 25; // Unknown → neutral
  }
  // Rating fit: 50 pts
  if (assignment.player_rating != null && (slot.min_rating != null || slot.max_rating != null)) {
    const inRange = (slot.min_rating == null || assignment.player_rating >= slot.min_rating)
      && (slot.max_rating == null || assignment.player_rating <= slot.max_rating);
    if (inRange) score += 50;
  } else {
    score += 25; // No range configured → neutral
  }
  return score;
}

/** Calculate the rating spread within a slot's assignments */
function getRatingSpread(assignments: Assignment[]): number | null {
  const ratings = assignments.map(a => a.player_rating).filter((r): r is number => r != null);
  if (ratings.length < 2) return null;
  return Math.max(...ratings) - Math.min(...ratings);
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

/** Check if player rating is outside slot's configured range */
/** Format a rating to always show 1 decimal place */
function formatRating(r: number): string {
  return r.toFixed(1);
}

function isRatingOutOfRange(
  playerRating: number | null | undefined,
  slotMinRating: number | null | undefined,
  slotMaxRating: number | null | undefined,
): boolean {
  if (playerRating == null) return false;
  if (slotMinRating != null && playerRating < slotMinRating) return true;
  if (slotMaxRating != null && playerRating > slotMaxRating) return true;
  return false;
}

function DraggablePlayerChip({
  assignment, slotId, onPlayerClick, slotMinRating, slotMaxRating, searchQuery,
  allPlayers, slotDay,
}: {
  assignment: Assignment;
  slotId: string;
  onPlayerClick?: (id: string) => void;
  slotMinRating?: number | null;
  slotMaxRating?: number | null;
  searchQuery?: string;
  allPlayers?: UnplacedPlayer[];
  slotDay?: string;
}) {
  const { t } = useTranslation('cycles');
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `player-${assignment.id}`,
    data: { type: 'player', assignmentId: assignment.id, sourceSlotId: slotId, assignment },
  });

  const playerInfo = allPlayers?.find(p => p.id === assignment.intake_request_id);
  const confScore = assignment.confidence_score;
  const isManual = confScore == null;
  const displayScore = confScore ?? (playerInfo ? computeManualScore(assignment, { start_time: '', end_time: '', min_rating: slotMinRating ?? null, max_rating: slotMaxRating ?? null } as any, playerInfo) : 0);
  const confClass = displayScore >= 80
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
    : displayScore >= 60
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
      : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';

  const outOfRange = isRatingOutOfRange(assignment.player_rating, slotMinRating, slotMaxRating);
  const isSearchMatch = searchQuery && searchQuery.trim().length > 0 && assignment.player_name.toLowerCase().includes(searchQuery.toLowerCase());

  // Day availability warning
  const dayMismatch = slotDay && playerInfo?.preferred_days?.length
    ? !playerInfo.preferred_days.map(d => d.toLowerCase()).includes(slotDay.toLowerCase())
    : false;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex items-center gap-1 rounded-md pl-1.5 pr-2 py-1 text-xs transition-colors',
        outOfRange ? 'bg-amber-50 dark:bg-amber-950/30 ring-1 ring-amber-400/50' : 'bg-muted',
        isDragging ? 'opacity-30' : 'hover:bg-accent',
        isSearchMatch && 'ring-2 ring-orange-400 dark:ring-orange-500 bg-orange-50 dark:bg-orange-950/30 z-10',
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
        <span className="font-medium truncate max-w-[90px] sm:max-w-none">{assignment.player_name}</span>
        {assignment.player_rating != null && (
          <span className={cn('text-[10px]', outOfRange ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-muted-foreground')}>
            {formatRating(assignment.player_rating)}
          </span>
        )}
        {outOfRange && (
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs max-w-[200px]">
              {t('proposals.ratingOutOfRange', {
                defaultValue: 'Rating {{rating}} is outside slot range ({{min}}–{{max}})',
                rating: formatRating(assignment.player_rating!),
                min: slotMinRating != null ? formatRating(slotMinRating) : '?',
                max: slotMaxRating != null ? formatRating(slotMaxRating) : '?',
              })}
            </TooltipContent>
          </Tooltip>
        )}
        {dayMismatch && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Clock className="h-3 w-3 text-amber-500 shrink-0" />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs max-w-[200px]">
              {t('proposals.dayMismatch', {
                defaultValue: 'Player didn\'t indicate availability on this day',
              })}
            </TooltipContent>
          </Tooltip>
        )}
        {assignment.sessions_per_week > 1 && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 shrink-0 border-primary/40 text-primary">
            {assignment.sessions_per_week}×
          </Badge>
        )}
        {displayScore > 0 && (
          <Badge variant="secondary" className={cn('text-[9px] px-1 py-0 h-3.5 shrink-0', confClass, isManual && 'border border-dashed border-current/30')}>
            {displayScore}%{isManual ? '~' : ''}
          </Badge>
        )}
      </button>
    </div>
  );
}

// ── Slot Edit Popover ──

function SlotEditPopover({
  slot,
  trainerAvailabilityWindows,
  selectedDay,
  daySlots,
  allSlots,
  availableDays,
  onMoveSlot,
  onDeleteSlot,
  onPlayerClick,
  onUnassignPlayer,
}: {
  slot: SlotWithOccupancy;
  trainerAvailabilityWindows?: TrainerAvailabilityWindow[];
  selectedDay: string;
  daySlots: SlotWithOccupancy[];
  allSlots: SlotWithOccupancy[];
  availableDays: string[];
  onMoveSlot?: (slotId: string, newTrainerId: string, newStartTime: string, newEndTime: string) => void;
  onDeleteSlot?: (slotId: string) => void;
  onPlayerClick?: (intakeRequestId: string) => void;
  onUnassignPlayer?: (assignmentId: string) => void;
}) {
  const { t } = useTranslation('cycles');
  const [open, setOpen] = useState(false);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [targetDay, setTargetDay] = useState(selectedDay);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (open) {
      setStartTime(format(parseISO(slot.start_time), 'HH:mm'));
      setEndTime(format(parseISO(slot.end_time), 'HH:mm'));
      setTargetDay(selectedDay);
      setConfirmDelete(false);
    }
  }, [open, slot.start_time, slot.end_time, selectedDay]);

  // Get the trainer's availability bounds for the target day
  const trainerBounds = useMemo(() => {
    if (!trainerAvailabilityWindows) return { min: 6 * 60, max: 23 * 60 };
    const tw = trainerAvailabilityWindows.find(w => w.trainerId === slot.trainer_id);
    if (!tw) return { min: 6 * 60, max: 23 * 60 };
    const dayWindows = tw.windows.filter(w => w.day.toLowerCase() === targetDay.toLowerCase());
    if (dayWindows.length === 0) return { min: 6 * 60, max: 23 * 60 };
    let min = Infinity, max = -Infinity;
    dayWindows.forEach(w => {
      const [sh, sm] = w.start.split(':').map(Number);
      const [eh, em] = w.end.split(':').map(Number);
      min = Math.min(min, sh * 60 + (sm || 0));
      max = Math.max(max, eh * 60 + (em || 0));
    });
    return { min, max };
  }, [trainerAvailabilityWindows, slot.trainer_id, targetDay]);

  // Generate time options in 30-min increments
  const timeOptions = useMemo(() => {
    const opts: string[] = [];
    for (let m = trainerBounds.min; m <= trainerBounds.max; m += 30) {
      opts.push(minutesToHHMM(m));
    }
    return opts;
  }, [trainerBounds]);

  const startMin = (() => { const [h, m] = startTime.split(':').map(Number); return h * 60 + (m || 0); })();
  const endMin = (() => { const [h, m] = endTime.split(':').map(Number); return h * 60 + (m || 0); })();
  const isValid = endMin > startMin;

  // Get target day's slots for overlap checking
  const targetDaySlots = useMemo(() => {
    if (targetDay === selectedDay) return daySlots;
    const dayMap: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const targetDayNum = dayMap[targetDay.toLowerCase()];
    return allSlots.filter(s => {
      const d = parseISO(s.start_time);
      return getDay(d) === targetDayNum;
    });
  }, [targetDay, selectedDay, daySlots, allSlots]);

  // Check for overlaps
  const hasOverlap = useMemo(() => {
    if (!isValid) return false;
    return targetDaySlots.some(other => {
      if (other.id === slot.id) return false;
      if (other.trainer_id !== slot.trainer_id) return false;
      const otherStart = isoToMinutes(other.start_time);
      const otherEnd = otherStart + getDurationMinutes(other.start_time, other.end_time);
      return startMin < otherEnd && endMin > otherStart;
    });
  }, [targetDaySlots, slot.id, slot.trainer_id, startMin, endMin, isValid]);

  const dayChanged = targetDay !== selectedDay;
  const timeChanged = startTime !== format(parseISO(slot.start_time), 'HH:mm') || endTime !== format(parseISO(slot.end_time), 'HH:mm');
  const canApply = isValid && !hasOverlap && (dayChanged || timeChanged);

  const handleApply = () => {
    if (!onMoveSlot || !canApply) return;
    const refDate = parseISO(slot.start_time);
    let targetDate = refDate;
    if (dayChanged) {
      const dayMap: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const currentDayNum = getDay(refDate);
      const targetDayNum = dayMap[targetDay.toLowerCase()];
      const diff = (targetDayNum - currentDayNum + 7) % 7 || (targetDayNum === currentDayNum ? 0 : 7);
      targetDate = addDays(refDate, diff);
    }
    const newStart = new Date(targetDate);
    newStart.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
    const newEnd = new Date(targetDate);
    newEnd.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
    onMoveSlot(slot.id, slot.trainer_id, newStart.toISOString(), newEnd.toISOString());
    setOpen(false);
  };

  const handleDelete = () => {
    if (!onDeleteSlot) return;
    onDeleteSlot(slot.id);
    setOpen(false);
  };

  const confScoreColor = (score: number) => {
    if (score >= 80) return 'text-emerald-600 dark:text-emerald-400';
    if (score >= 60) return 'text-amber-600 dark:text-amber-400';
    return 'text-red-600 dark:text-red-400';
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1 group cursor-pointer hover:text-primary transition-colors">
          <span className="text-xs font-semibold">
            {getTimeRange(slot.start_time, slot.end_time)}
          </span>
          <Pencil className="h-2.5 w-2.5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start" side="right" onClick={(e) => e.stopPropagation()}>
        {/* Day & Time editing */}
        <div className="p-3 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t('proposals.editSlot', { defaultValue: 'Edit slot' })}
          </p>
          {availableDays.length > 1 && (
            <Select value={targetDay} onValueChange={setTargetDay}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableDays.map(d => (
                  <SelectItem key={d} value={d} className="text-xs">{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-2">
            <Select value={startTime} onValueChange={setStartTime}>
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timeOptions.filter(t => {
                  const [h, m] = t.split(':').map(Number);
                  return h * 60 + m < endMin;
                }).map(t => (
                  <SelectItem key={`s-${t}`} value={t} className="text-xs">{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">–</span>
            <Select value={endTime} onValueChange={setEndTime}>
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timeOptions.filter(t => {
                  const [h, m] = t.split(':').map(Number);
                  return h * 60 + m > startMin;
                }).map(t => (
                  <SelectItem key={`e-${t}`} value={t} className="text-xs">{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {hasOverlap && (
            <p className="text-[10px] text-destructive">
              {t('proposals.overlapWarning', { defaultValue: 'Overlaps with another slot' })}
            </p>
          )}
          {canApply && (
            <Button size="sm" className="w-full h-7 text-xs" onClick={handleApply}>
              {t('proposals.applyTimeChange', { defaultValue: 'Apply' })}
            </Button>
          )}
        </div>

        {/* Player details */}
        {slot.current_assignments.length > 0 && (
          <>
            <Separator />
            <div className="p-3 space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {t('proposals.players', { defaultValue: 'Players' })} ({slot.current_assignments.length})
              </p>
              {slot.current_assignments.map(a => {
                const oor = isRatingOutOfRange(a.player_rating, slot.min_rating, slot.max_rating);
                return (
                  <button
                    key={a.id}
                    onClick={() => { onPlayerClick?.(a.intake_request_id); setOpen(false); }}
                    className={cn(
                      'flex items-center justify-between w-full rounded-md px-2 py-1.5 text-xs hover:bg-accent transition-colors',
                      oor && 'bg-amber-50 dark:bg-amber-950/30',
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {oor && <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />}
                      <span className="font-medium truncate">{a.player_name}</span>
                      {a.player_rating != null && (
                        <span className={cn('text-[10px] shrink-0', oor ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-muted-foreground')}>
                          {formatRating(a.player_rating)}{a.player_rating_system ? ` ${a.player_rating_system}` : ''}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {a.confidence_score != null && a.confidence_score > 0 && (
                        <span className={cn('font-semibold text-[10px]', confScoreColor(a.confidence_score))}>
                          {a.confidence_score}%
                        </span>
                      )}
                      {onUnassignPlayer && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onUnassignPlayer(a.id); }}
                          className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                          title={t('proposals.playerUnassigned', { defaultValue: 'Remove player' })}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Delete slot */}
        {onDeleteSlot && (
          <>
            <Separator />
            <div className="p-3">
              {!confirmDelete ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-3 w-3" />
                  {t('proposals.deleteSlot', { defaultValue: 'Delete slot' })}
                </Button>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {t('proposals.deleteSlotConfirm', { defaultValue: 'Are you sure? Players will be unassigned.' })}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 h-7 text-xs"
                      onClick={() => setConfirmDelete(false)}
                    >
                      {t('common:cancel', { defaultValue: 'Cancel' })}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="flex-1 h-7 text-xs"
                      onClick={handleDelete}
                    >
                      {t('proposals.confirmDelete', { defaultValue: 'Delete' })}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Add Player to Slot Popover ──

function AddPlayerToSlotPopover({
  slotId,
  slot,
  allPlayers,
  currentAssignmentIds,
  onAssignPlayer,
}: {
  slotId: string;
  slot: SlotWithOccupancy;
  allPlayers: UnplacedPlayer[];
  currentAssignmentIds: Set<string>;
  onAssignPlayer: (intakeRequestId: string, slotId: string) => void;
}) {
  const { t } = useTranslation('cycles');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const slotDay = useMemo(() => {
    try { return format(new Date(slot.start_time), 'EEEE').toLowerCase(); } catch { return ''; }
  }, [slot.start_time]);

  const getMatchScore = (p: UnplacedPlayer): 'full' | 'partial' | 'mismatch' | null => {
    const hasDayPref = p.preferred_days && p.preferred_days.length > 0;
    const hasRatingRange = slot.min_rating != null || slot.max_rating != null;
    if (!hasDayPref && !hasRatingRange) return null;

    const dayOk = !hasDayPref || (p.preferred_days?.map(d => d.toLowerCase()).includes(slotDay) ?? false);
    const ratingOk = !hasRatingRange || (
      p.rating != null &&
      (slot.min_rating == null || p.rating >= slot.min_rating) &&
      (slot.max_rating == null || p.rating <= slot.max_rating)
    );

    if (dayOk && ratingOk) return 'full';
    if (dayOk || ratingOk) return 'partial';
    return 'mismatch';
  };

  const filtered = useMemo(() => {
    let list = allPlayers;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p => p.full_name.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      const order = { full: 0, partial: 1, mismatch: 2 } as const;
      const sa = getMatchScore(a);
      const sb = getMatchScore(b);
      const oa = sa ? order[sa] : 1;
      const ob = sb ? order[sb] : 1;
      if (oa !== ob) return oa - ob;
      return a.full_name.localeCompare(b.full_name);
    });
  }, [allPlayers, search, slotDay, slot.min_rating, slot.max_rating]);

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setSearch(''); }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0 text-muted-foreground hover:text-primary opacity-0 group-hover/slot:opacity-100 transition-opacity"
        >
          <UserPlus className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start" side="right" onClick={(e) => e.stopPropagation()}>
        <div className="p-2">
          <Input
            placeholder={t('proposals.searchPlayer', { defaultValue: 'Search player…' })}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs"
            autoFocus
          />
        </div>
        <div className="max-h-48 overflow-y-auto px-1 pb-1">
          {filtered.length === 0 && (
            <p className="text-xs text-muted-foreground px-2 py-2">{t('proposals.noPlayersFound', { defaultValue: 'No players found' })}</p>
          )}
          {filtered.map(p => {
            const inSlot = currentAssignmentIds.has(p.id);
            const match = getMatchScore(p);
            const matchColor = match === 'full' ? 'bg-green-500' : match === 'partial' ? 'bg-orange-400' : match === 'mismatch' ? 'bg-red-400' : null;
            return (
              <button
                key={p.id}
                disabled={inSlot}
                onClick={() => {
                  onAssignPlayer(p.id, slotId);
                  setOpen(false);
                  setSearch('');
                }}
                className={cn(
                  'flex items-center justify-between w-full rounded-md px-2 py-1.5 text-xs transition-colors',
                  inSlot ? 'opacity-40 cursor-not-allowed' : 'hover:bg-accent cursor-pointer',
                )}
              >
                <span className="flex items-center gap-1.5 font-medium truncate">
                  {matchColor && <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', matchColor)} />}
                  {p.full_name}
                </span>
                {p.rating != null && (
                  <span className="text-[10px] text-muted-foreground shrink-0 ml-1">
                    {formatRating(p.rating)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Draggable Slot Card ──

function DraggableSlotCard({
  slot, onPlayerClick, canDragSlot,
  trainerAvailabilityWindows, selectedDay, daySlots, allSlots, availableDays, onMoveSlot, onDeleteSlot, searchQuery,
  allPlayers, onAssignPlayer, onUnassignPlayer, onToggleSlotPrivacy,
}: {
  slot: SlotWithOccupancy;
  onPlayerClick?: (id: string) => void;
  canDragSlot: boolean;
  trainerAvailabilityWindows?: TrainerAvailabilityWindow[];
  selectedDay: string;
  daySlots: SlotWithOccupancy[];
  allSlots: SlotWithOccupancy[];
  availableDays: string[];
  onMoveSlot?: (slotId: string, newTrainerId: string, newStartTime: string, newEndTime: string) => void;
  onDeleteSlot?: (slotId: string) => void;
  searchQuery?: string;
  allPlayers?: UnplacedPlayer[];
  onAssignPlayer?: (intakeRequestId: string, slotId: string) => void;
  onUnassignPlayer?: (assignmentId: string) => void;
  onToggleSlotPrivacy?: (slotId: string, value: boolean) => void;
}) {
  const { t } = useTranslation('cycles');
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

  const slotDayName = useMemo(() => {
    try { return format(parseISO(slot.start_time), 'EEEE', { locale: enUS }); } catch { return ''; }
  }, [slot.start_time]);

  const ratingSpread = useMemo(() => getRatingSpread(slot.current_assignments), [slot.current_assignments]);

  const currentAssignmentIds = useMemo(
    () => new Set(slot.current_assignments.map(a => a.intake_request_id)),
    [slot.current_assignments]
  );

  return (
    <Card
      ref={setDragRef}
      className={cn(
        'border-l-4 transition-all min-h-full group/slot',
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
            <SlotEditPopover
              slot={slot}
              trainerAvailabilityWindows={trainerAvailabilityWindows}
              selectedDay={selectedDay}
              daySlots={daySlots}
              allSlots={allSlots}
              availableDays={availableDays}
              onMoveSlot={onMoveSlot}
              onDeleteSlot={onDeleteSlot}
              onPlayerClick={onPlayerClick}
              onUnassignPlayer={onUnassignPlayer}
            />
          </div>
          <div className="flex items-center gap-1">
            {allPlayers && onAssignPlayer && (
              <AddPlayerToSlotPopover
                slotId={slot.id}
                slot={slot}
                allPlayers={allPlayers}
                currentAssignmentIds={currentAssignmentIds}
                onAssignPlayer={onAssignPlayer}
              />
            )}
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
              <Clock className="h-2.5 w-2.5" />
              {duration}'
            </Badge>
          </div>
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
          {onToggleSlotPrivacy && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleSlotPrivacy(slot.id, !slot.is_marked_full); }}
                    className={cn(
                      'p-0.5 rounded transition-colors',
                      slot.is_marked_full
                        ? 'text-purple-600 dark:text-purple-400 hover:text-purple-700'
                        : 'text-muted-foreground/40 hover:text-muted-foreground'
                    )}
                  >
                    {slot.is_marked_full ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {slot.is_marked_full
                    ? t('proposals.slotPrivate', { defaultValue: 'Private — hidden from public' })
                    : t('proposals.slotPublic', { defaultValue: 'Public — click to mark as private' })}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* Rating range indicator */}
        {(slot.min_rating != null || slot.max_rating != null) && (
          <div className="text-[10px] text-muted-foreground">
            {slot.rating_system ? `${slot.rating_system} ` : ''}
            {slot.min_rating != null ? formatRating(slot.min_rating) : '?'}–{slot.max_rating != null ? formatRating(slot.max_rating) : '?'}
          </div>
        )}

        {/* Level spread warning */}
        {ratingSpread != null && ratingSpread > 2.0 && (
          <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>{t('proposals.levelSpread', { defaultValue: 'Level spread: {{spread}} pts', spread: ratingSpread.toFixed(1) })}</span>
          </div>
        )}

        {/* Player chips */}
        {currentP > 0 && (
          <div className="flex flex-col gap-1">
            {slot.current_assignments.map(assignment => (
              <DraggablePlayerChip
                key={assignment.id}
                assignment={assignment}
                slotId={slot.id}
                onPlayerClick={onPlayerClick}
                slotMinRating={slot.min_rating}
                slotMaxRating={slot.max_rating}
                searchQuery={searchQuery}
                allPlayers={allPlayers}
                slotDay={slotDayName}
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
          <Card className="border-l-4 border-l-muted-foreground/30 min-h-full opacity-50 bg-[repeating-linear-gradient(135deg,transparent,transparent_4px,hsl(var(--muted))_4px,hsl(var(--muted))_6px)]">
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
  cellId, children, hasSlot, onCreateSlot,
}: {
  cellId: string;
  children?: React.ReactNode;
  hasSlot: boolean;
  onCreateSlot?: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: cellId,
    data: { type: 'cell', cellId },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'group/cell h-full min-h-[60px] rounded-md border border-dashed border-transparent transition-all p-0.5 relative',
        !hasSlot && 'border-border/30',
        isOver && !hasSlot && 'border-primary/50 bg-primary/5 scale-[1.01]',
        isOver && hasSlot && 'ring-1 ring-primary/30',
      )}
    >
      {children}
      {!hasSlot && onCreateSlot && (
        <button
          onClick={onCreateSlot}
          className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/cell:opacity-100 transition-opacity"
          aria-label="Add slot"
        >
          <Plus className="h-4 w-4 text-muted-foreground" />
        </button>
      )}
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
        <span className="text-muted-foreground text-[10px]">{formatRating(assignment.player_rating)}</span>
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

// ── Draggable Unplaced Player Card ──

function DraggableUnplacedPlayer({
  player, onPlayerClick,
}: {
  player: UnplacedPlayer;
  onPlayerClick?: (id: string) => void;
}) {
  const { t } = useTranslation('cycles');
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `unplaced-${player.id}`,
    data: { type: 'unplaced-player', intakeRequestId: player.id, player },
  });

  const lessonTypes = Array.isArray(player.lesson_type) ? player.lesson_type : [player.lesson_type];

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex items-start gap-1.5 rounded-md border border-border bg-background p-2 text-xs transition-colors',
        isDragging ? 'opacity-30' : 'hover:bg-accent/50',
      )}
    >
      <button
        {...listeners}
        {...attributes}
        className="cursor-grab active:cursor-grabbing p-0.5 touch-none mt-0.5 shrink-0"
        aria-label="Drag player"
      >
        <GripVertical className="h-3 w-3 text-muted-foreground" />
      </button>
      <button
        onClick={() => onPlayerClick?.(player.id)}
        className="flex flex-col gap-0.5 cursor-pointer min-w-0 text-left"
      >
        <span className="font-medium truncate">{player.full_name}</span>
        <div className="flex flex-wrap gap-1">
          {player.rating != null && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5">
              {formatRating(player.rating)}{player.rating_system ? ` ${player.rating_system}` : ''}
            </Badge>
          )}
          {lessonTypes.map(lt => (
            <Badge key={lt} variant="secondary" className="text-[9px] px-1 py-0 h-3.5">
              {t(`lessonTypes.${lt}`, { defaultValue: lt })}
            </Badge>
          ))}
          {player.skip_reason && (
            <Badge variant="destructive" className="text-[9px] px-1 py-0 h-3.5">
              {t(`skipReasons.${player.skip_reason}.short`, { defaultValue: 'Skipped' })}
            </Badge>
          )}
          {(player.sessions_per_week ?? 1) > 1 && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 border-primary/40 text-primary">
              {player.sessions_per_week}×/wk
            </Badge>
          )}
        </div>
        {player.preferred_days.length > 0 && (
          <span className="text-[10px] text-muted-foreground truncate">
            {player.preferred_days.slice(0, 3).join(', ')}{player.preferred_days.length > 3 ? '…' : ''}
          </span>
        )}
      </button>
    </div>
  );
}

// ── Unplaced Player Drag Overlay ──

function UnplacedPlayerDragOverlay({ player }: { player: UnplacedPlayer }) {
  return (
    <div className="flex items-center gap-1 bg-muted rounded-md px-2 py-1 text-xs shadow-lg border border-border">
      <GripVertical className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium">{player.full_name}</span>
      {player.rating != null && (
        <span className="text-muted-foreground text-[10px]">{formatRating(player.rating)}</span>
      )}
    </div>
  );
}

// ── Droppable Unplaced Pool ──

function DroppableUnplacedPool({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'unplaced-pool',
    data: { type: 'unplaced-pool' },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex-1 overflow-y-auto space-y-1.5 p-2 rounded-md transition-colors min-h-[100px]',
        isOver && 'bg-primary/5 ring-1 ring-primary/30',
      )}
    >
      {children}
    </div>
  );
}

// ── Main Grid ──

export default function ProposalScheduleGrid({
  slots, trainerAvailabilityWindows, onPlayerClick, onMovePlayer, onMoveSlot, onSwapSlots, onDeleteSlot, onCreateSlot, onUndo,
  unplacedPlayers, allPlayers, onAssignPlayer, onUnassignPlayer,
}: ProposalScheduleGridProps) {
  const { t, i18n } = useTranslation('cycles');
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;
  const [activeData, setActiveData] = useState<{
    type: 'player' | 'slot' | 'unplaced-player';
    assignment?: Assignment;
    slot?: SlotWithOccupancy;
    player?: UnplacedPlayer;
  } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [unplacedSearch, setUnplacedSearch] = useState('');

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

  // Filter unplaced players by global search query AND local sidebar search
  const filteredUnplaced = useMemo(() => {
    if (!unplacedPlayers) return [];
    let result = unplacedPlayers;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(p => p.full_name.toLowerCase().includes(q));
    }
    if (unplacedSearch.trim()) {
      const q = unplacedSearch.toLowerCase();
      result = result.filter(p => p.full_name.toLowerCase().includes(q));
    }
    return result;
  }, [unplacedPlayers, searchQuery, unplacedSearch]);

  // Compute which days have placed players matching the search query
  const daysWithSearchMatches = useMemo(() => {
    if (!searchQuery.trim()) return new Map<string, number>();
    const q = searchQuery.toLowerCase();
    const matches = new Map<string, number>();
    slots.forEach(slot => {
      const day = getDayKey(slot.start_time);
      slot.current_assignments.forEach(a => {
        if (a.player_name.toLowerCase().includes(q)) {
          matches.set(day, (matches.get(day) || 0) + 1);
        }
      });
    });
    return matches;
  }, [slots, searchQuery]);

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

  // Auto-switch to the day with search matches (only when exactly one day matches)
  const prevSearchRef = useRef(searchQuery);
  useEffect(() => {
    if (searchQuery.trim() && searchQuery !== prevSearchRef.current) {
      const matchingDays = Array.from(daysWithSearchMatches.keys());
      if (matchingDays.length === 1 && matchingDays[0] !== selectedDay) {
        setSelectedDay(matchingDays[0]);
      }
    }
    prevSearchRef.current = searchQuery;
  }, [searchQuery, daysWithSearchMatches, selectedDay]);

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
    } else if (data.type === 'unplaced-player') {
      setActiveData({ type: 'unplaced-player', player: data.player as UnplacedPlayer });
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
        // Can't swap with blocked slots
        if (overlappingSlot.is_blocked) {
          toast.warning(t('proposals.slotBlocked', { defaultValue: 'Cannot move here — trainer has an existing lesson' }));
          return;
        }
        // If the overlapping slot is empty (no players), allow swap
        if (onSwapSlots) {
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
        }
        return;
      }

      pushUndo(t('proposals.undoSlotMove', { defaultValue: 'Slot move' }));
      onMoveSlot(slot.id, newTrainerId, newStart.toISOString(), newEnd.toISOString());
    }
    // Unplaced player drag → drop onto a cell (assign to slot)
    if (activeType === 'unplaced-player' && onAssignPlayer) {
      const intakeRequestId = active.data.current?.intakeRequestId as string;
      const overCellId = over.id as string;
      if (!overCellId.startsWith('cell__')) return;

      const parts = overCellId.split('__');
      const trainerId = parts[1];
      const timeRow = parseInt(parts[2]);

      // Find the slot at this cell
      let resolvedSlot = slotLookup.get(`${trainerId}__${timeRow}`);
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

      if (!resolvedSlot) {
        toast.warning(t('proposals.noSlotHere', { defaultValue: 'No slot here — drop onto an existing slot' }));
        return;
      }
      if (resolvedSlot.is_blocked) return;

      pushUndo(t('proposals.undoAssign', { defaultValue: 'Player assignment' }));
      onAssignPlayer(intakeRequestId, resolvedSlot.id);
      return;
    }

    // Player drag → drop onto unplaced pool (unassign)
    if (activeType === 'player' && onUnassignPlayer) {
      const overData = over.data.current;
      if (overData?.type === 'unplaced-pool') {
        const assignmentId = active.data.current?.assignmentId as string;
        pushUndo(t('proposals.undoUnassign', { defaultValue: 'Player unassignment' }));
        onUnassignPlayer(assignmentId);
        return;
      }
    }
  }, [activeData, onMovePlayer, onMoveSlot, onSwapSlots, onAssignPlayer, onUnassignPlayer, slotLookup, daySlots, slotRowSpans, selectedDay, trainerAvailabilityWindows, pushUndo, t]);

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
      {/* Search + Day tabs + Undo button */}
      <div className="flex flex-col gap-3">
        <div className="relative max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('proposals.searchPlayers', { defaultValue: 'Search players...' })}
            className="h-8 text-xs pl-8"
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Tabs value={selectedDay} onValueChange={setSelectedDay} className="flex-1">
            <TabsList className="flex-wrap h-auto gap-1">
              {availableDays.map(day => {
                const dayS = dayGroups.get(day) || [];
                const playerCount = dayS.reduce((sum, s) => sum + s.current_assignments.length, 0);
                const matchCount = daysWithSearchMatches.get(day) || 0;
                return (
                  <TabsTrigger key={day} value={day} className="text-xs sm:text-sm relative">
                    {getLocalizedDayName(day, dateFnsLocale)}
                    <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0 h-4">
                      {playerCount}
                    </Badge>
                    {matchCount > 0 && (
                      <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-orange-400 dark:bg-orange-500 border border-background" />
                    )}
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
      </div>

      {/* Time-row × Trainer-column grid + Sidebar */}
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex gap-4">
          {/* Grid */}
          <div className="flex-1 overflow-x-auto">
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
                        return null;
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
                          <DroppableCell
                            cellId={cellId}
                            hasSlot={!!slot}
                            onCreateSlot={!slot && onCreateSlot ? () => {
                              // Build ISO timestamps from the selected day + rowMinute
                              const refSlot = daySlots[0];
                              if (!refSlot) return;
                              const refDate = parseISO(refSlot.start_time);
                              const dayMap: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
                              const currentDayNum = getDay(refDate);
                              const targetDayNum = dayMap[selectedDay.toLowerCase()];
                              const diff = ((targetDayNum - currentDayNum) + 7) % 7;
                              const targetDate = diff === 0 ? refDate : addDays(refDate, diff);
                              const startDate = new Date(targetDate);
                              startDate.setHours(Math.floor(rowMinute / 60), rowMinute % 60, 0, 0);
                              const endDate = new Date(startDate);
                              endDate.setMinutes(endDate.getMinutes() + 60);
                              onCreateSlot(trainer.id, startDate.toISOString(), endDate.toISOString());
                            } : undefined}
                          >
                            {slot && slot.is_blocked ? (
                              <BlockedSlotCard slot={slot} />
                            ) : slot ? (
                              <DraggableSlotCard
                                slot={slot}
                                onPlayerClick={onPlayerClick}
                                canDragSlot={canDragSlot}
                                trainerAvailabilityWindows={trainerAvailabilityWindows}
                                selectedDay={selectedDay}
                                daySlots={daySlots}
                                allSlots={slots}
                                availableDays={availableDays}
                                onMoveSlot={onMoveSlot}
                                onDeleteSlot={onDeleteSlot}
                                searchQuery={searchQuery}
                                allPlayers={allPlayers}
                                onAssignPlayer={onAssignPlayer}
                                onUnassignPlayer={onUnassignPlayer}
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

          {/* Unplaced Players Sidebar */}
          {unplacedPlayers && (
            <div className={cn(
              'shrink-0 sticky top-4 self-start transition-all',
              sidebarOpen ? 'w-[280px]' : 'w-10',
            )}>
              {sidebarOpen ? (
                <Card className="h-[calc(100vh-200px)] flex flex-col">
                  <div className="p-3 border-b border-border">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <UserCircle className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-semibold">
                          {t('proposals.unplacedPlayers', { defaultValue: 'Unplaced' })}
                        </span>
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                          {filteredUnplaced.length}
                        </Badge>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => setSidebarOpen(false)}
                      >
                        <PanelRightClose className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="px-2 pb-2">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <Input
                        value={unplacedSearch}
                        onChange={(e) => setUnplacedSearch(e.target.value)}
                        placeholder={t('proposals.searchPlayers', { defaultValue: 'Search players...' })}
                        className="h-7 text-xs pl-7 pr-7"
                      />
                      {unplacedSearch && (
                        <button
                          onClick={() => setUnplacedSearch('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          <span className="text-xs">✕</span>
                        </button>
                      )}
                    </div>
                  </div>
                  <DroppableUnplacedPool>
                    {filteredUnplaced.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4 italic">
                        {(searchQuery || unplacedSearch)
                          ? t('proposals.noSearchResults', { defaultValue: 'No players found' })
                          : t('proposals.allPlaced', { defaultValue: 'All players are placed' })
                        }
                      </p>
                    ) : (
                      filteredUnplaced.map(player => (
                        <DraggableUnplacedPlayer
                          key={player.id}
                          player={player}
                          onPlayerClick={onPlayerClick}
                        />
                      ))
                    )}
                  </DroppableUnplacedPool>
                </Card>
              ) : (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-10 w-10 relative"
                        onClick={() => setSidebarOpen(true)}
                      >
                        <PanelRightOpen className="h-4 w-4" />
                        {unplacedPlayers.length > 0 && (
                          <Badge variant="destructive" className="absolute -top-1.5 -right-1.5 text-[9px] px-1 py-0 h-4 min-w-4 flex items-center justify-center">
                            {unplacedPlayers.length}
                          </Badge>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      {t('proposals.showUnplaced', { defaultValue: 'Show unplaced players' })} ({unplacedPlayers.length})
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          )}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeData?.type === 'player' && activeData.assignment && (
            <PlayerDragOverlay assignment={activeData.assignment} />
          )}
          {activeData?.type === 'slot' && activeData.slot && (
            <SlotDragOverlay slot={activeData.slot} />
          )}
          {activeData?.type === 'unplaced-player' && activeData.player && (
            <UnplacedPlayerDragOverlay player={activeData.player} />
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
