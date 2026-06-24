import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO, getDay, startOfWeek, addDays } from 'date-fns';
import { nl, es, de, fr, enUS, it as itLocale, type Locale } from 'date-fns/locale';
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
import {
  Users, Clock, GripVertical, Search, PanelRightClose, PanelRightOpen,
  UserPlus, AlertTriangle, X, Pencil, Trash2,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type SlotWithBookings, type BookedPlayer } from '@/lib/slotTypes';

// ── Types ──

export interface KnownPlayer {
  id: string;
  full_name: string;
  skill_rating: number | null;
  rating_system: string;
  is_guest: boolean;
}

interface AcademyDayGridProps {
  slots: SlotWithBookings[];
  currentDate: Date;
  allKnownPlayers: KnownPlayer[];
  trainers: { id: string; name: string; avatar: string | null }[];
  onMovePlayer?: (bookingId: string, newSlotId: string) => void;
  onRemovePlayer?: (bookingId: string) => void;
  onAddPlayerToSlot?: (slot: SlotWithBookings) => void;
  onEditBooking?: (bookingId: string) => void;
  onEditSlot?: (slot: SlotWithBookings) => void;
  onDeleteSlot?: (slot: SlotWithBookings) => void;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
  onCellClick?: (day: Date, hour: number) => void;
}

// ── Helpers ──

const dateFnsLocaleMap: Record<string, Locale> = { nl, es, de, fr, en: enUS, it: itLocale };

function formatRating(r: number): string {
  return r.toFixed(1);
}

function getTimeRange(startIso: string, endIso: string): string {
  return `${format(parseISO(startIso), 'HH:mm')} – ${format(parseISO(endIso), 'HH:mm')}`;
}

function getDurationMinutes(startIso: string, endIso: string): number {
  return Math.round((parseISO(endIso).getTime() - parseISO(startIso).getTime()) / 60000);
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

function getRatingSpread(players: BookedPlayer[]): number | null {
  const ratings = players.map(p => p.skillRating).filter((r): r is number => r != null);
  if (ratings.length < 2) return null;
  return Math.max(...ratings) - Math.min(...ratings);
}

function getStatusColor(status: string): string {
  if (status === 'confirmed') return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  if (status === 'pending') return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
  return 'bg-muted text-muted-foreground';
}

function getSlotBorderColor(slot: SlotWithBookings): string {
  if (slot.booked_players.length === 0) return 'border-l-border';
  const allConfirmed = slot.booked_players.every(p => p.status === 'confirmed');
  if (allConfirmed) return 'border-l-emerald-500 dark:border-l-emerald-600';
  return 'border-l-amber-500 dark:border-l-amber-600';
}

// ── Draggable Player Chip ──

function DraggableBookedPlayer({
  player, slotId, slotMinRating, slotMaxRating, searchQuery, onRemove, onEditBooking,
}: {
  player: BookedPlayer;
  slotId: string;
  slotMinRating?: number | null;
  slotMaxRating?: number | null;
  searchQuery?: string;
  onRemove?: (bookingId: string) => void;
  onEditBooking?: (bookingId: string) => void;
}) {
  const { t } = useTranslation('academy');
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `booked-${player.bookingId}`,
    data: { type: 'booked-player', bookingId: player.bookingId, sourceSlotId: slotId, player },
  });

  const outOfRange = isRatingOutOfRange(player.skillRating, slotMinRating, slotMaxRating);
  const isSearchMatch = searchQuery && searchQuery.trim().length > 0 && player.name.toLowerCase().includes(searchQuery.toLowerCase());

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex items-center gap-1 rounded-md pl-1.5 pr-1 py-1 text-xs transition-colors group/chip',
        outOfRange ? 'bg-amber-50 dark:bg-amber-950/30 ring-1 ring-amber-400/50' : 'bg-muted',
        isDragging ? 'opacity-30' : 'hover:bg-accent',
        isSearchMatch && 'ring-2 ring-orange-400 dark:ring-orange-500 bg-orange-50 dark:bg-orange-950/30 z-10',
      )}
    >
      <button
        {...listeners}
        {...attributes}
        className="cursor-grab active:cursor-grabbing p-0.5 touch-none"
        aria-label={t('calendar.dragPlayer', { defaultValue: 'Drag player' })}
      >
        <GripVertical className="h-3 w-3 text-muted-foreground" />
      </button>
      <button
        onClick={() => onEditBooking?.(player.bookingId)}
        className="flex items-center gap-1 cursor-pointer min-w-0 flex-1"
      >
        <span className="font-medium truncate max-w-[90px] sm:max-w-none">{player.name}</span>
        {player.skillRating != null && (
          <span className={cn('text-[10px]', outOfRange ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-muted-foreground')}>
            {formatRating(player.skillRating)}
          </span>
        )}
        {outOfRange && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs max-w-[200px]">
                {t('calendar.ratingOutsideRange', { defaultValue: 'Rating {{rating}} outside slot range', rating: formatRating(player.skillRating!) })}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {player.isGuest && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 shrink-0">{t('calendar.guest', { defaultValue: 'Guest' })}</Badge>
        )}
        <Badge variant="secondary" className={cn('text-[9px] px-1 py-0 h-3.5 shrink-0', getStatusColor(player.status))}>
          {player.status === 'confirmed' ? '✓' : '⏳'}
        </Badge>
      </button>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(player.bookingId); }}
          className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover/chip:opacity-100"
          aria-label={t('calendar.removePlayer', { defaultValue: 'Remove player' })}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// ── Slot Card ──

