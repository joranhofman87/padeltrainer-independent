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
import { ChevronLeft, ChevronRight, Calendar, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { getUserClubProfiles, getClubTrainerSlots } from "@/lib/club";
import { ClubNavigation } from "@/components/club/ClubNavigation";
import { ClubSlotDetailSheet } from "@/components/club/ClubSlotDetailSheet";

interface ClubSlot {
  id: string;
  trainer_id: string;
  start_time: string;
  end_time: string;
  lesson_id: string | null;
  is_marked_full: boolean;
  lessons: { title: string; max_participants: number } | null;
  trainer_name: string;
  trainer_avatar: string | null;
  active_bookings: number;
  pending_bookings: number;
}

const HOURS = Array.from({ length: 14 }, (_, i) => i + 8); // 08:00 to 21:00

export default function ClubCalendar() {
  const { t } = useTranslation("club");
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  
  const [currentDate, setCurrentDate] = useState(new Date());
  const [slots, setSlots] = useState<ClubSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [clubProfileId, setClubProfileId] = useState<string | null>(null);
  const [clubName, setClubName] = useState<string>("");
  const [selectedSlot, setSelectedSlot] = useState<ClubSlot | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    async function loadClub() {
      if (!user) return;
      const clubs = await getUserClubProfiles(user.id);
      if (clubs.length > 0) {
        setClubProfileId(clubs[0].id);
        setClubName(clubs[0].location?.name || "Club");
      }
    }
    loadClub();
  }, [user]);

  useEffect(() => {
    if (clubProfileId) {
      fetchSlots();
    }
  }, [clubProfileId, currentDate]);

  const fetchSlots = async () => {
    if (!clubProfileId) return;
    
    setLoading(true);
    try {
      const rangeStart = startOfWeek(currentDate, { weekStartsOn: 1 });
      const rangeEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
      
      const slotsData = await getClubTrainerSlots(clubProfileId, rangeStart, rangeEnd);
      setSlots(slotsData as ClubSlot[]);
    } catch (error) {
      console.error("Error fetching club slots:", error);
    } finally {
      setLoading(false);
    }
  };

  const weekDays = useMemo(() => {
    const start = startOfWeek(currentDate, { weekStartsOn: 1 });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [currentDate]);

  const slotsByDayAndHour = useMemo(() => {
    const map: Record<string, Record<number, ClubSlot[]>> = {};

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

  // Mobile selected day
  const [mobileSelectedDay, setMobileSelectedDay] = useState<Date>(new Date());
  
  const mobileDaySlots = useMemo(() => {
    return slots
      .filter((slot) => {
        const slotDate = new Date(slot.start_time);
        return (
          slotDate.getDate() === mobileSelectedDay.getDate() &&
          slotDate.getMonth() === mobileSelectedDay.getMonth() &&
          slotDate.getFullYear() === mobileSelectedDay.getFullYear()
        );
      })
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  }, [slots, mobileSelectedDay]);

  useEffect(() => {
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
    if (mobileSelectedDay < weekStart || mobileSelectedDay > weekEnd) {
      setMobileSelectedDay(weekStart);
    }
  }, [currentDate]);

  const navigatePrevious = () => setCurrentDate(subWeeks(currentDate, 1));
  const navigateNext = () => setCurrentDate(addWeeks(currentDate, 1));
  const goToToday = () => {
    setCurrentDate(new Date());
    setMobileSelectedDay(new Date());
  };

  const navigatePreviousDay = () => {
    const prevDay = addDays(mobileSelectedDay, -1);
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
    if (prevDay >= weekStart) {
      setMobileSelectedDay(prevDay);
    } else {
      setCurrentDate(subWeeks(currentDate, 1));
      setMobileSelectedDay(prevDay);
    }
  };

  const navigateNextDay = () => {
    const nextDay = addDays(mobileSelectedDay, 1);
    const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
    if (nextDay <= weekEnd) {
      setMobileSelectedDay(nextDay);
    } else {
      setCurrentDate(addWeeks(currentDate, 1));
      setMobileSelectedDay(nextDay);
    }
  };

  const getDateRangeLabel = () => {
    const start = startOfWeek(currentDate, { weekStartsOn: 1 });
    const end = endOfWeek(currentDate, { weekStartsOn: 1 });
    return `${format(start, "MMM d")} - ${format(end, "MMM d, yyyy")}`;
  };

  const getSlotColor = (slot: ClubSlot) => {
    const now = new Date();
    const isPast = new Date(slot.start_time) < now;
    const maxParticipants = slot.lessons?.max_participants || 4;

    if (isPast) return "bg-muted text-muted-foreground";
    if (slot.is_marked_full) return "bg-purple-100 dark:bg-purple-900/50 border-purple-300";
    if (slot.active_bookings >= maxParticipants)
      return "bg-blue-100 dark:bg-blue-900/50 border-blue-300";
    if (slot.active_bookings > 0)
      return "bg-orange-100 dark:bg-orange-900/50 border-orange-300";
    return "bg-green-100 dark:bg-green-900/30 border-green-300";
  };

  const getInitials = (name: string) => {
    return name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
  };

  const handleSlotClick = (slot: ClubSlot) => {
    setSelectedSlot(slot);
    setSheetOpen(true);
  };

  if (authLoading || (loading && slots.length === 0)) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8">
          <Skeleton className="h-8 w-48 mb-4" />
          <Skeleton className="h-[500px] w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-semibold">{clubName} - {t("dashboard.calendar")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("calendar.description", "View all trainer schedules")}
          </p>
        </div>
        <ClubNavigation />
      </div>

      <div className="container mx-auto px-4 py-8">
        <Card className="overflow-hidden">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              {/* Mobile: Day navigation */}
              <div className="flex items-center gap-1 sm:hidden">
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={navigatePreviousDay}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" className="text-xs px-2" onClick={goToToday}>
                  {t("calendar.today", "Today")}
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={navigateNextDay}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              {/* Desktop: Week navigation */}
              <div className="hidden sm:flex items-center gap-2">
                <Button variant="outline" size="icon" className="h-8 w-8" onClick={navigatePrevious}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={goToToday}>
                  {t("calendar.today", "Today")}
                </Button>
                <Button variant="outline" size="icon" className="h-8 w-8" onClick={navigateNext}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              <div className="text-sm font-medium hidden sm:block">{getDateRangeLabel()}</div>
            </div>
            <p className="text-xs text-muted-foreground sm:hidden">{format(mobileSelectedDay, "EEEE, MMMM d")}</p>
          </CardHeader>
          <CardContent className="p-0">
            {/* Mobile View */}
            <div className="block sm:hidden p-3 space-y-3">
              {mobileDaySlots.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Calendar className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  <p>{t("calendar.noSlots", "No slots scheduled")}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {mobileDaySlots.map((slot) => (
                    <div
                      key={slot.id}
                      onClick={() => handleSlotClick(slot)}
                      className={cn(
                        "p-3 rounded-lg border cursor-pointer hover:opacity-80 transition-opacity",
                        getSlotColor(slot)
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={slot.trainer_avatar || undefined} />
                          <AvatarFallback className="text-xs">
                            {getInitials(slot.trainer_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="font-medium">
                              {format(new Date(slot.start_time), "HH:mm")} - {format(new Date(slot.end_time), "HH:mm")}
                            </span>
                            <Badge variant="outline" className="text-xs">
                              {slot.active_bookings}/{slot.lessons?.max_participants || 4}
                            </Badge>
                          </div>
                          <div className="text-sm truncate">{slot.trainer_name}</div>
                          {slot.lessons?.title && (
                            <div className="text-xs text-muted-foreground truncate">
                              {slot.lessons.title}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Desktop View */}
            <div className="hidden sm:block overflow-x-auto">
              <div className="min-w-[800px]">
                {/* Header */}
                <div className="grid grid-cols-8 border-b border-t bg-muted/30">
                  <div className="p-2 text-xs font-medium text-muted-foreground" />
                  {weekDays.map((day) => (
                    <div
                      key={day.toISOString()}
                      className={cn(
                        "p-2 text-center border-l",
                        isToday(day) && "bg-primary/10"
                      )}
                    >
                      <div className="text-xs text-muted-foreground uppercase">
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
                    <div key={hour} className="grid grid-cols-8 border-b min-h-[48px]">
                      <div className="p-1 text-xs text-muted-foreground text-right pr-2 pt-1">
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
                              "border-l p-1 min-h-[48px]",
                              isToday(day) && "bg-primary/5",
                              isPast && "bg-muted/20"
                            )}
                          >
                            {slotsInCell.map((slot) => (
                              <div
                                key={slot.id}
                                onClick={() => handleSlotClick(slot)}
                                className={cn(
                                  "text-xs p-1.5 rounded border mb-1 cursor-pointer hover:opacity-80 transition-opacity",
                                  getSlotColor(slot)
                                )}
                                title={`${slot.trainer_name} - ${slot.lessons?.title || "Open Slot"}`}
                              >
                                <div className="flex items-center gap-1 mb-0.5">
                                  <span className="font-medium">
                                    {format(new Date(slot.start_time), "HH:mm")}
                                  </span>
                                  <span className="opacity-70">
                                    {slot.active_bookings}/{slot.lessons?.max_participants || 4}
                                  </span>
                                </div>
                                <div className="truncate text-[10px] opacity-80">
                                  {slot.trainer_name}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>

                {/* Legend */}
                <div className="flex items-center gap-4 p-3 border-t bg-muted/20 text-xs">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded bg-green-200 border border-green-300" />
                    <span>{t("calendar.open", "Open")}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded bg-orange-200 border border-orange-300" />
                    <span>{t("calendar.partial", "Partial")}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded bg-blue-200 border border-blue-300" />
                    <span>{t("calendar.full", "Full")}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded bg-purple-200 border border-purple-300" />
                    <span>{t("calendar.private", "Private")}</span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Slot Detail Sheet */}
      <ClubSlotDetailSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        slot={selectedSlot}
      />
    </div>
  );
}
