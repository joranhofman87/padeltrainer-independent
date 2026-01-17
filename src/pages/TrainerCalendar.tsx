import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  format,
  startOfWeek,
  endOfWeek,
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
  startOfMonth,
  endOfMonth,
} from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  LayoutGrid,
  ArrowLeft,
  Plus,
  Repeat,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TrainerCalendarGrid } from "@/components/trainer/TrainerCalendarGrid";
import { SlotWithBookings, BookedPlayer } from "@/components/trainer/CalendarSlotCard";
import { AddSlotDialog, BulkCreateSheet } from "@/components/trainer/AddSlotDialog";
import { SlotTypeChoiceDialog } from "@/components/trainer/SlotTypeChoiceDialog";
import { BookForPlayerDialog } from "@/components/trainer/BookForPlayerDialog";
import { DuplicateCyclusDialog } from "@/components/trainer/DuplicateCyclusDialog";
import { DeleteSlotDialog } from "@/components/trainer/DeleteSlotDialog";
import { EditBookingDialog } from "@/components/trainer/EditBookingDialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

interface Lesson {
  id: string;
  title: string;
  price: number;
  location: string | null;
}

interface ScheduleSettings {
  slot_duration_minutes: number;
  schedule_weeks_ahead: number;
}

export default function TrainerCalendar() {
  const { t } = useTranslation("trainer");
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [view, setView] = useState<"week" | "month">("week");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [slots, setSlots] = useState<SlotWithBookings[]>([]);
  const [loading, setLoading] = useState(true);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [settings, setSettings] = useState<ScheduleSettings>({
    slot_duration_minutes: 60,
    schedule_weeks_ahead: 4,
  });

  // Dialog states
  const [slotTypeChoiceOpen, setSlotTypeChoiceOpen] = useState(false);
  const [addSlotOpen, setAddSlotOpen] = useState(false);
  const [bulkCreateOpen, setBulkCreateOpen] = useState(false);
  const [bookForPlayerOpen, setBookForPlayerOpen] = useState(false);
  const [duplicateCyclusOpen, setDuplicateCyclusOpen] = useState(false);
  const [deleteSlotOpen, setDeleteSlotOpen] = useState(false);
  const [editBookingOpen, setEditBookingOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SlotWithBookings | null>(null);
  const [slotToDelete, setSlotToDelete] = useState<SlotWithBookings | null>(null);
  const [bookingToEdit, setBookingToEdit] = useState<any>(null);
  const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null);
  const [preselectedCyclusId, setPreselectedCyclusId] = useState<string | undefined>();
  const [defaultSlotDate, setDefaultSlotDate] = useState<Date | undefined>();
  const [defaultSlotTime, setDefaultSlotTime] = useState<string | undefined>();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) {
      fetchTrainerData();
    }
  }, [user]);

  useEffect(() => {
    if (trainerId) {
      fetchSlots();
    }
  }, [trainerId, currentDate, view]);

  const fetchTrainerData = async () => {
    try {
      const { data: trainerProfile } = await supabase
        .from("trainer_profiles")
        .select("id, slot_duration_minutes, schedule_weeks_ahead")
        .eq("user_id", user!.id)
        .maybeSingle();

      if (!trainerProfile) return;

      setTrainerId(trainerProfile.id);
      setSettings({
        slot_duration_minutes: trainerProfile.slot_duration_minutes || 60,
        schedule_weeks_ahead: trainerProfile.schedule_weeks_ahead || 4,
      });

      // Fetch lessons with more details
      const { data: lessonData } = await supabase
        .from("lessons")
        .select("id, title, price, location")
        .eq("trainer_id", trainerProfile.id)
        .eq("is_active", true);

      setLessons(lessonData || []);
    } catch (error) {
      console.error("Error fetching trainer data:", error);
    }
  };

  const fetchSlots = async () => {
    setLoading(true);
    try {
      // Get trainer profile
      const { data: trainerProfile } = await supabase
        .from("trainer_profiles")
        .select("id")
        .eq("user_id", user!.id)
        .single();

      if (!trainerProfile) {
        setLoading(false);
        return;
      }

      // Calculate date range
      let rangeStart: Date;
      let rangeEnd: Date;

      if (view === "week") {
        rangeStart = startOfWeek(currentDate, { weekStartsOn: 1 });
        rangeEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
      } else {
        rangeStart = startOfMonth(currentDate);
        rangeEnd = endOfMonth(currentDate);
        // Extend to include full weeks
        rangeStart = startOfWeek(rangeStart, { weekStartsOn: 1 });
        rangeEnd = endOfWeek(rangeEnd, { weekStartsOn: 1 });
      }

      // Fetch availability slots with lessons
      const { data: availabilitySlots, error: slotsError } = await supabase
        .from("availability_slots")
        .select(`
          id,
          start_time,
          end_time,
          lesson_id,
          cyclus_id,
          cyclus_name,
          lessons:lesson_id (
            title,
            max_participants,
            price
          )
        `)
        .eq("trainer_id", trainerProfile.id)
        .gte("start_time", rangeStart.toISOString())
        .lte("start_time", rangeEnd.toISOString())
        .order("start_time");

      if (slotsError) throw slotsError;

      // Fetch bookings for these slots with player names
      const slotIds = availabilitySlots?.map((s) => s.id) || [];
      const { data: bookings, error: bookingsError } = await supabase
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
        .in("slot_id", slotIds.length > 0 ? slotIds : ["none"]);

      if (bookingsError) throw bookingsError;

      // Aggregate booking counts and player info
      const bookingCounts: Record<
        string,
        { confirmed: number; pending: number; players: BookedPlayer[] }
      > = {};
      bookings?.forEach((b) => {
        if (!bookingCounts[b.slot_id]) {
          bookingCounts[b.slot_id] = { confirmed: 0, pending: 0, players: [] };
        }
        if (b.status === "confirmed") {
          bookingCounts[b.slot_id].confirmed++;
        } else if (b.status === "pending") {
          bookingCounts[b.slot_id].pending++;
        }
        
        // Add player info with skill ratings
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

      // Transform to SlotWithBookings
      const now = new Date();
      const transformedSlots: SlotWithBookings[] = (availabilitySlots || []).map(
        (slot) => {
          const lesson = slot.lessons as { title: string; max_participants: number; price: number } | null;
          const counts = bookingCounts[slot.id] || { confirmed: 0, pending: 0, players: [] };

          return {
            id: slot.id,
            start_time: slot.start_time,
            end_time: slot.end_time,
            lesson_id: slot.lesson_id,
            lesson_title: lesson?.title || null,
            max_participants: lesson?.max_participants || 1,
            price: lesson?.price || null,
            active_bookings: counts.confirmed,
            pending_bookings: counts.pending,
            is_past: new Date(slot.start_time) < now,
            cyclus_id: slot.cyclus_id || null,
            cyclus_name: slot.cyclus_name || null,
            booked_players: counts.players,
          };
        }
      );

      setSlots(transformedSlots);
    } catch (error) {
      console.error("Error fetching calendar slots:", error);
    } finally {
      setLoading(false);
    }
  };

  const navigatePrevious = () => {
    if (view === "week") {
      setCurrentDate(subWeeks(currentDate, 1));
    } else {
      setCurrentDate(subMonths(currentDate, 1));
    }
  };

  const navigateNext = () => {
    if (view === "week") {
      setCurrentDate(addWeeks(currentDate, 1));
    } else {
      setCurrentDate(addMonths(currentDate, 1));
    }
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const getDateRangeLabel = () => {
    if (view === "week") {
      const start = startOfWeek(currentDate, { weekStartsOn: 1 });
      const end = endOfWeek(currentDate, { weekStartsOn: 1 });
      return `${format(start, "MMM d")} - ${format(end, "MMM d, yyyy")}`;
    }
    return format(currentDate, "MMMM yyyy");
  };

  // Stats
  const freeSlots = slots.filter(
    (s) => !s.is_past && s.active_bookings === 0 && s.pending_bookings === 0
  ).length;
  const bookedSlots = slots.filter((s) => !s.is_past && s.active_bookings > 0).length;
  const pendingSlots = slots.filter(
    (s) => !s.is_past && s.pending_bookings > 0 && s.active_bookings === 0
  ).length;

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background p-4">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  const handleCellClick = (date: Date, hour: number) => {
    setDefaultSlotDate(date);
    setDefaultSlotTime(`${String(hour).padStart(2, "0")}:00`);
    setSlotTypeChoiceOpen(true);
  };

  const handleChooseSingleSlot = () => {
    setAddSlotOpen(true);
  };

  const handleChooseCyclus = () => {
    setBulkCreateOpen(true);
  };

  const handleSlotsCreated = () => {
    fetchSlots();
  };

  const handleBookForPlayer = (slot: SlotWithBookings) => {
    setSelectedSlot(slot);
    // Find the lesson for this slot
    if (slot.lesson_id) {
      const lesson = lessons.find(l => l.id === slot.lesson_id);
      setSelectedLesson(lesson || null);
    } else {
      setSelectedLesson(null);
    }
    setBookForPlayerOpen(true);
  };

  const handleDuplicateCyclus = (cyclusId: string) => {
    setPreselectedCyclusId(cyclusId);
    setDuplicateCyclusOpen(true);
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
          lessons (id, title, price, location),
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
      console.error("Error fetching booking:", error);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/trainer")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-bold">{t("calendar.title")}</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDefaultSlotDate(undefined);
                setDefaultSlotTime(undefined);
                setAddSlotOpen(true);
              }}
              className="gap-2"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("calendar.addSlot")}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPreselectedCyclusId(undefined);
                setDuplicateCyclusOpen(true);
              }}
              className="gap-2"
            >
              <Copy className="h-4 w-4" />
              <span className="hidden sm:inline">{t("calendar.duplicateCyclus")}</span>
            </Button>
            <Button
              size="sm"
              onClick={() => setBulkCreateOpen(true)}
              className="gap-2"
            >
              <Repeat className="h-4 w-4" />
              <span className="hidden sm:inline">{t("calendar.createCyclus")}</span>
            </Button>
          </div>
        </div>
      </header>

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
                <div className="min-w-[200px] text-center font-medium">
                  {getDateRangeLabel()}
                </div>
                <Button variant="outline" size="icon" onClick={navigateNext}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button variant="outline" onClick={goToToday}>
                  {t("calendar.today")}
                </Button>
              </div>

              {/* View Toggle */}
              <div className="flex items-center gap-2">
                <Button
                  variant={view === "week" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setView("week")}
                >
                  <CalendarDays className="h-4 w-4 mr-2" />
                  {t("calendar.weekView")}
                </Button>
                <Button
                  variant={view === "month" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setView("month")}
                >
                  <LayoutGrid className="h-4 w-4 mr-2" />
                  {t("calendar.monthView")}
                </Button>
              </div>
            </div>

            {/* Quick Stats */}
            <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded bg-muted border border-border" />
                <span className="text-sm">
                  {t("calendar.available")}: {freeSlots}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700" />
                <span className="text-sm">
                  {t("calendar.pending")}: {pendingSlots}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-700" />
                <span className="text-sm">
                  {t("calendar.booked")}: {bookedSlots}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Calendar Grid */}
        <Card>
          <CardContent className="p-4">
            {loading ? (
              <div className="space-y-4">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-[500px] w-full" />
              </div>
            ) : (
              <TrainerCalendarGrid
                slots={slots}
                currentDate={currentDate}
                view={view}
                onCellClick={handleCellClick}
                onBookForPlayer={handleBookForPlayer}
                onDuplicateCyclus={handleDuplicateCyclus}
                onDeleteSlot={handleDeleteSlot}
                onEditBooking={handleEditBooking}
              />
            )}
          </CardContent>
        </Card>
      </main>

      {/* Slot Type Choice Dialog */}
      <SlotTypeChoiceDialog
        open={slotTypeChoiceOpen}
        onOpenChange={setSlotTypeChoiceOpen}
        onChooseSingleSlot={handleChooseSingleSlot}
        onChooseCyclus={handleChooseCyclus}
      />

      {/* Add Slot Dialog */}
      <AddSlotDialog
        open={addSlotOpen}
        onOpenChange={setAddSlotOpen}
        trainerId={trainerId}
        lessons={lessons}
        defaultDate={defaultSlotDate}
        defaultTime={defaultSlotTime}
        defaultDuration={settings.slot_duration_minutes}
        defaultWeeks={settings.schedule_weeks_ahead}
        onSlotsCreated={handleSlotsCreated}
      />

      {/* Bulk Create Sheet */}
      <BulkCreateSheet
        open={bulkCreateOpen}
        onOpenChange={setBulkCreateOpen}
        trainerId={trainerId}
        lessons={lessons}
        defaultDate={defaultSlotDate}
        defaultTime={defaultSlotTime}
        defaultDuration={settings.slot_duration_minutes}
        defaultWeeks={settings.schedule_weeks_ahead}
        onSlotsCreated={handleSlotsCreated}
      />

      {/* Book for Player Dialog */}
      {selectedSlot && (
        <BookForPlayerDialog
          open={bookForPlayerOpen}
          onOpenChange={(open) => {
            setBookForPlayerOpen(open);
            if (!open) {
              setSelectedSlot(null);
              setSelectedLesson(null);
            }
          }}
          trainerId={trainerId!}
          slot={{
            id: selectedSlot.id,
            start_time: selectedSlot.start_time,
            end_time: selectedSlot.end_time,
            lesson_id: selectedSlot.lesson_id,
            cyclus_id: selectedSlot.cyclus_id,
            cyclus_name: selectedSlot.cyclus_name,
            booked_players: selectedSlot.booked_players,
          }}
          lesson={selectedLesson}
          onBookingCreated={handleSlotsCreated}
        />
      )}

      {/* Duplicate Cyclus Dialog */}
      <DuplicateCyclusDialog
        open={duplicateCyclusOpen}
        onOpenChange={(open) => {
          setDuplicateCyclusOpen(open);
          if (!open) {
            setPreselectedCyclusId(undefined);
          }
        }}
        trainerId={trainerId || ""}
        preselectedCyclusId={preselectedCyclusId}
        onCyclusCreated={handleSlotsCreated}
      />

      {/* Delete Slot Dialog */}
      <DeleteSlotDialog
        open={deleteSlotOpen}
        onOpenChange={(open) => {
          setDeleteSlotOpen(open);
          if (!open) {
            setSlotToDelete(null);
          }
        }}
        slot={slotToDelete}
        trainerId={trainerId || ""}
        onSlotDeleted={handleSlotsCreated}
      />

      {/* Edit Booking Dialog */}
      <EditBookingDialog
        open={editBookingOpen}
        onOpenChange={(open) => {
          setEditBookingOpen(open);
          if (!open) {
            setBookingToEdit(null);
          }
        }}
        booking={bookingToEdit}
        trainerId={trainerId || ""}
        onBookingUpdated={handleSlotsCreated}
      />
    </div>
  );
}