function SlotCard({
  slot, searchQuery, onRemovePlayer, onEditBooking, onEditSlot, onDeleteSlot, onBookForPlayer,
}: {
  slot: SlotWithBookings;
  searchQuery?: string;
  onRemovePlayer?: (bookingId: string) => void;
  onEditBooking?: (bookingId: string) => void;
  onEditSlot?: (slot: SlotWithBookings) => void;
  onDeleteSlot?: (slot: SlotWithBookings) => void;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
}) {
  const { t } = useTranslation('academy');
  const { setNodeRef, isOver } = useDroppable({
    id: `slot-drop-${slot.id}`,
    data: { type: 'slot-drop', slotId: slot.id },
  });

  const duration = getDurationMinutes(slot.start_time, slot.end_time);
  const maxP = slot.max_participants || 4;
  const currentP = slot.booked_players.length;
  const isFull = currentP >= maxP || !slot.is_public;
  const ratingSpread = getRatingSpread(slot.booked_players);

  return (
    <Card
      ref={setNodeRef}
      className={cn(
        'border-l-4 transition-all group/slot',
        getSlotBorderColor(slot),
        slot.is_past && 'opacity-50',
        isOver && !isFull && 'ring-2 ring-primary/40 bg-primary/5',
      )}
    >
      <CardContent className="p-2.5 space-y-1.5">
        {/* Time + duration */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">
            {getTimeRange(slot.start_time, slot.end_time)}
          </span>
          <div className="flex items-center gap-1">
            {!slot.is_past && onEditSlot && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 text-muted-foreground hover:text-primary opacity-0 group-hover/slot:opacity-100 transition-opacity"
                onClick={() => onEditSlot(slot)}
                aria-label={t('calendar.editSlotLabel', { defaultValue: 'Edit slot' })}
              >
                <Pencil className="h-3 w-3" />
              </Button>
            )}
            {!slot.is_past && onDeleteSlot && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/slot:opacity-100 transition-opacity"
                onClick={() => onDeleteSlot(slot)}
                aria-label={t('calendar.deleteSlotLabel', { defaultValue: 'Delete slot' })}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
            {!slot.is_past && onBookForPlayer && !isFull && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 text-muted-foreground hover:text-primary opacity-0 group-hover/slot:opacity-100 transition-opacity"
                onClick={() => onBookForPlayer(slot)}
                aria-label={t('calendar.addPlayerToSlot', { defaultValue: 'Add player to slot' })}
              >
                <UserPlus className="h-3 w-3" />
              </Button>
            )}
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
              <Clock className="h-2.5 w-2.5" />
              {duration}'
            </Badge>
          </div>
        </div>

        {/* Occupancy */}
        <div className="flex items-center justify-between text-xs">
          <span className={cn('flex items-center gap-1 font-medium', currentP >= maxP ? 'text-primary' : 'text-muted-foreground')}>
            <Users className="h-3 w-3" />
            {currentP}/{maxP}
            {isFull && (
              <Badge variant="default" className="text-[9px] px-1 py-0 h-3.5 ml-1">{t('calendar.fullBadge', { defaultValue: 'FULL' })}</Badge>
            )}
          </span>
          {slot.location_name && (
            <span className="text-[10px] text-muted-foreground truncate max-w-[80px]">{slot.location_name}</span>
          )}
        </div>

        {/* Rating range */}
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
            <span>{t('calendar.ratingSpread', { defaultValue: 'Spread: {{spread}} pts', spread: ratingSpread.toFixed(1) })}</span>
          </div>
        )}

        {/* Player chips */}
        {currentP > 0 && (
          <div className="flex flex-col gap-1">
            {slot.booked_players.map(player => (
              <DraggableBookedPlayer
                key={player.bookingId}
                player={player}
                slotId={slot.id}
                slotMinRating={slot.min_rating}
                slotMaxRating={slot.max_rating}
                searchQuery={searchQuery}
                onRemove={onRemovePlayer}
                onEditBooking={onEditBooking}
              />
            ))}
          </div>
        )}

        {currentP === 0 && (
          <p className="text-[10px] text-muted-foreground italic">{t('calendar.noPlayers', { defaultValue: 'No players' })}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Drag Overlays ──

function PlayerDragOverlay({ player }: { player: BookedPlayer }) {
  return (
    <div className="flex items-center gap-1 bg-muted rounded-md px-2 py-1 text-xs shadow-lg border border-border">
      <GripVertical className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium">{player.name}</span>
      {player.skillRating != null && (
        <span className="text-muted-foreground text-[10px]">{formatRating(player.skillRating)}</span>
      )}
      <Badge variant="secondary" className={cn('text-[9px] px-1 py-0 h-3.5', getStatusColor(player.status))}>
        {player.status === 'confirmed' ? '✓' : '⏳'}
      </Badge>
    </div>
  );
}

function SidebarPlayerDragOverlay({ player }: { player: KnownPlayer }) {
  return (
    <div className="flex items-center gap-1 bg-muted rounded-md px-2 py-1 text-xs shadow-lg border border-border">
      <GripVertical className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium">{player.full_name}</span>
      {player.skill_rating != null && (
        <span className="text-muted-foreground text-[10px]">{formatRating(player.skill_rating)}</span>
      )}
    </div>
  );
}

// ── Draggable Sidebar Player ──

function DraggableSidebarPlayer({ player }: { player: KnownPlayer }) {
  const { t } = useTranslation('academy');
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `sidebar-${player.id}`,
    data: { type: 'sidebar-player', player },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex items-center gap-1.5 rounded-md border border-border bg-background p-1.5 text-xs transition-colors',
        isDragging ? 'opacity-30' : 'hover:bg-accent/50',
      )}
    >
      <button
        {...listeners}
        {...attributes}
        className="cursor-grab active:cursor-grabbing p-0.5 touch-none shrink-0"
        aria-label={t('calendar.dragPlayer', { defaultValue: 'Drag player' })}
      >
        <GripVertical className="h-3 w-3 text-muted-foreground" />
      </button>
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <span className="font-medium truncate">{player.full_name}</span>
        {player.skill_rating != null && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 shrink-0">
            {formatRating(player.skill_rating)}
          </Badge>
        )}
        {player.is_guest && (
          <Badge variant="secondary" className="text-[9px] px-1 py-0 h-3.5 shrink-0">{t('calendar.guest', { defaultValue: 'Guest' })}</Badge>
        )}
      </div>
    </div>
  );
}

