import { useMemo } from "react";
import { format, startOfWeek, addDays, isToday, isBefore, startOfDay } from "date-fns";
import { cn } from "@/lib/utils";
import { CalendarSlotCard, SlotWithBookings } from "./CalendarSlotCard";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

interface TrainerCalendarGridProps {
  slots: SlotWithBookings[];
  currentDate: Date;
  view: "week" | "month";
  onCellClick?: (date: Date, hour: number) => void;
}

const HOURS = Array.from({ length: 14 }, (_, i) => i + 7); // 07:00 to 20:00

export function TrainerCalendarGrid({
  slots,
  currentDate,
  view,
  onCellClick,
}: TrainerCalendarGridProps) {
  const { t } = useTranslation("trainer");

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
    return <MonthView slots={slots} currentDate={currentDate} />;
  }

  return (
    <div className="overflow-x-auto">
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
                        <CalendarSlotCard key={slot.id} slot={slot} />
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
  );
}

interface MonthViewProps {
  slots: SlotWithBookings[];
  currentDate: Date;
}

function MonthView({ slots, currentDate }: MonthViewProps) {
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
                <CalendarSlotCard key={slot.id} slot={slot} compact />
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
