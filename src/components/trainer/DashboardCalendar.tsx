import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  format,
  startOfWeek,
  endOfWeek,
  addWeeks,
  subWeeks,
  addDays,
  isToday,
  isBefore,
} from "date-fns";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

interface SlotSummary {
  id: string;
  start_time: string;
  end_time: string;
  lesson_title: string | null;
  active_bookings: number;
  pending_bookings: number;
  max_participants: number;
  is_marked_full: boolean;
}

interface DashboardCalendarProps {
  trainerId: string | null;
}

const HOURS = Array.from({ length: 16 }, (_, i) => i + 8); // 08:00 to 23:00

export function DashboardCalendar({ trainerId }: DashboardCalendarProps) {
  const { t } = useTranslation("trainer");
  const navigate = useNavigate();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [slots, setSlots] = useState<SlotSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (trainerId) {
      fetchSlots();
    }
  }, [trainerId, currentDate]);

  const fetchSlots = async () => {
    if (!trainerId) return;
    
    setLoading(true);
    try {
      const rangeStart = startOfWeek(currentDate, { weekStartsOn: 1 });
      const rangeEnd = endOfWeek(currentDate, { weekStartsOn: 1 });

      // Fetch availability slots with lessons and booking counts
      const { data: availabilitySlots, error: slotsError } = await supabase
        .from("availability_slots")
        .select(`
          id,
          start_time,
          end_time,
          lesson_id,
          is_marked_full,
          lessons:lesson_id (
            title,
            max_participants
          )
        `)
        .eq("trainer_id", trainerId)
        .gte("start_time", rangeStart.toISOString())
        .lte("start_time", rangeEnd.toISOString())
        .order("start_time");

      if (slotsError) throw slotsError;

      // Fetch bookings for these slots
      const slotIds = availabilitySlots?.map((s) => s.id) || [];
      const { data: bookings, error: bookingsError } = await supabase
        .from("bookings")
        .select("slot_id, status")
        .in("slot_id", slotIds.length > 0 ? slotIds : ["none"]);

      if (bookingsError) throw bookingsError;

      // Aggregate booking counts
      const bookingCounts: Record<string, { confirmed: number; pending: number }> = {};
      bookings?.forEach((b) => {
        if (!bookingCounts[b.slot_id]) {
          bookingCounts[b.slot_id] = { confirmed: 0, pending: 0 };
        }
        if (b.status === "confirmed") {
          bookingCounts[b.slot_id].confirmed++;
        } else if (b.status === "pending") {
          bookingCounts[b.slot_id].pending++;
        }
      });

      // Transform to SlotSummary
      const transformedSlots: SlotSummary[] = (availabilitySlots || []).map((slot) => {
        const lesson = slot.lessons as { title: string; max_participants: number } | null;
        const counts = bookingCounts[slot.id] || { confirmed: 0, pending: 0 };

        return {
          id: slot.id,
          start_time: slot.start_time,
          end_time: slot.end_time,
          lesson_title: lesson?.title || null,
          max_participants: lesson?.max_participants || 4,
          active_bookings: counts.confirmed,
          pending_bookings: counts.pending,
          is_marked_full: slot.is_marked_full || false,
        };
      });

      setSlots(transformedSlots);
    } catch (error) {
      console.error("Error fetching calendar slots:", error);
    } finally {
      setLoading(false);
    }
  };

  const weekDays = useMemo(() => {
    const start = startOfWeek(currentDate, { weekStartsOn: 1 });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [currentDate]);

  const slotsByDayAndHour = useMemo(() => {
    const map: Record<string, Record<number, SlotSummary[]>> = {};

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

  const navigatePrevious = () => setCurrentDate(subWeeks(currentDate, 1));
  const navigateNext = () => setCurrentDate(addWeeks(currentDate, 1));
  const goToToday = () => setCurrentDate(new Date());

  const getDateRangeLabel = () => {
    const start = startOfWeek(currentDate, { weekStartsOn: 1 });
    const end = endOfWeek(currentDate, { weekStartsOn: 1 });
    return `${format(start, "MMM d")} - ${format(end, "MMM d")}`;
  };

  const getSlotColor = (slot: SlotSummary) => {
    const now = new Date();
    const isPast = new Date(slot.start_time) < now;

    if (isPast) return "bg-muted text-muted-foreground";
    if (slot.is_marked_full) return "bg-purple-100 dark:bg-purple-900/50 border-purple-300";
    if (slot.active_bookings >= slot.max_participants)
      return "bg-blue-100 dark:bg-blue-900/50 border-blue-300";
    if (slot.active_bookings > 0)
      return "bg-orange-100 dark:bg-orange-900/50 border-orange-300";
    return "bg-green-100 dark:bg-green-900/30 border-green-300";
  };

  if (loading && slots.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[300px] w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            {t("calendar.title")}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={navigatePrevious}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" className="text-xs px-2" onClick={goToToday}>
              {t("calendar.today")}
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={navigateNext}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-2 gap-1 text-xs"
              onClick={() => navigate("/trainer/calendar")}
            >
              <ExternalLink className="h-3 w-3" />
              <span className="hidden sm:inline">{t("calendar.weekView")}</span>
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{getDateRangeLabel()}</p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <div className="min-w-[600px]">
            {/* Header */}
            <div className="grid grid-cols-8 border-b border-t bg-muted/30">
              <div className="p-1.5 text-xs font-medium text-muted-foreground" />
              {weekDays.map((day) => (
                <div
                  key={day.toISOString()}
                  className={cn(
                    "p-1.5 text-center border-l",
                    isToday(day) && "bg-primary/10"
                  )}
                >
                  <div className="text-[10px] text-muted-foreground uppercase">
                    {format(day, "EEE")}
                  </div>
                  <div
                    className={cn(
                      "text-sm font-semibold",
                      isToday(day) && "text-primary"
                    )}
                  >
                    {format(day, "d")}
                  </div>
                </div>
              ))}
            </div>

            {/* Time Grid - Compact */}
            <div className="relative">
              {HOURS.map((hour) => (
                <div key={hour} className="grid grid-cols-8 border-b min-h-[28px]">
                  <div className="p-1 text-[10px] text-muted-foreground text-right pr-2 pt-0.5">
                    {String(hour).padStart(2, "0")}:00
                  </div>
                  {weekDays.map((day) => {
                    const dayKey = format(day, "yyyy-MM-dd");
                    const slotsInCell = slotsByDayAndHour[dayKey]?.[hour] || [];
                    const isPast = isBefore(
                      new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour),
                      new Date()
                    );

                    return (
                      <div
                        key={`${dayKey}-${hour}`}
                        className={cn(
                          "border-l p-0.5 min-h-[28px]",
                          isToday(day) && "bg-primary/5",
                          isPast && "bg-muted/20"
                        )}
                      >
                        {slotsInCell.map((slot) => (
                          <div
                            key={slot.id}
                            className={cn(
                              "text-[9px] px-1 py-0.5 rounded border truncate cursor-pointer hover:opacity-80",
                              getSlotColor(slot)
                            )}
                            onClick={() => navigate("/trainer/calendar")}
                            title={`${slot.lesson_title || "Slot"} - ${slot.active_bookings}/${slot.max_participants}`}
                          >
                            <span className="font-medium">
                              {format(new Date(slot.start_time), "HH:mm")}
                            </span>
                            <span className="ml-1 opacity-70">
                              {slot.active_bookings}/{slot.max_participants}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Legend */}
            <div className="flex items-center gap-3 p-2 border-t bg-muted/20 text-[10px]">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded bg-green-200 border border-green-300" />
                <span>{t("calendar.fullyOpen")}</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded bg-orange-200 border border-orange-300" />
                <span>{t("calendar.spotsLeft", { count: 0 }).replace("0 ", "")}</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded bg-blue-200 border border-blue-300" />
                <span>{t("calendar.fullyBooked")}</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded bg-purple-200 border border-purple-300" />
                <span>{t("calendar.privateBadge")}</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
