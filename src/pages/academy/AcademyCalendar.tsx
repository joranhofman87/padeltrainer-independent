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
  subDays,
  addMonths,
  subMonths,
  startOfMonth,
  endOfMonth,
  isToday,
  isBefore,
} from "date-fns";
import { ChevronLeft, ChevronRight, Calendar, CalendarDays, LayoutGrid, ArrowLeft, Plus, MapPin, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAcademyContext } from "@/components/academy/AcademyLayout";
import { getAcademyTrainersWithProfiles, getAcademyLocations } from "@/lib/academy";
import { supabase } from "@/lib/supabaseClient";

import { logger } from "@/lib/logger";
import { SlotTypeChoiceDialog } from "@/components/trainer/SlotTypeChoiceDialog";
import { AddSlotDialog, BulkCreateSheet } from "@/components/trainer/AddSlotDialog";
import { DuplicateCyclusDialog } from "@/components/trainer/DuplicateCyclusDialog";
import CycleForm from "@/components/cycles/CycleForm";

interface AcademySlot {
  id: string;
  trainer_id: string;
  start_time: string;
  end_time: string;
  lesson_id: string | null;
  is_marked_full: boolean;
  location_id: string | null;
  lessons: { title: string; max_participants: number } | null;
  trainer_name: string;
  trainer_avatar: string | null;
  location_name: string | null;
  active_bookings: number;
  pending_bookings: number;
}

interface Trainer {
  id: string;
  name: string;
  avatar: string | null;
  user_id: string;
  hourly_rate?: number;
}

interface Location {
  id: string;
  name: string;
  city: string;
}

interface Lesson {
  id: string;
  title: string;
  trainer_id: string;
}

const HOURS = Array.from({ length: 14 }, (_, i) => i + 8); // 08:00 to 21:00