// ── Droppable Sidebar Pool (for removing players) ──

function DroppableSidebarPool({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'sidebar-pool',
    data: { type: 'sidebar-pool' },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex-1 overflow-y-auto space-y-1 p-2 rounded-md transition-colors min-h-[100px]',
        isOver && 'bg-destructive/5 ring-1 ring-destructive/30',
      )}
    >
      {children}
    </div>
  );
}

// ── Main Grid Component ──

export default function AcademyDayGrid({
  slots, currentDate, allKnownPlayers, trainers,
  onMovePlayer, onRemovePlayer, onAddPlayerToSlot: _onAddPlayerToSlot, onEditBooking,
  onEditSlot, onDeleteSlot, onBookForPlayer, onCellClick: _onCellClick,
}: AcademyDayGridProps) {
  const { t, i18n } = useTranslation('academy');
  const dateFnsLocale = dateFnsLocaleMap[i18n.language] || enUS;

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery] = useState('');
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [activeData, setActiveData] = useState<{
    type: 'booked-player' | 'sidebar-player';
    player?: BookedPlayer;
    sidebarPlayer?: KnownPlayer;
    bookingId?: string;
    sourceSlotId?: string;
  } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Week days from currentDate
  const weekStart = useMemo(() => startOfWeek(currentDate, { weekStartsOn: 1 }), [currentDate]);
  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      return {
        date,
        dayKey: format(date, 'yyyy-MM-dd'),
        label: format(date, 'EEE', { locale: dateFnsLocale }),
        fullLabel: format(date, 'EEEE d MMM', { locale: dateFnsLocale }),
        dayNum: getDay(date),
      };
    });
  }, [weekStart, dateFnsLocale]);

  // Selected day tab
  const currentDateKey = format(currentDate, 'yyyy-MM-dd');
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const defaultDay = weekDays.find(d => d.dayKey === currentDateKey)?.dayKey
    || weekDays.find(d => d.dayKey === todayKey)?.dayKey
    || weekDays[0].dayKey;
  const [selectedDayKey, setSelectedDayKey] = useState(defaultDay);

  // Sync selected day with parent's currentDate when it changes
  useEffect(() => {
    if (weekDays.find(d => d.dayKey === currentDateKey)) {
      setSelectedDayKey(currentDateKey);
    }
  }, [currentDateKey, weekDays]);

  // Ensure selectedDayKey is valid for this week
  const activeDayKey = weekDays.find(d => d.dayKey === selectedDayKey) ? selectedDayKey : weekDays[0].dayKey;

  // Group slots by day
  const slotsByDay = useMemo(() => {
    const map = new Map<string, SlotWithBookings[]>();
    weekDays.forEach(d => map.set(d.dayKey, []));
    slots.forEach(slot => {
      const dayKey = format(parseISO(slot.start_time), 'yyyy-MM-dd');
      const existing = map.get(dayKey);
      if (existing) existing.push(slot);
    });
    return map;
  }, [slots, weekDays]);

  // Day player counts
  const dayPlayerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    slotsByDay.forEach((daySlots, dayKey) => {
      counts.set(dayKey, daySlots.reduce((sum, s) => sum + s.booked_players.length, 0));
    });
    return counts;
  }, [slotsByDay]);

  // Slots for selected day, grouped by trainer
  const daySlots = slotsByDay.get(activeDayKey) || [];
  const slotsByTrainer = useMemo(() => {
    const map = new Map<string, SlotWithBookings[]>();
    trainers.forEach(t => map.set(t.id, []));
    daySlots.forEach(slot => {
      if (slot.trainer_id) {
        const existing = map.get(slot.trainer_id) || [];
        existing.push(slot);
        map.set(slot.trainer_id, existing);
      }
    });
    // Sort each trainer's slots by start time
    map.forEach(slots => slots.sort((a, b) => a.start_time.localeCompare(b.start_time)));
    return map;
  }, [daySlots, trainers]);

  // Filter trainers that have slots on this day (or show all)
  const activeTrainers = useMemo(() => {
    return trainers.filter(t => {
      const trainerSlots = slotsByTrainer.get(t.id) || [];
      return trainerSlots.length > 0;
    });
  }, [trainers, slotsByTrainer]);

  // All trainers with no slots (for adding)
  const emptyTrainers = useMemo(() => {
    return trainers.filter(t => {
      const trainerSlots = slotsByTrainer.get(t.id) || [];
      return trainerSlots.length === 0;
    });
  }, [trainers, slotsByTrainer]);

  // Filter sidebar players
  const filteredSidebarPlayers = useMemo(() => {
    if (!sidebarSearch.trim()) return allKnownPlayers;
    const q = sidebarSearch.toLowerCase();
    return allKnownPlayers.filter(p => p.full_name.toLowerCase().includes(q));
  }, [allKnownPlayers, sidebarSearch]);

  // DnD handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (!data) return;
    if (data.type === 'booked-player') {
      setActiveData({
        type: 'booked-player',
        player: data.player,
        bookingId: data.bookingId,
        sourceSlotId: data.sourceSlotId,
      });
    } else if (data.type === 'sidebar-player') {
      setActiveData({
        type: 'sidebar-player',
        sidebarPlayer: data.player,
      });
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveData(null);
    if (!over) return;

    const activeDataCurrent = active.data.current;
    const overDataCurrent = over.data.current;
    if (!activeDataCurrent || !overDataCurrent) return;

    // Move booked player to another slot
    if (activeDataCurrent.type === 'booked-player' && overDataCurrent.type === 'slot-drop') {
      const bookingId = activeDataCurrent.bookingId as string;
      const targetSlotId = overDataCurrent.slotId as string;
      const sourceSlotId = activeDataCurrent.sourceSlotId as string;
      if (targetSlotId !== sourceSlotId && onMovePlayer) {
        onMovePlayer(bookingId, targetSlotId);
      }
    }

    // Remove booked player (drop to sidebar)
    if (activeDataCurrent.type === 'booked-player' && overDataCurrent.type === 'sidebar-pool') {
      const bookingId = activeDataCurrent.bookingId as string;
      onRemovePlayer?.(bookingId);
    }

    // Add sidebar player to a slot
    if (activeDataCurrent.type === 'sidebar-player' && overDataCurrent.type === 'slot-drop') {
      const targetSlotId = overDataCurrent.slotId as string;
      const targetSlot = slots.find(s => s.id === targetSlotId);
      if (targetSlot && onBookForPlayer) {
        onBookForPlayer(targetSlot);
      }
    }
  }, [onMovePlayer, onRemovePlayer, onBookForPlayer, slots]);

  const selectedDay = weekDays.find(d => d.dayKey === activeDayKey);

  return (
    <TooltipProvider>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="space-y-4">

          {/* Day tabs */}
          <Tabs value={activeDayKey} onValueChange={setSelectedDayKey}>
            <TabsList className="w-full h-auto flex-wrap gap-1 bg-transparent p-0">
              {weekDays.map(day => {
                const count = dayPlayerCounts.get(day.dayKey) || 0;
                const slotCount = (slotsByDay.get(day.dayKey) || []).length;
                const isToday = day.dayKey === todayKey;
                return (
                  <TabsTrigger
                    key={day.dayKey}
                    value={day.dayKey}
                    className={cn(
                      'flex-1 min-w-0 flex flex-col gap-0.5 py-2 px-1 rounded-md border data-[state=active]:border-primary data-[state=active]:bg-primary/5',
                      isToday && 'ring-1 ring-primary/30',
                    )}
                  >
                    <span className="text-xs font-semibold capitalize">{day.label}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {t('calendar.slotsPlayersCount', { defaultValue: '{{slots}} slots · {{players}} players', slots: slotCount, players: count })}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>

          {/* Day label */}
          {selectedDay && (
            <p className="text-sm font-medium text-muted-foreground capitalize">{selectedDay.fullLabel}</p>
          )}

          {/* Grid + Sidebar */}
          <div className="flex gap-4">
            {/* Main grid area */}
            <div className="flex-1 min-w-0">
              {activeTrainers.length === 0 && (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-sm">{t('calendar.noSlotsForDay', { defaultValue: 'No slots on this day' })}</p>
                </div>
              )}

              {activeTrainers.length > 0 && (
                <div className={cn(
                  'grid gap-4',
                  activeTrainers.length === 1 && 'grid-cols-1',
                  activeTrainers.length === 2 && 'grid-cols-1 sm:grid-cols-2',
                  activeTrainers.length >= 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
                )}>
                  {activeTrainers.map(trainer => {
                    const trainerSlots = slotsByTrainer.get(trainer.id) || [];
                    const initials = trainer.name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'T';
                    return (
                      <div key={trainer.id} className="space-y-2">
                        {/* Trainer header */}
                        <div className="flex items-center gap-2 sticky top-0 bg-background z-10 pb-1">
                          <Avatar className="h-7 w-7">
                            <AvatarImage src={trainer.avatar || undefined} alt={trainer.name} />
                            <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold truncate">{trainer.name}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {t('calendar.slotsPlayersCount', { defaultValue: '{{slots}} slots · {{players}} players', slots: trainerSlots.length, players: trainerSlots.reduce((s, sl) => s + sl.booked_players.length, 0) })}
                            </p>
                          </div>
                        </div>

                        {/* Slots column */}
                        <div className="space-y-2">
                          {trainerSlots.map(slot => (
                            <SlotCard
                              key={slot.id}
                              slot={slot}
                              searchQuery={searchQuery}
                              onRemovePlayer={onRemovePlayer}
                              onEditBooking={onEditBooking}
                              onEditSlot={onEditSlot}
                              onDeleteSlot={onDeleteSlot}
                              onBookForPlayer={onBookForPlayer}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Empty trainers note */}
              {emptyTrainers.length > 0 && activeTrainers.length > 0 && (
                <div className="mt-4 pt-4 border-t">
                  <p className="text-xs text-muted-foreground">
                    {t('calendar.trainersNoSlots', { defaultValue: 'No slots:' })}{' '}
                    {emptyTrainers.map(t => t.name).join(', ')}
                  </p>
                </div>
              )}
            </div>

            {/* Player sidebar */}
            {sidebarOpen ? (
              <div className="w-56 shrink-0 hidden md:flex flex-col border rounded-lg bg-background max-h-[600px]">
                <div className="p-2 border-b space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className="text-xs font-semibold truncate">
                        {t('calendar.allPlayers', { defaultValue: 'All Players' })}
                      </p>
                      <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                        {allKnownPlayers.length}
                      </Badge>
                    </div>
                    <button
                      onClick={() => setSidebarOpen(false)}
                      className="text-muted-foreground hover:text-foreground p-0.5 -mr-0.5 rounded hover:bg-muted/40"
                      aria-label={t('calendar.collapsePlayers', { defaultValue: 'Collapse players' })}
                      title={t('calendar.collapsePlayers', { defaultValue: 'Collapse players' })}
                    >
                      <PanelRightClose className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                    <Input
                      placeholder={t('calendar.searchPlayer', { defaultValue: 'Search…' })}
                      value={sidebarSearch}
                      onChange={(e) => setSidebarSearch(e.target.value)}
                      className="h-7 pl-7 text-xs"
                    />
                  </div>
                </div>
                <DroppableSidebarPool>
                  {filteredSidebarPlayers.map(player => (
                    <DraggableSidebarPlayer key={player.id} player={player} />
                  ))}
                  {filteredSidebarPlayers.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">
                      {t('calendar.noPlayersFound', { defaultValue: 'No players found' })}
                    </p>
                  )}
                </DroppableSidebarPool>
              </div>
            ) : (
              <button
                onClick={() => setSidebarOpen(true)}
                className="hidden md:flex shrink-0 flex-col items-center gap-2 rounded-lg border bg-background px-1.5 py-3 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                aria-label={t('calendar.expandPlayers', { defaultValue: 'Show players' })}
                title={t('calendar.expandPlayers', { defaultValue: 'Show players' })}
              >
                <PanelRightOpen className="h-4 w-4" />
                <span className="[writing-mode:vertical-rl] rotate-180 font-medium">
                  {t('calendar.allPlayers', { defaultValue: 'All Players' })}
                </span>
                <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                  {allKnownPlayers.length}
                </Badge>
              </button>
            )}
          </div>
        </div>

        {/* Drag overlay */}
        <DragOverlay>
          {activeData?.type === 'booked-player' && activeData.player && (
            <PlayerDragOverlay player={activeData.player} />
          )}
          {activeData?.type === 'sidebar-player' && activeData.sidebarPlayer && (
            <SidebarPlayerDragOverlay player={activeData.sidebarPlayer} />
          )}
        </DragOverlay>
      </DndContext>
    </TooltipProvider>
  );
}
