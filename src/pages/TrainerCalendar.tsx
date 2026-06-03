import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { logger } from '@/lib/logger';
import { useTranslation } from "react-i18next";
import {
  format,
  startOfWeek,
  endOfWeek,
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
  addDays,
  subDays,
  startOfMonth,
  endOfMonth,
  parseISO,
} from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  CalendarDays,
  CalendarRange,
  ArrowLeft,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { TrainerCalendarGrid } from "@/components/trainer/TrainerCalendarGrid";
import AgendaWeekByTrainer, { type AgendaSlot } from "@/components/agenda/AgendaWeekByTrainer";
import AgendaMonth from "@/components/agenda/AgendaMonth";
import { SlotWithBookings, BookedPlayer } from "@/components/trainer/CalendarSlotCard";
import { BookForPlayerDialog } from "@/components/trainer/BookForPlayerDialog";
import { DeleteSlotDialog } from "@/components/trainer/DeleteSlotDialog";

import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";

interface ScheduleSettings {
  slot_duration_minutes: number;
  schedule_weeks_ahead: number;
}

type View = "day" | "week" | "month";

const VIEWS: View[] = ["week", "day", "month"];

export default function TrainerCalendar() {
  const { t } = useTranslation("trainer");
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [view, setView] = useState<View>("week");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [slots, setSlots] = useState<SlotWithBookings[]>([]);
  const [loading, setLoading] = useState(true);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [trainerName, setTrainerName] = useState<string>("");
  const [trainerAvatar, setTrainerAvatar] = useState<string | null>(null);
  const [, setSettings] = useState<ScheduleSettings>({
    slot_duration_minutes: 60,
    schedule_weeks_ahead: 4,
  });

  const [bookForPlayerOpen, setBookForPlayerOpen] = useState(false);
  const [deleteSlotOpen, setDeleteSlotOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SlotWithBookings | null>(null);
  const [slotToDelete, setSlotToDelete] = useState<SlotWithBookings | null>(null);

  useEffect(() => {
    if (user) fetchTrainerData();
  }, [user]);

  useEffect(() => {
    if (trainerId) fetchSlots();
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
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name, avatar_url")
        .eq("user_id", user!.id)
        .maybeSingle();
      setTrainerName(profile?.full_name || "");
      setTrainerAvatar(profile?.avatar_url || null);
    } catch (error) {
      logger.error("Error fetching trainer data", error instanceof Error ? error : new Error(String(error)), { component: 'TrainerCalendar' });
    }
  };

  const fetchSlots = async () => {
    setLoading(true);
    try {
      const { data: trainerProfile } = await supabase
        .from("trainer_profiles")
        .select("id")
        .eq("user_id", user!.id)
        .single();
      if (!trainerProfile) {
        setLoading(false);
        return;
      }

      let rangeStart: Date;
      let rangeEnd: Date;
      if (view === "day") {
        rangeStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 0, 0, 0);
        rangeEnd = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 23, 59, 59);
      } else if (view === "week") {
        rangeStart = startOfWeek(currentDate, { weekStartsOn: 1 });
        rangeEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
      } else {
        rangeStart = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 });
        rangeEnd = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 });
      }

      const { data: availabilitySlots, error: slotsError } = await supabase
        .from("availability_slots")
        .select(`
          id, start_time, end_time, is_public, max_participants, price_per_session,
          cyclus_id, cyclus_name, location_id, rating_system, min_rating, max_rating,
          locations:location_id ( name, logo_url )
        `)
        .eq("trainer_id", trainerProfile.id)
        .gte("start_time", rangeStart.toISOString())
        .lte("start_time", rangeEnd.toISOString())
        .order("start_time");
      if (slotsError) throw slotsError;

      const slotIds = availabilitySlots?.map((s) => s.id) || [];
      let bookings: any[] = [];
      if (slotIds.length > 0) {
        const { data: bookingsData, error: bookingsError } = await supabase
          .from("bookings")
          .select(`
            id, slot_id, status, player_id, guest_player_id,
            profiles:player_id (full_name, skill_rating, rating_system),
            guest_players:guest_player_id (full_name, skill_rating, rating_system)
          `)
          .in("slot_id", slotIds);
        if (bookingsError) throw bookingsError;
        bookings = bookingsData || [];
      }

      const bookingCounts: Record<string, { confirmed: number; pending: number; players: BookedPlayer[] }> = {};
      bookings?.forEach((b) => {
        if (!bookingCounts[b.slot_id]) bookingCounts[b.slot_id] = { confirmed: 0, pending: 0, players: [] };
        if (b.status === "confirmed") bookingCounts[b.slot_id].confirmed++;
        else if (b.status === "pending") bookingCounts[b.slot_id].pending++;
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

      const now = new Date();
      const transformedSlots: SlotWithBookings[] = (availabilitySlots || []).map((slot) => {
        const location = slot.locations as { name: string; logo_url?: string | null } | null;
        const counts = bookingCounts[slot.id] || { confirmed: 0, pending: 0, players: [] };
        return {
          id: slot.id,
          start_time: slot.start_time,
          end_time: slot.end_time,
          max_participants: slot.max_participants || 1,
          price: slot.price_per_session || null,
          active_bookings: counts.confirmed,
          pending_bookings: counts.pending,
          is_past: new Date(slot.start_time) < now,
          cyclus_id: slot.cyclus_id || null,
          cyclus_name: slot.cyclus_name || null,
          booked_players: counts.players,
          is_public: slot.is_public,
          location_name: location?.name || null,
          location_id: slot.location_id || null,
          location_logo: location?.logo_url || null,
          rating_system: (slot as any).rating_system || null,
          min_rating: (slot as any).min_rating != null ? Number((slot as any).min_rating) : null,
          max_rating: (slot as any).max_rating != null ? Number((slot as any).max_rating) : null,
        } as SlotWithBookings;
      });
      setSlots(transformedSlots);
    } catch (error) {
      logger.error("Error fetching calendar slots", error instanceof Error ? error : new Error(String(error)), { component: 'TrainerCalendar' });
    } finally {
      setLoading(false);
    }
  };

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
    if (view === "day") return format(currentDate, "EEEE, MMMM d, yyyy");
    if (view === "week") {
      const start = startOfWeek(currentDate, { weekStartsOn: 1 });
      const end = endOfWeek(currentDate, { weekStartsOn: 1 });
      return `${format(start, "MMM d")} - ${format(end, "MMM d, yyyy")}`;
    }
    return format(currentDate, "MMMM yyyy");
  };

  // Build agenda slots (single trainer)
  const agendaSlots: AgendaSlot[] = useMemo(() => {
    return slots.map((s) => ({
      id: s.id,
      start_time: s.start_time,
      end_time: s.end_time,
      trainer_id: trainerId,
      trainer_name: trainerName,
      trainer_avatar: trainerAvatar,
      max_participants: s.max_participants || 1,
      booked_count: s.active_bookings + s.pending_bookings,
      location_id: (s as any).location_id || null,
      location_name: s.location_name,
      location_logo: (s as any).location_logo || null,
      is_public: s.is_public,
    }));
  }, [slots, trainerId, trainerName, trainerAvatar]);

  const trainerOption = useMemo(
    () => (trainerId ? [{ id: trainerId, name: trainerName || t("calendar.you", "You"), avatar: trainerAvatar }] : []),
    [trainerId, trainerName, trainerAvatar, t],
  );

  // Summary tiles (no "active trainers" — single-trainer)
  const summaryStats = useMemo(() => {
    const locMap = new Map<string, { id: string; name: string; logo: string | null }>();
    let bookedHours = 0;
    let freeHours = 0;
    agendaSlots.forEach((s) => {
      const dur = (parseISO(s.end_time).getTime() - parseISO(s.start_time).getTime()) / 3_600_000;
      const max = s.max_participants || 1;
      const booked = Math.min(s.booked_count, max);
      const fillRatio = booked / max;
      bookedHours += dur * fillRatio;
      freeHours += dur * (1 - fillRatio);
      const lkey = s.location_id || s.location_name || '__none__';
      if (!locMap.has(lkey) && (s.location_id || s.location_name)) {
        locMap.set(lkey, { id: s.location_id || lkey, name: s.location_name || '', logo: s.location_logo || null });
      }
    });
    return { activeLocations: Array.from(locMap.values()), bookedHours, freeHours };
  }, [agendaSlots]);

  const fmtHours = (h: number) => (h <= 0 ? '0h' : h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background p-4">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  const handleCellClick = (date: Date, hour: number) => {
    const dateStr = format(date, "yyyy-MM-dd");
    const timeStr = `${String(hour).padStart(2, "0")}:00`;
    navigate(`/app/trainer/slot/new?date=${dateStr}&time=${timeStr}`);
  };

  const handleSlotsCreated = () => fetchSlots();
  const handleBookForPlayer = (slot: SlotWithBookings) => { setSelectedSlot(slot); setBookForPlayerOpen(true); };
  const handleDuplicateCyclus = (cyclusId: string) => navigate(`/app/trainer/slot/new?cyclus=${cyclusId}`);
  const handleDeleteSlot = (slot: SlotWithBookings) => { setSlotToDelete(slot); setDeleteSlotOpen(true); };
  const handleEditBooking = async (bookingId: string) => {
    const slot = slots.find(s => s.booked_players.some(p => p.bookingId === bookingId));
    if (slot) navigate(`/app/trainer/slot/${slot.id}`);
  };

  const handleToggleMarkedFull = async (slotId: string, value: boolean, applyToCyclus?: boolean) => {
    try {
      if (applyToCyclus) {
        const slot = slots.find((s) => s.id === slotId);
        if (slot?.cyclus_id) {
          const { error } = await supabase.from("availability_slots").update({ is_public: !value }).eq("cyclus_id", slot.cyclus_id).gte("start_time", new Date().toISOString());
          if (error) throw error;
          toast({ title: value ? t("calendar.cyclusMarkedFull") : t("calendar.cyclusMarkedOpen") });
        }
      } else {
        const { error } = await supabase.from("availability_slots").update({ is_public: !value }).eq("id", slotId);
        if (error) throw error;
        toast({ title: value ? t("calendar.slotMarkedFull") : t("calendar.slotMarkedOpen") });
      }
      fetchSlots();
    } catch (error) {
      logger.error("Error toggling marked full", error instanceof Error ? error : new Error(String(error)), { component: 'TrainerCalendar' });
    }
  };

  const viewLabel: Record<View, { label: string; icon: typeof CalendarIcon }> = {
    week: { label: t("calendar.weekView", "Week"), icon: CalendarDays },
    day: { label: t("calendar.dayView", "Day"), icon: CalendarIcon },
    month: { label: t("calendar.monthView", "Month"), icon: CalendarRange },
  };

  return (
    <>
      {/* Sub-page Header */}
      <div className="border-b bg-background">
        <div className="container mx-auto px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate("/trainer")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-xl font-display font-semibold">{t("calendar.title")}</h1>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" className="h-9 gap-1.5" onClick={() => navigate("/app/trainer/slot/new")}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("calendar.addSlot")}</span>
            </Button>
          </div>
        </div>
      </div>

      <main className="mx-auto w-full max-w-7xl space-y-4 py-2 sm:py-4">
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
            <div className="rounded-lg border border-border/80 bg-card px-3 py-2.5 shadow-sm">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                {t("calendar.summary.locationsInUse", "Locations in use")}
              </div>
              <div className="flex items-center justify-between gap-2 mt-1">
                <span className="text-2xl font-display font-semibold tabular-nums">
                  {summaryStats.activeLocations.length}
                </span>
                <div className="flex -space-x-2">
                  {summaryStats.activeLocations.slice(0, 4).map((loc, i) => (
                    loc.logo ? (
                      <img key={loc.id + i} src={loc.logo} alt={loc.name}
                        className="h-6 w-6 rounded-full bg-muted object-contain ring-2 ring-card" loading="lazy" />
                    ) : (
                      <span key={loc.id + i} className="h-6 w-6 rounded-full bg-muted ring-2 ring-card flex items-center justify-center text-[9px] font-medium text-muted-foreground">
                        {loc.name.slice(0, 1).toUpperCase() || '?'}
                      </span>
                    )
                  ))}
                  {summaryStats.activeLocations.length > 4 && (
                    <span className="h-6 w-6 rounded-full bg-muted ring-2 ring-card flex items-center justify-center text-[9px] tabular-nums text-muted-foreground">
                      +{summaryStats.activeLocations.length - 4}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border/80 bg-card px-3 py-2.5 shadow-sm">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                {t("calendar.summary.bookedHours", "Booked hours")}
              </div>
              <div className="mt-1">
                <span className="text-2xl font-display font-semibold tabular-nums text-foreground">{fmtHours(summaryStats.bookedHours)}</span>
                <span className="ml-1.5 text-[11px] text-muted-foreground">{t("calendar.summary.training", "training")}</span>
              </div>
            </div>

            <div className="rounded-lg border border-border/80 bg-card px-3 py-2.5 shadow-sm">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                {t("calendar.summary.freeHours", "Free hours")}
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className={cn("text-2xl font-display font-semibold tabular-nums", summaryStats.freeHours > 0 ? "text-foreground" : "text-muted-foreground")}>
                  {fmtHours(summaryStats.freeHours)}
                </span>
                <span className="text-[11px] text-muted-foreground">{t("calendar.summary.openCapacity", "open")}</span>
              </div>
            </div>
          </div>

          {/* View switcher + date nav */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="inline-flex rounded-lg border bg-muted/40 p-0.5 self-start">
              {VIEWS.map((v) => {
                const Icon = viewLabel[v].icon;
                const active = view === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all",
                      active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {viewLabel[v].label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="outline" size="icon" aria-label="Previous" className="h-9 w-9" onClick={navigatePrevious}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="min-w-[160px] sm:min-w-[200px] text-center font-medium text-sm tabular-nums">
                {getDateRangeLabel()}
              </div>
              <Button variant="outline" size="icon" aria-label="Next" className="h-9 w-9" onClick={navigateNext}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" className="h-9" onClick={goToToday}>
                {t("calendar.today")}
              </Button>
            </div>
          </div>

          <TabsContent value="week" className="mt-4">
            <AgendaWeekByTrainer
              slots={agendaSlots}
              trainers={trainerOption}
              currentDate={currentDate}
              onCellClick={(_, day) => { setCurrentDate(day); setView("day"); }}
              onDayHeaderClick={(day) => { setCurrentDate(day); setView("day"); }}
              onSlotClick={(slotId) => navigate(`/app/trainer/slot/${slotId}`)}
            />
          </TabsContent>

          <TabsContent value="day" className="mt-4">
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
                    view="day"
                    onCellClick={handleCellClick}
                    onBookForPlayer={handleBookForPlayer}
                    onDuplicateCyclus={handleDuplicateCyclus}
                    onDeleteSlot={handleDeleteSlot}
                    onEditBooking={handleEditBooking}
                    onToggleMarkedFull={handleToggleMarkedFull}
                    onNavigatePrevious={navigatePrevious}
                    onNavigateNext={navigateNext}
                  />
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="month" className="mt-4">
            <AgendaMonth
              slots={agendaSlots}
              currentDate={currentDate}
              onDayClick={(day) => { setCurrentDate(day); setView("day"); }}
            />
          </TabsContent>
        </Tabs>
      </main>

      {selectedSlot && (
        <BookForPlayerDialog
          open={bookForPlayerOpen}
          onOpenChange={(open) => {
            setBookForPlayerOpen(open);
            if (!open) setSelectedSlot(null);
          }}
          trainerId={trainerId!}
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

      <DeleteSlotDialog
        open={deleteSlotOpen}
        onOpenChange={(open) => {
          setDeleteSlotOpen(open);
          if (!open) setSlotToDelete(null);
        }}
        slot={slotToDelete}
        trainerId={trainerId || ""}
        onSlotDeleted={handleSlotsCreated}
      />
    </>
  );
}