export default function AcademyCalendar() {
  const { t } = useTranslation("academy");
  const navigate = useNavigate();
  const { activeAcademy } = useAcademyContext();
  
  const [view, setView] = useState<"day" | "week" | "month">("week");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [slots, setSlots] = useState<AcademySlot[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Filter state
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>("all");
  const [selectedLocationId, setSelectedLocationId] = useState<string>("all");
  
  // Cycle dialog state
  const [showCreateCycleDialog, setShowCreateCycleDialog] = useState(false);

  // Slot creation dialog state
  const [slotTypeChoiceOpen, setSlotTypeChoiceOpen] = useState(false);
  const [addSlotOpen, setAddSlotOpen] = useState(false);
  const [bulkCreateOpen, setBulkCreateOpen] = useState(false);
  const [duplicateCyclusOpen, setDuplicateCyclusOpen] = useState(false);
  const [defaultSlotDate, setDefaultSlotDate] = useState<Date>();
  const [defaultSlotTime, setDefaultSlotTime] = useState<string>();
  const [selectedSlotTrainerId, setSelectedSlotTrainerId] = useState<string | null>(null);

  const handleCellClick = (day: Date, hour: number) => {
    setDefaultSlotDate(day);
    setDefaultSlotTime(`${String(hour).padStart(2, "0")}:00`);
    const trainerToUse = selectedTrainerId !== "all" ? selectedTrainerId : null;
    setSelectedSlotTrainerId(trainerToUse);
    setSlotTypeChoiceOpen(true);
  };

  // Lessons filtered for the selected slot trainer
  const slotTrainerLessons = useMemo(() => {
    if (!selectedSlotTrainerId) return lessons;
    return lessons.filter(l => l.trainer_id === selectedSlotTrainerId);
  }, [selectedSlotTrainerId, lessons]);


  useEffect(() => {
    if (activeAcademy) {
      loadAcademyData();
    }
  }, [activeAcademy]);

  useEffect(() => {
    if (activeAcademy) {
      fetchSlots(slots.length === 0);
    }
  }, [activeAcademy, currentDate]);

  const loadAcademyData = async () => {
    if (!activeAcademy) return;

    try {
      // Load trainers using the helper that uses profiles_public view
      const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
      const trainerList: Trainer[] = academyTrainers
        .filter((t: any) => t.status === 'active' && t.trainer_profile)
        .map((t: any) => ({
          id: t.trainer_profile.id,
          name: t.profile?.full_name || "Unknown",
          avatar: t.profile?.avatar_url || null,
          user_id: t.trainer_profile.user_id,
          hourly_rate: t.trainer_profile?.hourly_rate || undefined,
        }));
      
      setTrainers(trainerList);
      
      // Load locations
      const academyLocations = await getAcademyLocations(activeAcademy.id);
      const locationList: Location[] = academyLocations.map((al: any) => ({
        id: al.location.id,
        name: al.location.name,
        city: al.location.city,
      }));
      setLocations(locationList);
      
      // Load lessons for all trainers
      if (trainerList.length > 0) {
        const trainerIds = trainerList.map(t => t.id);
        const { data: lessonsData } = await supabase
          .from("lessons")
          .select("id, title, trainer_id")
          .in("trainer_id", trainerIds)
          .eq("is_active", true);
        
        setLessons(lessonsData || []);
      }
    } catch (error) {
      logger.error("Error loading academy data", error as Error, { component: "AcademyCalendar", academyId: activeAcademy?.id });
    }
  };

  const fetchSlots = async (showFullLoader = false) => {
    if (!activeAcademy) return;
    
    if (showFullLoader) setLoading(true);
    try {
      const rangeStart = startOfWeek(currentDate, { weekStartsOn: 1 });
      const rangeEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
      
      // Get trainer IDs for this academy
      const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
      const trainerIds = academyTrainers
        .filter((at: any) => at.status === 'active' && at.trainer_profile)
        .map((at: any) => at.trainer_profile.id);
      
      if (trainerIds.length === 0) {
        setSlots([]);
        setLoading(false);
        return;
      }
      
      // Fetch slots for all academy trainers
      const { data: slotsData, error } = await supabase
        .from("availability_slots")
        .select(`
          id,
          trainer_id,
          start_time,
          end_time,
          lesson_id,
          is_marked_full,
          location_id,
          lessons(title, max_participants),
          locations(name)
        `)
        .in("trainer_id", trainerIds)
        .gte("start_time", rangeStart.toISOString())
        .lte("start_time", rangeEnd.toISOString())
        .order("start_time", { ascending: true });

      if (error) {
        logger.error("Error fetching academy slots", error as Error, { component: "AcademyCalendar", academyId: activeAcademy?.id });
        setSlots([]);
        return;
      }

      // Get trainer profiles for names
      const { data: trainerProfiles } = await supabase
        .from("trainer_profiles")
        .select("id, user_id")
        .in("id", trainerIds);

      const userIds = trainerProfiles?.map((tp) => tp.user_id) || [];
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, full_name, avatar_url")
        .in("user_id", userIds);

      const profileMap = new Map(
        (profiles || []).map((p) => [p.user_id, p])
      );
      const trainerUserMap = new Map(
        (trainerProfiles || []).map((tp) => [tp.id, tp.user_id])
      );

      // Get booking counts
      const slotIds = slotsData?.map((s) => s.id) || [];
      const { data: bookings } = await supabase
        .from("bookings")
        .select("slot_id, status")
        .in("slot_id", slotIds);

      const bookingCounts = new Map<string, { active: number; pending: number }>();
      (bookings || []).forEach((b) => {
        const current = bookingCounts.get(b.slot_id) || { active: 0, pending: 0 };
        if (b.status === "confirmed") current.active++;
        if (b.status === "pending") current.pending++;
        bookingCounts.set(b.slot_id, current);
      });

      const enrichedSlots: AcademySlot[] = (slotsData || []).map((slot: any) => {
        const userId = trainerUserMap.get(slot.trainer_id);
        const profile = userId ? profileMap.get(userId) : null;
        const counts = bookingCounts.get(slot.id) || { active: 0, pending: 0 };

        return {
          id: slot.id,
          trainer_id: slot.trainer_id,
          start_time: slot.start_time,
          end_time: slot.end_time,
          lesson_id: slot.lesson_id,
          is_marked_full: slot.is_marked_full,
          location_id: slot.location_id,
          lessons: slot.lessons,
          trainer_name: profile?.full_name || "Unknown",
          trainer_avatar: profile?.avatar_url || null,
          location_name: slot.locations?.name || null,
          active_bookings: counts.active,
          pending_bookings: counts.pending,
        };
      });

      setSlots(enrichedSlots);
    } catch (error) {
      logger.error("Error fetching academy calendar slots", error as Error, { component: "AcademyCalendar" });
    } finally {
      setLoading(false);
    }
  };

  const weekDays = useMemo(() => {
    const start = startOfWeek(currentDate, { weekStartsOn: 1 });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [currentDate]);

  // Filter slots by selected trainer and location
  const filteredSlots = useMemo(() => {
    return slots.filter(s => {
      if (selectedTrainerId !== "all" && s.trainer_id !== selectedTrainerId) return false;
      if (selectedLocationId !== "all" && s.location_id !== selectedLocationId) return false;
      return true;
    });
  }, [slots, selectedTrainerId, selectedLocationId]);

  const slotsByDayAndHour = useMemo(() => {
    const map: Record<string, Record<number, AcademySlot[]>> = {};

    weekDays.forEach((day) => {
      const dayKey = format(day, "yyyy-MM-dd");
      map[dayKey] = {};
      HOURS.forEach((hour) => {
        map[dayKey][hour] = [];
      });
    });

    filteredSlots.forEach((slot) => {
      const slotDate = new Date(slot.start_time);
      const dayKey = format(slotDate, "yyyy-MM-dd");
      const hour = slotDate.getHours();

      if (map[dayKey] && map[dayKey][hour] !== undefined) {
        map[dayKey][hour].push(slot);
      }
    });

    return map;
  }, [filteredSlots, weekDays]);

  // Mobile selected day
  const [mobileSelectedDay, setMobileSelectedDay] = useState<Date>(new Date());
  
  const mobileDaySlots = useMemo(() => {
    return filteredSlots
      .filter((slot) => {
        const slotDate = new Date(slot.start_time);
        return (
          slotDate.getDate() === mobileSelectedDay.getDate() &&
          slotDate.getMonth() === mobileSelectedDay.getMonth() &&
          slotDate.getFullYear() === mobileSelectedDay.getFullYear()
        );
      })
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  }, [filteredSlots, mobileSelectedDay]);

  useEffect(() => {
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
    if (mobileSelectedDay < weekStart || mobileSelectedDay > weekEnd) {
      setMobileSelectedDay(weekStart);
    }
  }, [currentDate]);

  const navigatePrevious = () => {
    if (view === "day") setCurrentDate(subDays(currentDate, 1));
    else if (view === "week") setCurrentDate(subWeeks(currentDate, 1));
    else setCurrentDate(subMonths(currentDate, 1));
  };
  const navigateNext = () => {
    if (view === "day") setCurrentDate(addDays(currentDate, 1));
    else if (view === "week") setCurrentDate(addWeeks(currentDate, 1));
    else setCurrentDate(addMonths(currentDate, 1));
  };
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
    if (view === "day") return format(currentDate, "EEEE, MMMM d, yyyy");
    if (view === "week") {
      const start = startOfWeek(currentDate, { weekStartsOn: 1 });
      const end = endOfWeek(currentDate, { weekStartsOn: 1 });
      return `${format(start, "MMM d")} - ${format(end, "MMM d, yyyy")}`;
    }
    return format(currentDate, "MMMM yyyy");
  };

  // Stats
  const freeSlots = slots.filter(
    (s) => !isBefore(new Date(s.start_time), new Date()) && s.active_bookings === 0 && s.pending_bookings === 0
  ).length;
  const bookedSlots = slots.filter(
    (s) => !isBefore(new Date(s.start_time), new Date()) && s.active_bookings > 0
  ).length;
  const pendingSlots = slots.filter(
    (s) => !isBefore(new Date(s.start_time), new Date()) && s.pending_bookings > 0 && s.active_bookings === 0
  ).length;

  const getSlotColor = (slot: AcademySlot) => {
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

  if (loading && slots.length === 0) {
    return (
      <div className="min-h-screen bg-background p-4">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  return (
    <>
      {/* Sub-page Header */}
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/app/academy")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-bold">{t("calendar.title", "Agenda")}</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                setDefaultSlotDate(undefined);
                setDefaultSlotTime(undefined);
                const trainerToUse = selectedTrainerId !== "all" ? selectedTrainerId : null;
                setSelectedSlotTrainerId(trainerToUse);
                setSlotTypeChoiceOpen(true);
              }}
              className="gap-2"
            >
              <Plus className="h-4 w-4" />
              {t("calendar.new", "New")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDuplicateCyclusOpen(true)}
              className="gap-2"
            >
              <Copy className="h-4 w-4" />
              <span className="hidden sm:inline">{t("calendar.duplicateCyclus", "Cyclus Dupliceren")}</span>
            </Button>
          </div>
        </div>
      </div>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Controls */}
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
              {/* Date Navigation */}
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" onClick={navigatePrevious}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <div className="min-w-[120px] sm:min-w-[200px] text-center font-medium text-sm sm:text-base">
                  {getDateRangeLabel()}
                </div>
                <Button variant="outline" size="icon" onClick={navigateNext}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button variant="outline" onClick={goToToday}>
                  {t("calendar.today", "Today")}
                </Button>
              </div>

              {/* View Toggle */}
              <div className="flex items-center gap-1">
                <Button
                  variant={view === "day" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setView("day")}
                >
                  <Calendar className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">{t("calendar.dayView", "Day")}</span>
                </Button>
                <Button
                  variant={view === "week" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setView("week")}
                >
                  <CalendarDays className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">{t("calendar.weekView", "Week")}</span>
                </Button>
                <Button
                  variant={view === "month" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setView("month")}
                >
                  <LayoutGrid className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">{t("calendar.monthView", "Month")}</span>
                </Button>
              </div>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap mt-4 pt-4 border-t">
              <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
                <SelectTrigger className="w-[160px] h-8">
                  <SelectValue placeholder={t("calendar.allLocations", "All Locations")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("calendar.allLocations", "All Locations")}</SelectItem>
                  {locations.map(loc => (
                    <SelectItem key={loc.id} value={loc.id}>
                      {loc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <Select value={selectedTrainerId} onValueChange={setSelectedTrainerId}>
                <SelectTrigger className="w-[160px] h-8">
                  <SelectValue placeholder={t("calendar.allTrainers", "All Trainers")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("calendar.allTrainers", "All Trainers")}</SelectItem>
                  {trainers.map(trainer => (
                    <SelectItem key={trainer.id} value={trainer.id}>
                      {trainer.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Quick Stats */}
            <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded bg-muted border border-border" />
                <span className="text-sm">
                  {t("calendar.available", "Available")}: {freeSlots}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded bg-orange-100 dark:bg-orange-900/30 border border-orange-300 dark:border-orange-700" />
                <span className="text-sm">
                  {t("calendar.pending", "Pending")}: {pendingSlots}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-700" />
                <span className="text-sm">
                  {t("calendar.booked", "Booked")}: {bookedSlots}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Calendar Grid */}
        <Card>
          <CardContent className="p-0 sm:p-4">
            {/* Mobile View */}
            <div className="block sm:hidden p-3 space-y-3">
              <div className="flex items-center justify-between mb-2">
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={navigatePreviousDay}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm font-medium">{format(mobileSelectedDay, "EEEE, MMMM d")}</span>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={navigateNextDay}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
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
                      className={cn(
                        "p-3 rounded-lg border",
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
                          {slot.location_name && (
                            <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {slot.location_name}
                            </div>
                          )}
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
                              "border-l p-1 min-h-[48px] group relative",
                              isToday(day) && "bg-primary/5",
                              isPast && "bg-muted/20",
                              !isPast && slotsInCell.length === 0 && "cursor-pointer hover:bg-muted/50"
                            )}
                            onClick={() => {
                              if (!isPast && slotsInCell.length === 0) handleCellClick(day, hour);
                            }}
                          >
                            {!isPast && slotsInCell.length === 0 && (
                              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                <div className="bg-primary/10 rounded-md p-2">
                                  <Plus className="h-4 w-4 text-primary" />
                                </div>
                              </div>
                            )}
                            {slotsInCell.map((slot) => (
                              <div
                                key={slot.id}
                                className={cn(
                                  "text-xs p-1.5 rounded border mb-1",
                                  getSlotColor(slot)
                                )}
                                title={`${slot.trainer_name} - ${slot.lessons?.title || "Open Slot"}${slot.location_name ? ` @ ${slot.location_name}` : ""}`}
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
                                {slot.location_name && (
                                  <div className="truncate text-[10px] opacity-60 flex items-center gap-0.5">
                                    <MapPin className="h-2.5 w-2.5" />
                                    {slot.location_name}
                                  </div>
                                )}
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
                    <div className="w-3 h-3 rounded bg-green-200 dark:bg-green-900/30 border border-green-300 dark:border-green-700" />
                    <span>{t("calendar.open", "Open")}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded bg-orange-200 dark:bg-orange-900/30 border border-orange-300 dark:border-orange-700" />
                    <span>{t("calendar.partial", "Partial")}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded bg-blue-200 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700" />
                    <span>{t("calendar.full", "Full")}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded bg-purple-200 dark:bg-purple-900/30 border border-purple-300 dark:border-purple-700" />
                    <span>{t("calendar.private", "Private")}</span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
      
      {/* Slot Creation Dialogs */}
      {activeAcademy && (
        <>
          <SlotTypeChoiceDialog
            open={slotTypeChoiceOpen}
            onOpenChange={setSlotTypeChoiceOpen}
            onChooseSingleSlot={() => setAddSlotOpen(true)}
            onChooseCyclus={() => setShowCreateCycleDialog(true)}
          />

          <AddSlotDialog
            open={addSlotOpen}
            onOpenChange={setAddSlotOpen}
            trainerId={selectedSlotTrainerId}
            lessons={slotTrainerLessons.map(l => ({ id: l.id, title: l.title }))}
            defaultDate={defaultSlotDate}
            defaultTime={defaultSlotTime}
            defaultDuration={60}
            defaultWeeks={8}
            onSlotsCreated={() => fetchSlots()}
            availableLocations={locations}
          />

          <BulkCreateSheet
            open={bulkCreateOpen}
            onOpenChange={setBulkCreateOpen}
            trainerId={selectedSlotTrainerId}
            lessons={slotTrainerLessons.map(l => ({ id: l.id, title: l.title }))}
            defaultDate={defaultSlotDate}
            defaultTime={defaultSlotTime}
            defaultDuration={60}
            defaultWeeks={8}
            onSlotsCreated={() => fetchSlots()}
            availableLocations={locations}
          />

          <DuplicateCyclusDialog
            open={duplicateCyclusOpen}
            onOpenChange={setDuplicateCyclusOpen}
            trainerId={selectedSlotTrainerId || (trainers.length > 0 ? trainers[0].id : "")}
            onCyclusCreated={() => fetchSlots()}
          />

          <CycleForm
            ownerType="academy"
            ownerId={activeAcademy.id}
            open={showCreateCycleDialog}
            onOpenChange={setShowCreateCycleDialog}
            onSuccess={() => fetchSlots()}
            formType="cyclus"
            trainers={trainers.map(t => ({ id: t.id, name: t.name, hourly_rate: t.hourly_rate }))}
            locations={locations}
          />
        </>
      )}
    </>
  );
}
