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
  isBefore,
} from "date-fns";
import { nl, enUS, es, de, fr } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Calendar, CalendarDays, LayoutGrid, ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAcademyContext } from "@/components/academy/AcademyLayout";
import { getAcademyTrainersWithProfiles, getAcademyLocations } from "@/lib/academy";
import { supabase } from "@/lib/supabaseClient";
import { logger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";
import { BulkCreateSheet } from "@/components/trainer/AddSlotDialog";
import { BookForPlayerDialog } from "@/components/trainer/BookForPlayerDialog";
import { DeleteSlotDialog } from "@/components/trainer/DeleteSlotDialog";
import { EditBookingDialog } from "@/components/trainer/EditBookingDialog";

import { TrainerCalendarGrid } from "@/components/trainer/TrainerCalendarGrid";
import { SlotWithBookings, BookedPlayer } from "@/components/trainer/CalendarSlotCard";

interface AcademySlot {
  id: string;
  trainer_id: string;
  start_time: string;
  end_time: string;
  is_marked_full: boolean;
  location_id: string | null;
  max_participants: number;
  cyclus_id: string | null;
  cyclus_name: string | null;
  trainer_name: string;
  trainer_avatar: string | null;
  location_name: string | null;
  active_bookings: number;
  pending_bookings: number;
  booked_players: BookedPlayer[];
  rating_system?: string | null;
  min_rating?: number | null;
  max_rating?: number | null;
  price_per_session?: number | null;
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

const dateFnsLocales: Record<string, typeof enUS> = {
  nl,
  en: enUS,
  es,
  de,
  fr,
};

export default function AcademyCalendar() {
  const { t, i18n } = useTranslation("academy");
  const { t: tTrainer } = useTranslation("trainer");
  const dateLocale = dateFnsLocales[i18n.language] || dateFnsLocales[i18n.language?.split("-")[0]] || enUS;
  const navigate = useNavigate();
  const { activeAcademy } = useAcademyContext();
  const { toast } = useToast();
  
  const [view, setView] = useState<"day" | "week" | "month">("week");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [slots, setSlots] = useState<AcademySlot[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Filter state
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>("all");
  const [selectedLocationId, setSelectedLocationId] = useState<string>("all");
  
  // Slot creation dialog state
  const [slotTypeChoiceOpen, setSlotTypeChoiceOpen] = useState(false);
  const [addSlotOpen, setAddSlotOpen] = useState(false);
  const [bulkCreateOpen, setBulkCreateOpen] = useState(false);
  
  const [defaultSlotDate, setDefaultSlotDate] = useState<Date>();
  const [defaultSlotTime, setDefaultSlotTime] = useState<string>();
  const [selectedSlotTrainerId, setSelectedSlotTrainerId] = useState<string | null>(null);

  // Action dialog state
  const [bookForPlayerOpen, setBookForPlayerOpen] = useState(false);
  const [deleteSlotOpen, setDeleteSlotOpen] = useState(false);
  const [editBookingOpen, setEditBookingOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SlotWithBookings | null>(null);
  const [slotToDelete, setSlotToDelete] = useState<SlotWithBookings | null>(null);
  const [bookingToEdit, setBookingToEdit] = useState<any>(null);
  const [preselectedCyclusId, setPreselectedCyclusId] = useState<string | undefined>();

  const handleCellClick = (day: Date, hour: number) => {
    setDefaultSlotDate(day);
    setDefaultSlotTime(`${String(hour).padStart(2, "0")}:00`);
    const trainerToUse = selectedTrainerId !== "all" ? selectedTrainerId : null;
    setSelectedSlotTrainerId(trainerToUse);
    setSlotTypeChoiceOpen(true);
  };

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
      
      const academyLocations = await getAcademyLocations(activeAcademy.id);
      const locationList: Location[] = academyLocations.map((al: any) => ({
        id: al.location.id,
        name: al.location.name,
        city: al.location.city,
      }));
      setLocations(locationList);
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
      
      const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
      const trainerIds = academyTrainers
        .filter((at: any) => at.status === 'active' && at.trainer_profile)
        .map((at: any) => at.trainer_profile.id);
      
      if (trainerIds.length === 0) {
        setSlots([]);
        setLoading(false);
        return;
      }
      
      const { data: slotsData, error } = await supabase
        .from("availability_slots")
        .select(`
          id,
          trainer_id,
          start_time,
          end_time,
          max_participants,
          is_marked_full,
          location_id,
          cyclus_id,
          cyclus_name,
          rating_system,
          min_rating,
          max_rating,
          price_per_session,
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

      // Fetch bookings WITH player data (same pattern as TrainerCalendar)
      const slotIds = slotsData?.map((s) => s.id) || [];
      let bookings: any[] = [];
      
      if (slotIds.length > 0) {
        const { data: bookingsData, error: bookingsError } = await supabase
          .from("bookings")
          .select(`
            id,
            slot_id,
            status,
            player_id,
            guest_player_id,
            profiles:player_id (full_name, skill_rating, rating_system),
            guest_players:guest_player_id (full_name, skill_rating, rating_system)
          `)
          .in("slot_id", slotIds);

        if (bookingsError) {
          logger.error("Error fetching bookings", bookingsError as Error, { component: "AcademyCalendar" });
        } else {
          bookings = bookingsData || [];
        }
      }

      // Aggregate booking counts and player info
      const bookingCounts: Record<string, { active: number; pending: number; players: BookedPlayer[] }> = {};
      bookings.forEach((b) => {
        if (!bookingCounts[b.slot_id]) {
          bookingCounts[b.slot_id] = { active: 0, pending: 0, players: [] };
        }
        if (b.status === "confirmed") {
          bookingCounts[b.slot_id].active++;
        } else if (b.status === "pending") {
          bookingCounts[b.slot_id].pending++;
        }

        const profile = b.profiles as { full_name: string | null; skill_rating: number | null; rating_system: string } | null;
        const guestPlayer = b.guest_players as { full_name: string | null; skill_rating: number | null; rating_system: string } | null;
        const playerName = profile?.full_name || guestPlayer?.full_name || "Unknown";
        const skillRating = profile?.skill_rating ?? guestPlayer?.skill_rating ?? null;
        const ratingSystem = profile?.rating_system || guestPlayer?.rating_system || 'knltb';

        if (b.status === "confirmed" || b.status === "pending") {
          bookingCounts[b.slot_id].players.push({
            id: b.player_id || b.guest_player_id || b.id,
            bookingId: b.id,
            name: playerName,
            status: b.status as "confirmed" | "pending",
            isGuest: !!b.guest_player_id,
            skillRating,
            ratingSystem,
          });
        }
      });

      const enrichedSlots: AcademySlot[] = (slotsData || []).map((slot: any) => {
        const userId = trainerUserMap.get(slot.trainer_id);
        const profile = userId ? profileMap.get(userId) : null;
        const counts = bookingCounts[slot.id] || { active: 0, pending: 0, players: [] };

        return {
          id: slot.id,
          trainer_id: slot.trainer_id,
          start_time: slot.start_time,
          end_time: slot.end_time,
          is_marked_full: slot.is_marked_full,
          location_id: slot.location_id,
          max_participants: slot.max_participants || 4,
          cyclus_id: slot.cyclus_id || null,
          cyclus_name: slot.cyclus_name || null,
          trainer_name: profile?.full_name || "Unknown",
          trainer_avatar: profile?.avatar_url || null,
          location_name: slot.locations?.name || null,
          active_bookings: counts.active,
          pending_bookings: counts.pending,
          booked_players: counts.players,
          rating_system: slot.rating_system || null,
          min_rating: slot.min_rating != null ? Number(slot.min_rating) : null,
          max_rating: slot.max_rating != null ? Number(slot.max_rating) : null,
          price_per_session: slot.price_per_session || null,
        };
      });

      setSlots(enrichedSlots);
    } catch (error) {
      logger.error("Error fetching academy calendar slots", error as Error, { component: "AcademyCalendar" });
    } finally {
      setLoading(false);
    }
  };

  // Filter slots by selected trainer and location
  const filteredSlots = useMemo(() => {
    return slots.filter(s => {
      if (selectedTrainerId !== "all" && s.trainer_id !== selectedTrainerId) return false;
      if (selectedLocationId !== "all" && s.location_id !== selectedLocationId) return false;
      return true;
    });
  }, [slots, selectedTrainerId, selectedLocationId]);

  // Map to SlotWithBookings for the shared grid
  const mappedSlots: SlotWithBookings[] = useMemo(() => {
    const now = new Date();
    return filteredSlots.map(slot => ({
      id: slot.id,
      start_time: slot.start_time,
      end_time: slot.end_time,
      max_participants: slot.max_participants || 4,
      price: slot.price_per_session || null,
      active_bookings: slot.active_bookings,
      pending_bookings: slot.pending_bookings,
      is_past: new Date(slot.start_time) < now,
      cyclus_id: slot.cyclus_id,
      cyclus_name: slot.cyclus_name,
      booked_players: slot.booked_players,
      is_marked_full: slot.is_marked_full,
      location_name: slot.location_name,
      trainer_id: slot.trainer_id,
      trainer_name: slot.trainer_name,
      trainer_avatar: slot.trainer_avatar,
      rating_system: slot.rating_system || null,
      min_rating: slot.min_rating != null ? Number(slot.min_rating) : null,
      max_rating: slot.max_rating != null ? Number(slot.max_rating) : null,
    }));
  }, [filteredSlots]);

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
  const goToToday = () => setCurrentDate(new Date());

  const getDateRangeLabel = () => {
    if (view === "day") return format(currentDate, "EEEE d MMMM yyyy", { locale: dateLocale });
    if (view === "week") {
      const start = startOfWeek(currentDate, { weekStartsOn: 1 });
      const end = endOfWeek(currentDate, { weekStartsOn: 1 });
      return `${format(start, "d MMM", { locale: dateLocale })} - ${format(end, "d MMM yyyy", { locale: dateLocale })}`;
    }
    return format(currentDate, "MMMM yyyy", { locale: dateLocale });
  };

  // Action handlers
  const handleBookForPlayer = (slot: SlotWithBookings) => {
    setSelectedSlot(slot);
    setBookForPlayerOpen(true);
  };

  const handleDuplicateCyclus = (cyclusId: string) => {
    setPreselectedCyclusId(cyclusId);
    setBulkCreateOpen(true);
  };

  const handleDeleteSlot = (slot: SlotWithBookings) => {
    setSlotToDelete(slot);
    setDeleteSlotOpen(true);
  };

  const handleEditBooking = async (bookingId: string) => {
    try {
      const { data, error } = await supabase
        .from("bookings")
        .select(`
          id,
          status,
          notes,
          payment_status,
          payment_amount,
          guest_player_id,
          availability_slots (id, start_time, end_time),
          profiles:player_id (id, full_name, email)
        `)
        .eq("id", bookingId)
        .single();

      if (error) throw error;

      setBookingToEdit({
        ...data,
        player: data.profiles,
      });
      setEditBookingOpen(true);
    } catch (error) {
      logger.error("Error fetching booking", error instanceof Error ? error : new Error(String(error)), { component: 'AcademyCalendar' });
    }
  };

  const handleToggleMarkedFull = async (
    slotId: string,
    value: boolean,
    applyToCyclus?: boolean
  ) => {
    try {
      if (applyToCyclus) {
        const slot = slots.find((s) => s.id === slotId);
        if (slot?.cyclus_id) {
          const { error } = await supabase
            .from("availability_slots")
            .update({ is_marked_full: value })
            .eq("cyclus_id", slot.cyclus_id)
            .gte("start_time", new Date().toISOString());

          if (error) throw error;

          toast({
            title: value
              ? tTrainer("calendar.cyclusMarkedFull")
              : tTrainer("calendar.cyclusMarkedOpen"),
          });
        }
      } else {
        const { error } = await supabase
          .from("availability_slots")
          .update({ is_marked_full: value })
          .eq("id", slotId);

        if (error) throw error;

        toast({
          title: value
            ? tTrainer("calendar.slotMarkedFull")
            : tTrainer("calendar.slotMarkedOpen"),
        });
      }
      fetchSlots();
    } catch (error) {
      logger.error("Error toggling marked full", error instanceof Error ? error : new Error(String(error)), { component: 'AcademyCalendar' });
    }
  };

  const handleSlotsCreated = () => {
    fetchSlots();
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

  if (loading && slots.length === 0) {
    return (
      <div className="min-h-screen bg-background p-4">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  // Determine trainer ID for dialogs - use filtered trainer or the slot's trainer
  const getTrainerIdForSlot = () => {
    if (selectedSlot?.trainer_id) return selectedSlot.trainer_id;
    if (selectedTrainerId !== "all") return selectedTrainerId;
    return trainers[0]?.id || "";
  };

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
            <TrainerCalendarGrid
              slots={mappedSlots}
              currentDate={currentDate}
              view={view}
              showTrainerInfo
              onCellClick={handleCellClick}
              onBookForPlayer={handleBookForPlayer}
              onDuplicateCyclus={handleDuplicateCyclus}
              onDeleteSlot={handleDeleteSlot}
              onEditBooking={handleEditBooking}
              onToggleMarkedFull={handleToggleMarkedFull}
              onNavigatePrevious={navigatePrevious}
              onNavigateNext={navigateNext}
            />
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
            onChooseCyclus={() => setBulkCreateOpen(true)}
          />

          <AddSlotDialog
            open={addSlotOpen}
            onOpenChange={setAddSlotOpen}
            trainerId={selectedSlotTrainerId}
            defaultDate={defaultSlotDate}
            defaultTime={defaultSlotTime}
            defaultDuration={60}
            defaultWeeks={8}
            onSlotsCreated={handleSlotsCreated}
            availableLocations={locations}
            academyId={activeAcademy?.id}
          />

          <BulkCreateSheet
            open={bulkCreateOpen}
            onOpenChange={(open) => {
              setBulkCreateOpen(open);
              if (!open) {
                setPreselectedCyclusId(undefined);
              }
            }}
            trainerId={selectedSlotTrainerId}
            defaultDate={defaultSlotDate}
            defaultTime={defaultSlotTime}
            defaultDuration={60}
            defaultWeeks={8}
            onSlotsCreated={handleSlotsCreated}
            availableLocations={locations}
            availableTrainers={trainers.map(t => ({ id: t.id, name: t.name }))}
            academyId={activeAcademy?.id}
            prefillFromCyclusId={preselectedCyclusId}
          />

          {/* Book for Player Dialog */}
          {selectedSlot && (
            <BookForPlayerDialog
              open={bookForPlayerOpen}
              onOpenChange={(open) => {
                setBookForPlayerOpen(open);
                if (!open) setSelectedSlot(null);
              }}
              trainerId={selectedSlot.trainer_id || getTrainerIdForSlot()}
              slot={{
                id: selectedSlot.id,
                start_time: selectedSlot.start_time,
                end_time: selectedSlot.end_time,
                cyclus_id: selectedSlot.cyclus_id,
                cyclus_name: selectedSlot.cyclus_name,
                booked_players: selectedSlot.booked_players,
              }}
              onBookingCreated={handleSlotsCreated}
            />
          )}

          {/* Delete Slot Dialog */}
          <DeleteSlotDialog
            open={deleteSlotOpen}
            onOpenChange={(open) => {
              setDeleteSlotOpen(open);
              if (!open) setSlotToDelete(null);
            }}
            slot={slotToDelete}
            trainerId={slotToDelete?.trainer_id || getTrainerIdForSlot()}
            onSlotDeleted={handleSlotsCreated}
          />

          {/* Edit Booking Dialog */}
          <EditBookingDialog
            open={editBookingOpen}
            onOpenChange={(open) => {
              setEditBookingOpen(open);
              if (!open) setBookingToEdit(null);
            }}
            booking={bookingToEdit}
            trainerId={getTrainerIdForSlot()}
            onBookingUpdated={handleSlotsCreated}
          />
        </>
      )}
    </>
  );
}
