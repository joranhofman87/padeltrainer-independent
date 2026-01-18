import { useMemo, useState } from "react";
import { format, startOfWeek, addDays, subDays, isToday, isBefore, isSameDay } from "date-fns";
import { cn } from "@/lib/utils";
import { CalendarSlotCard, SlotWithBookings } from "./CalendarSlotCard";
import { useTranslation } from "react-i18next";
import { Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TrainerCalendarGridProps {
  slots: SlotWithBookings[];
  currentDate: Date;
  view: "week" | "month";
  onCellClick?: (date: Date, hour: number) => void;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
  onDuplicateCyclus?: (cyclusId: string) => void;
  onDeleteSlot?: (slot: SlotWithBookings) => void;
  onEditBooking?: (bookingId: string) => void;
  onToggleMarkedFull?: (slotId: string, value: boolean, applyToCyclus?: boolean) => void;
}

const HOURS = Array.from({ length: 16 }, (_, i) => i + 8); // 08:00 to 23:00

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
}: TrainerCalendarGridProps) {
  const { t } = useTranslation("trainer");
  const [mobileSelectedDate, setMobileSelectedDate] = useState(currentDate);

  // Sync mobile selected date when currentDate changes
  useMemo(() => {
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
    const weekEnd = addDays(weekStart, 6);
    if (mobileSelectedDate < weekStart || mobileSelectedDate > weekEnd) {
      setMobileSelectedDate(currentDate);
    }
  }, [currentDate]);

  const weekDays = useMemo(() => {
    const start = startOfWeek(currentDate, { weekStartsOn: 1 });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [currentDate]);

  const slotsByDayAndHour = useMemo(() => {
    const map: Record<string, Record<number, SlotWithBookings[]>> = {};
    
    weekDays.forEach((day) => {
      const dayKey = format(day, "yyyy-MM-dd");
      map[dayKey] = {};
      HOURS.forEach((hour) => {
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

  if (view === "month") {
    return <MonthView slots={slots} currentDate={currentDate} onBookForPlayer={onBookForPlayer} onDuplicateCyclus={onDuplicateCyclus} onDeleteSlot={onDeleteSlot} onEditBooking={onEditBooking} onToggleMarkedFull={onToggleMarkedFull} />;
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
          onDateChange={setMobileSelectedDate}
          slotsByHour={mobileDaySlots}
          weekDays={weekDays}
          onCellClick={onCellClick}
          onBookForPlayer={onBookForPlayer}
          onDuplicateCyclus={onDuplicateCyclus}
          onDeleteSlot={onDeleteSlot}
          onEditBooking={onEditBooking}
          onToggleMarkedFull={onToggleMarkedFull}
          noSlotsLabel={t("calendar.noSlotsThisWeek")}
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
                  {format(day, "EEE")}
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

          {/* Time Grid */}
          <div className="relative">
            {HOURS.map((hour) => (
              <div key={hour} className="grid grid-cols-8 border-b min-h-[80px]">
                <div className="p-2 text-xs text-muted-foreground text-right pr-3 pt-1">
                  {String(hour).padStart(2, "0")}:00
                </div>
                {weekDays.map((day) => {
                  const dayKey = format(day, "yyyy-MM-dd");
                  const slotsInCell = slotsByDayAndHour[dayKey]?.[hour] || [];

                    const isPastCell = isBefore(
                      new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour),
                      new Date()
                    );

                    return (
                      <div
                        key={`${dayKey}-${hour}`}
                        className={cn(
                          "border-l p-1 space-y-1 min-h-[80px] group relative",
                          isToday(day) && "bg-primary/5",
                          !isPastCell && slotsInCell.length === 0 && onCellClick && "cursor-pointer hover:bg-muted/50"
                        )}
                        onClick={() => {
                          if (!isPastCell && slotsInCell.length === 0 && onCellClick) {
                            onCellClick(day, hour);
                          }
                        }}
                      >
                        {slotsInCell.map((slot) => (
                          <CalendarSlotCard 
                            key={slot.id} 
                            slot={slot} 
                            onBookForPlayer={onBookForPlayer}
                            onDuplicateCyclus={onDuplicateCyclus}
                            onDeleteSlot={onDeleteSlot}
                            onEditBooking={onEditBooking}
                            onToggleMarkedFull={onToggleMarkedFull}
                          />
                        ))}
                        {!isPastCell && slotsInCell.length === 0 && onCellClick && (
                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <div className="bg-primary/10 rounded-md p-2">
                              <Plus className="h-4 w-4 text-primary" />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                })}
              </div>
            ))}
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
  onCellClick?: (date: Date, hour: number) => void;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
  onDuplicateCyclus?: (cyclusId: string) => void;
  onDeleteSlot?: (slot: SlotWithBookings) => void;
  onEditBooking?: (bookingId: string) => void;
  onToggleMarkedFull?: (slotId: string, value: boolean, applyToCyclus?: boolean) => void;
  noSlotsLabel: string;
}

function MobileDayView({
  selectedDate,
  onDateChange,
  slotsByHour,
  weekDays,
  onCellClick,
  onBookForPlayer,
  onDuplicateCyclus,
  onDeleteSlot,
  onEditBooking,
  onToggleMarkedFull,
  noSlotsLabel,
}: MobileDayViewProps) {
  const hasSlotsToday = HOURS.some((hour) => (slotsByHour[hour] || []).length > 0);

  return (
    <div className="space-y-4">
      {/* Day Navigation Header */}
      <div className="flex items-center justify-between px-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDateChange(subDays(selectedDate, 1))}
          disabled={isBefore(subDays(selectedDate, 1), subDays(weekDays[0], 1))}
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="text-center">
          <div className={cn("font-semibold text-lg", isToday(selectedDate) && "text-primary")}>
            {format(selectedDate, "EEEE")}
          </div>
          <div className="text-sm text-muted-foreground">
            {format(selectedDate, "MMM d, yyyy")}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDateChange(addDays(selectedDate, 1))}
          disabled={isBefore(weekDays[6], selectedDate)}
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
            <span className="text-xs font-medium">{format(day, "EEE")}</span>
            <span className="text-lg font-bold">{format(day, "d")}</span>
          </button>
        ))}
      </div>

      {/* Time Slots List */}
      <div className="space-y-2 px-2">
        {!hasSlotsToday && (
          <div className="text-center py-8 text-muted-foreground bg-muted/30 rounded-lg">
            <Plus className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{noSlotsLabel}</p>
          </div>
        )}
        {HOURS.map((hour) => {
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

interface MonthViewProps {
  slots: SlotWithBookings[];
  currentDate: Date;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
  onDuplicateCyclus?: (cyclusId: string) => void;
  onDeleteSlot?: (slot: SlotWithBookings) => void;
  onEditBooking?: (bookingId: string) => void;
  onToggleMarkedFull?: (slotId: string, value: boolean, applyToCyclus?: boolean) => void;
}

function MonthView({ slots, currentDate, onBookForPlayer, onDuplicateCyclus, onDeleteSlot, onEditBooking, onToggleMarkedFull }: MonthViewProps) {
  const { t } = useTranslation("trainer");

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

  const weekDayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
