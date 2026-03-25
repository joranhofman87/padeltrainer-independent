import { useMemo, useState, useEffect } from "react";
import { format, startOfWeek, addDays, subDays, isToday, isBefore, isSameDay } from "date-fns";
import { nl, enUS, es, de, fr } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { CalendarSlotCard, SlotWithBookings } from "./CalendarSlotCard";
import { DayViewSlotCard } from "./DayViewSlotCard";
import { useTranslation } from "react-i18next";
import { Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const dateFnsLocales: Record<string, typeof enUS> = { nl, en: enUS, es, de, fr };
interface TrainerCalendarGridProps {
  slots: SlotWithBookings[];
  currentDate: Date;
  view: "day" | "week" | "month";
  onCellClick?: (date: Date, hour: number) => void;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
  onDuplicateCyclus?: (cyclusId: string) => void;
  onDeleteSlot?: (slot: SlotWithBookings) => void;
  onEditBooking?: (bookingId: string) => void;
  onToggleMarkedFull?: (slotId: string, value: boolean, applyToCyclus?: boolean) => void;
  onNavigatePrevious?: () => void;
  onNavigateNext?: () => void;
  showTrainerInfo?: boolean;
  onSlotClick?: (slot: SlotWithBookings) => void;
}

// Full hours for time labels and mobile view
const FULL_HOURS = Array.from({ length: 16 }, (_, i) => i + 8);
const HOUR_HEIGHT = 60; // pixels per hour
const GRID_START_HOUR = 8;
const GRID_END_HOUR = 23;
const GRID_TOTAL_HEIGHT = (GRID_END_HOUR - GRID_START_HOUR) * HOUR_HEIGHT;

export function TrainerCalendarGrid({
  slots,
  currentDate,
  view,
  onCellClick,
  onBookForPlayer,
  onDuplicateCyclus,
  onDeleteSlot,
  onEditBooking,
  onToggleMarkedFull,
  onNavigatePrevious,
  onNavigateNext,
  showTrainerInfo,
  onSlotClick,
}: TrainerCalendarGridProps) {
  const { t, i18n } = useTranslation("trainer");
  const dfLocale = dateFnsLocales[i18n.language] || dateFnsLocales[i18n.language?.split('-')[0]] || enUS;
  const [mobileSelectedDate, setMobileSelectedDate] = useState(currentDate);

  // Sync mobile selected date when currentDate changes
  useEffect(() => {
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
    const weekEnd = addDays(weekStart, 6);
    if (mobileSelectedDate < weekStart || mobileSelectedDate > weekEnd) {
      setMobileSelectedDate(currentDate);
    }
  }, [currentDate]);

  // Handle mobile day navigation - go to next/prev week when at boundaries
  const handleMobileDateChange = (newDate: Date) => {
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
    const weekEnd = addDays(weekStart, 6);
    
    if (newDate < weekStart && onNavigatePrevious) {
      onNavigatePrevious();
      // Set to the last day of the previous week
      setMobileSelectedDate(newDate);
    } else if (newDate > weekEnd && onNavigateNext) {
      onNavigateNext();
      // Set to the first day of the next week
      setMobileSelectedDate(newDate);
    } else {
      setMobileSelectedDate(newDate);
    }
  };

  const weekDays = useMemo(() => {
    const start = startOfWeek(currentDate, { weekStartsOn: 1 });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [currentDate]);

  // Map slots by day for absolute positioning
  const slotsByDay = useMemo(() => {
    const map: Record<string, SlotWithBookings[]> = {};
    weekDays.forEach((day) => {
      map[format(day, "yyyy-MM-dd")] = [];
    });
    slots.forEach((slot) => {
      const dayKey = format(new Date(slot.start_time), "yyyy-MM-dd");
      if (map[dayKey]) map[dayKey].push(slot);
    });
    return map;
  }, [slots, weekDays]);

  // Also keep full-hour map for mobile view
  const slotsByDayAndHour = useMemo(() => {
    const map: Record<string, Record<number, SlotWithBookings[]>> = {};
    weekDays.forEach((day) => {
      const dayKey = format(day, "yyyy-MM-dd");
      map[dayKey] = {};
      FULL_HOURS.forEach((hour) => {
        map[dayKey][hour] = [];
      });
    });
    slots.forEach((slot) => {
      const slotDate = new Date(slot.start_time);
      const dayKey = format(slotDate, "yyyy-MM-dd");
      const hour = slotDate.getHours();
      if (map[dayKey] && map[dayKey][hour] !== undefined) {
        map[dayKey][hour].push(slot);
      }
    });
    return map;
  }, [slots, weekDays]);

  // Helper to compute slot position
  const getSlotPosition = (slot: SlotWithBookings) => {
    const start = new Date(slot.start_time);
    const end = new Date(slot.end_time);
    const startMinutes = (start.getHours() - GRID_START_HOUR) * 60 + start.getMinutes();
    const durationMinutes = (end.getTime() - start.getTime()) / (60 * 1000);
    return {
      top: (startMinutes / 60) * HOUR_HEIGHT,
      height: Math.max((durationMinutes / 60) * HOUR_HEIGHT - 2, 20), // -2 for gap, min 20px
    };
  };

  if (view === "day") {
    return (
      <DayView 
        slots={slots} 
        currentDate={currentDate} 
        onCellClick={onCellClick}
        onBookForPlayer={onBookForPlayer} 
        onDuplicateCyclus={onDuplicateCyclus} 
        onDeleteSlot={onDeleteSlot} 
        onEditBooking={onEditBooking} 
        onToggleMarkedFull={onToggleMarkedFull}
        onNavigatePrevious={onNavigatePrevious}
        onNavigateNext={onNavigateNext}
        showTrainerInfo={showTrainerInfo}
        onSlotClick={onSlotClick}
      />
    );
  }

  if (view === "month") {
    return <MonthView slots={slots} currentDate={currentDate} onBookForPlayer={onBookForPlayer} onDuplicateCyclus={onDuplicateCyclus} onDeleteSlot={onDeleteSlot} onEditBooking={onEditBooking} onToggleMarkedFull={onToggleMarkedFull} showTrainerInfo={showTrainerInfo} onSlotClick={onSlotClick} />;
  }

  // Mobile day view
  const mobileDayKey = format(mobileSelectedDate, "yyyy-MM-dd");
  const mobileDaySlots = slotsByDayAndHour[mobileDayKey] || {};

  return (
    <>
      {/* Mobile Day View */}
      <div className="block sm:hidden">
        <MobileDayView
          selectedDate={mobileSelectedDate}
          onDateChange={handleMobileDateChange}
          slotsByHour={mobileDaySlots}
          weekDays={weekDays}
          dateLocale={dfLocale}
          onCellClick={onCellClick}
          onBookForPlayer={onBookForPlayer}
          onDuplicateCyclus={onDuplicateCyclus}
          onDeleteSlot={onDeleteSlot}
          onEditBooking={onEditBooking}
          onToggleMarkedFull={onToggleMarkedFull}
          showTrainerInfo={showTrainerInfo}
          onSlotClick={onSlotClick}
        />
      </div>

      {/* Desktop Week View */}
      <div className="hidden sm:block overflow-x-auto">
        <div className="min-w-[800px]">
          {/* Header */}
          <div className="grid grid-cols-8 border-b">
            <div className="p-2 text-sm font-medium text-muted-foreground" />
            {weekDays.map((day) => (
              <div
                key={day.toISOString()}
                className={cn(
                  "p-2 text-center border-l",
                  isToday(day) && "bg-primary/10"
                )}
              >
                <div className="text-xs text-muted-foreground">
                  {format(day, "EEE", { locale: dfLocale })}
                </div>
                <div
                  className={cn(
                    "text-lg font-semibold",
                    isToday(day) && "text-primary"
                  )}
                >
                  {format(day, "d")}
                </div>
              </div>
            ))}
          </div>

          {/* Time Grid - Absolute positioned slots */}
          <div className="grid grid-cols-8" style={{ height: GRID_TOTAL_HEIGHT }}>
            {/* Time labels column */}
            <div className="relative">
              {FULL_HOURS.map((hour) => (
                <div
                  key={hour}
                  className="absolute right-0 pr-3 text-xs text-muted-foreground"
                  style={{ top: (hour - GRID_START_HOUR) * HOUR_HEIGHT - 6 }}
                >
                  {String(hour).padStart(2, "0")}:00
                </div>
              ))}
            </div>

            {/* Day columns */}
            {weekDays.map((day) => {
              const dayKey = format(day, "yyyy-MM-dd");
              const daySlots = slotsByDay[dayKey] || [];

              return (
                <div
                  key={dayKey}
                  className={cn(
                    "relative border-l",
                    isToday(day) && "bg-primary/5"
                  )}
                  onClick={(e) => {
                    if (onCellClick && e.target === e.currentTarget) {
                      // Calculate hour from click position
                      const rect = e.currentTarget.getBoundingClientRect();
                      const y = e.clientY - rect.top;
                      const hour = Math.floor(y / HOUR_HEIGHT) + GRID_START_HOUR;
                      if (hour >= GRID_START_HOUR && hour <= GRID_END_HOUR) {
                        const clickTime = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
                        if (!isBefore(clickTime, new Date())) {
                          onCellClick(day, hour);
                        }
                      }
                    }
                  }}
                >
                  {/* Hour grid lines */}
                  {FULL_HOURS.map((hour) => (
                    <div
                      key={hour}
                      className="absolute w-full border-b border-border/50"
                      style={{ top: (hour - GRID_START_HOUR) * HOUR_HEIGHT }}
                    />
                  ))}

                  {/* Slots */}
                  {daySlots.map((slot) => {
                    const pos = getSlotPosition(slot);
                    return (
                      <div
                        key={slot.id}
                        className="absolute left-0.5 right-0.5 z-10"
                        style={{ top: pos.top, height: pos.height }}
                      >
                        <CalendarSlotCard
                          slot={slot}
                          showTrainerInfo={showTrainerInfo}
                          onSlotClick={onSlotClick}
                          onBookForPlayer={onBookForPlayer}
                          onDuplicateCyclus={onDuplicateCyclus}
                          onDeleteSlot={onDeleteSlot}
                          onEditBooking={onEditBooking}
                          onToggleMarkedFull={onToggleMarkedFull}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Empty State */}
          {slots.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center text-muted-foreground p-8 bg-background/80 rounded-lg">
                {t("calendar.noSlotsThisWeek")}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

interface MobileDayViewProps {
  selectedDate: Date;
  onDateChange: (date: Date) => void;
  slotsByHour: Record<number, SlotWithBookings[]>;
  weekDays: Date[];
  dateLocale: typeof enUS;
  onCellClick?: (date: Date, hour: number) => void;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
  onDuplicateCyclus?: (cyclusId: string) => void;
  onDeleteSlot?: (slot: SlotWithBookings) => void;
  onEditBooking?: (bookingId: string) => void;
  onToggleMarkedFull?: (slotId: string, value: boolean, applyToCyclus?: boolean) => void;
  showTrainerInfo?: boolean;
  onSlotClick?: (slot: SlotWithBookings) => void;
}

function MobileDayView({
  selectedDate,
  onDateChange,
  slotsByHour,
  weekDays,
  dateLocale: dfLocale,
  onCellClick,
  onBookForPlayer,
  onDuplicateCyclus,
  onDeleteSlot,
  onEditBooking,
  onToggleMarkedFull,
  showTrainerInfo,
  onSlotClick,
}: MobileDayViewProps) {
  return (
    <div className="space-y-4">
      {/* Day Navigation Header */}
      <div className="flex items-center justify-between px-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDateChange(subDays(selectedDate, 1))}
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="text-center">
           <div className={cn("font-semibold text-lg", isToday(selectedDate) && "text-primary")}>
            {format(selectedDate, "EEEE", { locale: dfLocale })}
          </div>
          <div className="text-sm text-muted-foreground">
            {format(selectedDate, "d MMM yyyy", { locale: dfLocale })}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDateChange(addDays(selectedDate, 1))}
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>

      {/* Day Picker Pills */}
      <div className="flex gap-1 overflow-x-auto pb-2 px-2">
        {weekDays.map((day) => (
          <button
            key={day.toISOString()}
            onClick={() => onDateChange(day)}
            className={cn(
              "flex-shrink-0 flex flex-col items-center px-3 py-2 rounded-lg transition-colors",
              isSameDay(day, selectedDate)
                ? "bg-primary text-primary-foreground"
                : isToday(day)
                ? "bg-primary/10 text-primary"
                : "bg-muted/50 hover:bg-muted"
            )}
          >
            <span className="text-xs font-medium">{format(day, "EEE", { locale: dfLocale })}</span>
            <span className="text-lg font-bold">{format(day, "d")}</span>
          </button>
        ))}
      </div>

        {/* Time Slots List */}
        <div className="space-y-2 px-2">
          {FULL_HOURS.map((hour) => {
          const slotsAtHour = slotsByHour[hour] || [];
          const isPastHour = isBefore(
            new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), hour),
            new Date()
          );

          if (slotsAtHour.length === 0) {
            // Only show empty clickable slot if not past and has callback
            if (!isPastHour && onCellClick) {
              return (
                <div
                  key={hour}
                  className="flex items-center gap-3 p-3 border border-dashed rounded-lg cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => onCellClick(selectedDate, hour)}
                >
                  <div className="text-sm font-medium text-muted-foreground w-14">
                    {String(hour).padStart(2, "0")}:00
                  </div>
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    <Plus className="h-4 w-4 mr-1" />
                    <span className="text-sm">Add slot</span>
                  </div>
                </div>
              );
            }
            return null;
          }

          return (
            <div key={hour} className="space-y-2">
              {slotsAtHour.map((slot) => (
                <div key={slot.id} className="border rounded-lg p-1">
                  <CalendarSlotCard
                    slot={slot}
                    showTrainerInfo={showTrainerInfo}
                    onSlotClick={onSlotClick}
                    onBookForPlayer={onBookForPlayer}
                    onDuplicateCyclus={onDuplicateCyclus}
                    onDeleteSlot={onDeleteSlot}
                    onEditBooking={onEditBooking}
                    onToggleMarkedFull={onToggleMarkedFull}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface DayViewProps {
  slots: SlotWithBookings[];
  currentDate: Date;
  onCellClick?: (date: Date, hour: number) => void;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
  onDuplicateCyclus?: (cyclusId: string) => void;
  onDeleteSlot?: (slot: SlotWithBookings) => void;
  onEditBooking?: (bookingId: string) => void;
  onToggleMarkedFull?: (slotId: string, value: boolean, applyToCyclus?: boolean) => void;
  onNavigatePrevious?: () => void;
  onNavigateNext?: () => void;
  showTrainerInfo?: boolean;
  onSlotClick?: (slot: SlotWithBookings) => void;
}

function DayView({ 
  slots, 
  currentDate, 
  onCellClick,
  onBookForPlayer, 
  onDuplicateCyclus, 
  onDeleteSlot, 
  onEditBooking, 
  onToggleMarkedFull,
  onNavigatePrevious,
  onNavigateNext,
  showTrainerInfo,
  onSlotClick,
}: DayViewProps) {
  const { t, i18n } = useTranslation("trainer");
  const dfLocale = dateFnsLocales[i18n.language] || dateFnsLocales[i18n.language?.split('-')[0]] || enUS;

  // Filter slots for the current day
  const daySlots = useMemo(() => {
    const dayKey = format(currentDate, "yyyy-MM-dd");
    return slots
      .filter((slot) => format(new Date(slot.start_time), "yyyy-MM-dd") === dayKey)
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  }, [slots, currentDate]);

  // Get hours that have slots
  const hoursWithSlots = useMemo(() => {
    const hours = new Set<number>();
    daySlots.forEach((slot) => {
      hours.add(new Date(slot.start_time).getHours());
    });
    return hours;
  }, [daySlots]);

  // Get available hours for adding new slots
  const availableHours = useMemo(() => {
    const hours: number[] = [];
    const now = new Date();
    for (let h = 8; h <= 23; h++) {
      const slotTime = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), h);
      if (!hoursWithSlots.has(h) && slotTime > now) {
        hours.push(h);
      }
    }
    return hours;
  }, [currentDate, hoursWithSlots]);

  return (
    <div className="space-y-4">
      {/* Day Navigation Header */}
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          onClick={onNavigatePrevious}
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="text-center">
          <div className={cn("font-semibold text-xl", isToday(currentDate) && "text-primary")}>
            {format(currentDate, "EEEE", { locale: dfLocale })}
          </div>
          <div className="text-muted-foreground">
            {format(currentDate, "d MMMM yyyy", { locale: dfLocale })}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onNavigateNext}
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>

      {/* Slots List */}
      {daySlots.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg font-medium mb-2">{t("calendar.noSlotsToday", "No slots scheduled for today")}</p>
          {onCellClick && availableHours.length > 0 && (
            <Button
              variant="outline"
              onClick={() => onCellClick(currentDate, availableHours[0])}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t("calendar.addFirstSlot", "Add your first slot")}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {daySlots.map((slot) => (
            <DayViewSlotCard
              key={slot.id}
              slot={slot}
              onBookForPlayer={onBookForPlayer}
              onDuplicateCyclus={onDuplicateCyclus}
              onDeleteSlot={onDeleteSlot}
              onEditBooking={onEditBooking}
              onToggleMarkedFull={onToggleMarkedFull}
            />
          ))}
        </div>
      )}

      {/* Add Slot Buttons for Available Hours */}
      {onCellClick && daySlots.length > 0 && availableHours.length > 0 && (
        <div className="pt-4 border-t">
          <p className="text-sm text-muted-foreground mb-3">{t("calendar.addSlotAtTime", "Add slot at:")}</p>
          <div className="flex flex-wrap gap-2">
            {availableHours.slice(0, 8).map((hour) => (
              <Button
                key={hour}
                variant="outline"
                size="sm"
                onClick={() => onCellClick(currentDate, hour)}
                className="gap-1"
              >
                <Plus className="h-3 w-3" />
                {String(hour).padStart(2, "0")}:00
              </Button>
            ))}
            {availableHours.length > 8 && (
              <span className="text-sm text-muted-foreground self-center">
                +{availableHours.length - 8} more
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface MonthViewProps {
  slots: SlotWithBookings[];
  currentDate: Date;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
  onDuplicateCyclus?: (cyclusId: string) => void;
  onDeleteSlot?: (slot: SlotWithBookings) => void;
  onEditBooking?: (bookingId: string) => void;
  onToggleMarkedFull?: (slotId: string, value: boolean, applyToCyclus?: boolean) => void;
  showTrainerInfo?: boolean;
  onSlotClick?: (slot: SlotWithBookings) => void;
}

function MonthView({ slots, currentDate, onBookForPlayer, onDuplicateCyclus, onDeleteSlot, onEditBooking, onToggleMarkedFull, showTrainerInfo, onSlotClick }: MonthViewProps) {
  const { t, i18n } = useTranslation("trainer");
  const dfLocale = dateFnsLocales[i18n.language] || dateFnsLocales[i18n.language?.split('-')[0]] || enUS;

  const monthDays = useMemo(() => {
    const start = startOfWeek(new Date(currentDate.getFullYear(), currentDate.getMonth(), 1), { weekStartsOn: 1 });
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) {
      days.push(addDays(start, i));
    }
    return days;
  }, [currentDate]);

  const slotsByDay = useMemo(() => {
    const map: Record<string, SlotWithBookings[]> = {};
    slots.forEach((slot) => {
      const dayKey = format(new Date(slot.start_time), "yyyy-MM-dd");
      if (!map[dayKey]) map[dayKey] = [];
      map[dayKey].push(slot);
    });
    return map;
  }, [slots]);

  const weekDayLabels = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(startOfWeek(new Date(), { weekStartsOn: 1 }), i);
    return format(day, "EEE", { locale: dfLocale });
  });

  return (
    <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
      {/* Header */}
      {weekDayLabels.map((day) => (
        <div
          key={day}
          className="bg-muted p-2 text-center text-sm font-medium text-muted-foreground"
        >
          {day}
        </div>
      ))}

      {/* Days */}
      {monthDays.map((day) => {
        const dayKey = format(day, "yyyy-MM-dd");
        const daySlots = slotsByDay[dayKey] || [];
        const isCurrentMonth = day.getMonth() === currentDate.getMonth();

        return (
          <div
            key={dayKey}
            className={cn(
              "bg-background min-h-[100px] p-1",
              !isCurrentMonth && "opacity-40",
              isToday(day) && "ring-2 ring-primary ring-inset"
            )}
          >
            <div
              className={cn(
                "text-sm font-medium mb-1 text-center",
                isToday(day) && "text-primary"
              )}
            >
              {format(day, "d")}
            </div>
            <div className="space-y-0.5 max-h-[80px] overflow-y-auto">
              {daySlots.slice(0, 3).map((slot) => (
                <CalendarSlotCard 
                  key={slot.id} 
                  slot={slot} 
                  compact 
                  showTrainerInfo={showTrainerInfo}
                  onSlotClick={onSlotClick}
                  onBookForPlayer={onBookForPlayer}
                  onDuplicateCyclus={onDuplicateCyclus}
                  onDeleteSlot={onDeleteSlot}
                  onEditBooking={onEditBooking}
                  onToggleMarkedFull={onToggleMarkedFull}
                />
              ))}
              {daySlots.length > 3 && (
                <div className="text-xs text-muted-foreground text-center">
                  +{daySlots.length - 3} more
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
