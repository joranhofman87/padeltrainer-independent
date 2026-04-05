import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
  isBefore,
  parseISO,
} from "date-fns";
import { nl, enUS, es, de, fr } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Calendar, CalendarDays, LayoutGrid, ArrowLeft, Plus, Clock, BarChart3, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
import { BulkCreateSheet, BulkCreateContent } from "@/components/trainer/AddSlotDialog";
import { BookForPlayerDialog } from "@/components/trainer/BookForPlayerDialog";
import { DeleteSlotDialog } from "@/components/trainer/DeleteSlotDialog";
import { EditBookingDialog } from "@/components/trainer/EditBookingDialog";
import { EditSlotDialog } from "@/components/trainer/EditSlotDialog";
// SlotDetailDialog removed — now using /app/academy/slot/:slotId page

import { SlotWithBookings, BookedPlayer } from "@/components/trainer/CalendarSlotCard";
import AcademyDayGrid, { type KnownPlayer } from "@/components/academy/AcademyDayGrid";
import AcademyWeekOverview from "@/components/academy/AcademyWeekOverview";
import AcademyCalendarOverview from "@/components/academy/AcademyCalendarOverview";
import AcademyTrainerHours from "@/components/academy/AcademyTrainerHours";
import AcademyReportsTab from "@/components/academy/AcademyReportsTab";
// CycleForm removed — Create tab now uses BulkCreateContent inline

// Lazy-load tab content
import { lazy, Suspense } from "react";
const AcademyCyclusOverviewContent = lazy(() => import("@/pages/academy/AcademyCyclusOverview"));

interface AcademySlot {
  id: string;
  trainer_id: string;
  start_time: string;
  end_time: string;
  is_public: boolean;
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

type TabValue = "overview" | "cycles" | "manage" | "create" | "hours" | "reports";

export default function AcademyCalendar() {
  const { t, i18n } = useTranslation("academy");
  const { t: tTrainer } = useTranslation("trainer");
  const dateLocale = dateFnsLocales[i18n.language] || dateFnsLocales[i18n.language?.split("-")[0]] || enUS;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeAcademy } = useAcademyContext();
  const { toast } = useToast();

  // Tab state from URL
  const activeTab = (searchParams.get("tab") as TabValue) || "overview";
  const setActiveTab = (tab: TabValue) => {
    setSearchParams({ tab }, { replace: true });
  };
  
  const [manageView, setManageView] = useState<"day" | "week">("day");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [slots, setSlots] = useState<AcademySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [allKnownPlayers, setAllKnownPlayers] = useState<KnownPlayer[]>([]);

  // For overview: month-wide slots
  const [monthSlots, setMonthSlots] = useState<AcademySlot[]>([]);
  
  // Warning thresholds
  const [warningMaxRatingSpread, setWarningMaxRatingSpread] = useState<number | null>(null);
  const [warningMaxAgeDiffYears, setWarningMaxAgeDiffYears] = useState<number | null>(null);

  // Filter state
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>("all");
  const [selectedLocationId, setSelectedLocationId] = useState<string>("all");
  
  // Slot creation dialog state
  const [bulkCreateOpen, setBulkCreateOpen] = useState(false);
  const [defaultSlotDate, setDefaultSlotDate] = useState<Date>();
  const [defaultSlotTime, setDefaultSlotTime] = useState<string>();
  const [selectedSlotTrainerId, setSelectedSlotTrainerId] = useState<string | null>(null);

  // Action dialog state
  const [bookForPlayerOpen, setBookForPlayerOpen] = useState(false);
  const [deleteSlotOpen, setDeleteSlotOpen] = useState(false);
  const [editBookingOpen, setEditBookingOpen] = useState(false);
  const [editSlotOpen, setEditSlotOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SlotWithBookings | null>(null);
  const [slotToDelete, setSlotToDelete] = useState<SlotWithBookings | null>(null);
  const [slotToEdit, setSlotToEdit] = useState<SlotWithBookings | null>(null);
  const [bookingToEdit, setBookingToEdit] = useState<any>(null);
  const [preselectedCyclusId, setPreselectedCyclusId] = useState<string | undefined>();
  const [trainerLocationMap, setTrainerLocationMap] = useState<Record<string, string[]>>({});
  // SlotDetailDialog state removed — using page navigation now

  const handleCellClick = (day: Date, hour: number) => {
    setDefaultSlotDate(day);
    setDefaultSlotTime(`${String(hour).padStart(2, "0")}:00`);
    const trainerToUse = selectedTrainerId !== "all" ? selectedTrainerId : null;
    setSelectedSlotTrainerId(trainerToUse);
    setBulkCreateOpen(true);
  };

  useEffect(() => {
    if (activeAcademy) {
      loadAcademyData();
      fetchAllKnownPlayers();
      fetchWarningThresholds();
    }
  }, [activeAcademy]);

  const fetchWarningThresholds = async () => {
    if (!activeAcademy) return;
    const { data } = await supabase
      .from('academy_profiles')
      .select('warning_max_rating_spread, warning_max_age_diff_years')
      .eq('id', activeAcademy.id)
      .maybeSingle();
    if (data) {
      setWarningMaxRatingSpread((data as any).warning_max_rating_spread ?? null);
      setWarningMaxAgeDiffYears((data as any).warning_max_age_diff_years ?? null);
    }
  };

  useEffect(() => {
    if (activeAcademy) {
      fetchSlots(slots.length === 0);
      fetchMonthSlots();
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

      // Build trainer-location map
      const trainerIds = trainerList.map(t => t.id);
      let tlMap: Record<string, string[]> = {};
      if (trainerIds.length > 0) {
        const { data: trainerLocs } = await supabase
          .from('trainer_locations')
          .select('trainer_id, location_id')
          .in('trainer_id', trainerIds);
        if (trainerLocs) {
          for (const tl of trainerLocs) {
            if (!tlMap[tl.location_id]) tlMap[tl.location_id] = [];
            tlMap[tl.location_id].push(tl.trainer_id);
          }
        }
      }
      setTrainerLocationMap(tlMap);
      
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

  // Fetch week slots (for manage tab)
  const fetchSlots = async (showFullLoader = false) => {
    if (!activeAcademy) return;
    if (showFullLoader) setLoading(true);
    try {
      const rangeStart = startOfWeek(currentDate, { weekStartsOn: 1 });
      const rangeEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
      const enriched = await fetchSlotsForRange(rangeStart, rangeEnd);
      setSlots(enriched);
    } catch (error) {
      logger.error("Error fetching academy calendar slots", error as Error, { component: "AcademyCalendar" });
    } finally {
      setLoading(false);
    }
  };

  // Fetch month slots (for overview + trainer hours)
  const fetchMonthSlots = async () => {
    if (!activeAcademy) return;
    try {
      const rangeStart = startOfMonth(currentDate);
      const rangeEnd = endOfMonth(currentDate);
      const enriched = await fetchSlotsForRange(rangeStart, rangeEnd);
      setMonthSlots(enriched);
    } catch (error) {
      logger.error("Error fetching month slots", error as Error, { component: "AcademyCalendar" });
    }
  };

  const fetchSlotsForRange = async (rangeStart: Date, rangeEnd: Date): Promise<AcademySlot[]> => {
    const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy!.id);
    const trainerIds = academyTrainers
      .filter((at: any) => at.status === 'active' && at.trainer_profile)
      .map((at: any) => at.trainer_profile.id);
    
    if (trainerIds.length === 0) return [];
    
    const { data: slotsData, error } = await supabase
      .from("availability_slots")
      .select(`
        id, trainer_id, start_time, end_time, max_participants, is_public,
        location_id, cyclus_id, cyclus_name, rating_system, min_rating, max_rating,
        price_per_session, locations(name)
      `)
      .in("trainer_id", trainerIds)
      .gte("start_time", rangeStart.toISOString())
      .lte("start_time", rangeEnd.toISOString())
      .order("start_time", { ascending: true });

    if (error) {
      logger.error("Error fetching slots", error as Error, { component: "AcademyCalendar" });
      return [];
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

    const profileMap = new Map((profiles || []).map((p) => [p.user_id, p]));
    const trainerUserMap = new Map((trainerProfiles || []).map((tp) => [tp.id, tp.user_id]));

    const slotIds = slotsData?.map((s) => s.id) || [];
    let bookings: any[] = [];
    
    if (slotIds.length > 0) {
      const { data: bookingsData, error: bookingsError } = await supabase
        .from("bookings")
        .select(`
          id, slot_id, status, player_id, guest_player_id,
          profiles:player_id (full_name, skill_rating, rating_system, birth_date),
          guest_players:guest_player_id (full_name, skill_rating, rating_system, birth_date)
        `)
        .in("slot_id", slotIds);

      if (bookingsError) {
        logger.error("Error fetching bookings", bookingsError as Error, { component: "AcademyCalendar" });
      } else {
        bookings = bookingsData || [];
      }
    }

    const bookingCounts: Record<string, { active: number; pending: number; players: BookedPlayer[] }> = {};
    bookings.forEach((b) => {
      if (!bookingCounts[b.slot_id]) {
        bookingCounts[b.slot_id] = { active: 0, pending: 0, players: [] };
      }
      if (b.status === "confirmed") bookingCounts[b.slot_id].active++;
      else if (b.status === "pending") bookingCounts[b.slot_id].pending++;

      const profile = b.profiles as { full_name: string | null; skill_rating: number | null; rating_system: string; birth_date: string | null } | null;
      const guestPlayer = b.guest_players as { full_name: string | null; skill_rating: number | null; rating_system: string; birth_date: string | null } | null;
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
          birthDate: profile?.birth_date ?? guestPlayer?.birth_date ?? null,
        });
      }
    });

    return (slotsData || []).map((slot: any) => {
      const userId = trainerUserMap.get(slot.trainer_id);
      const profile = userId ? profileMap.get(userId) : null;
      const counts = bookingCounts[slot.id] || { active: 0, pending: 0, players: [] };

      return {
        id: slot.id,
        trainer_id: slot.trainer_id,
        start_time: slot.start_time,
        end_time: slot.end_time,
        is_public: slot.is_public,
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
  };

  const fetchAllKnownPlayers = async () => {
    if (!activeAcademy) return;
    try {
      const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
      const trainerIds = academyTrainers
        .filter((at: any) => at.status === 'active' && at.trainer_profile)
        .map((at: any) => at.trainer_profile.id);
      if (trainerIds.length === 0) return;

      const { data: bookingPlayers } = await supabase
        .from('bookings')
        .select('player_id, guest_player_id, profiles:player_id(id, full_name, skill_rating, rating_system), guest_players:guest_player_id(id, full_name, skill_rating, rating_system), availability_slots!inner(trainer_id)')
        .in('availability_slots.trainer_id', trainerIds)
        .not('status', 'eq', 'cancelled');

      const playerMap = new Map<string, KnownPlayer>();
      (bookingPlayers || []).forEach((b: any) => {
        if (b.profiles?.id && !playerMap.has(b.profiles.id)) {
          playerMap.set(b.profiles.id, {
            id: b.profiles.id,
            full_name: b.profiles.full_name || 'Unknown',
            skill_rating: b.profiles.skill_rating,
            rating_system: b.profiles.rating_system || 'knltb',
            is_guest: false,
          });
        }
        if (b.guest_players?.id && !playerMap.has(`guest-${b.guest_players.id}`)) {
          playerMap.set(`guest-${b.guest_players.id}`, {
            id: b.guest_players.id,
            full_name: b.guest_players.full_name || 'Guest',
            skill_rating: b.guest_players.skill_rating,
            rating_system: b.guest_players.rating_system || 'knltb',
            is_guest: true,
          });
        }
      });

      setAllKnownPlayers(Array.from(playerMap.values()).sort((a, b) => a.full_name.localeCompare(b.full_name)));
    } catch (error) {
      logger.error('Error fetching known players', error as Error, { component: 'AcademyCalendar' });
    }
  };

  const filteredSlots = useMemo(() => {
    return slots.filter(s => {
      if (selectedTrainerId !== "all" && s.trainer_id !== selectedTrainerId) return false;
      if (selectedLocationId !== "all" && s.location_id !== selectedLocationId) return false;
      return true;
    });
  }, [slots, selectedTrainerId, selectedLocationId]);

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
      is_public: slot.is_public,
      location_name: slot.location_name,
      trainer_id: slot.trainer_id,
      trainer_name: slot.trainer_name,
      trainer_avatar: slot.trainer_avatar,
      rating_system: slot.rating_system || null,
      min_rating: slot.min_rating != null ? Number(slot.min_rating) : null,
      max_rating: slot.max_rating != null ? Number(slot.max_rating) : null,
    }));
  }, [filteredSlots]);

  // Overview data from week slots (same as manage tab)
  const overviewSlots = useMemo(() => {
    return slots.map(s => ({
      id: s.id,
      start_time: s.start_time,
      end_time: s.end_time,
      trainer_name: s.trainer_name,
      trainer_id: s.trainer_id,
      trainer_avatar: s.trainer_avatar,
      max_participants: s.max_participants,
      booked_count: s.active_bookings + s.pending_bookings,
      location_name: s.location_name,
      location_id: s.location_id,
      is_public: s.is_public,
      players: s.booked_players.map(p => ({
        rating: p.skillRating ?? null,
        birthDate: p.birthDate ?? null,
      })),
    }));
  }, [slots]);

  // Trainer hours data from month slots
  const trainerHoursSlots = useMemo(() => {
    return monthSlots.map(s => ({
      id: s.id,
      trainer_id: s.trainer_id,
      start_time: s.start_time,
      end_time: s.end_time,
      booked_count: s.active_bookings + s.pending_bookings,
    }));
  }, [monthSlots]);

  const navigatePrevious = () => {
    if (activeTab === "hours") {
      setCurrentDate(subMonths(currentDate, 1));
    } else {
      setCurrentDate(subWeeks(currentDate, 1));
    }
  };
  const navigateNext = () => {
    if (activeTab === "hours") {
      setCurrentDate(addMonths(currentDate, 1));
    } else {
      setCurrentDate(addWeeks(currentDate, 1));
    }
  };
  const goToToday = () => setCurrentDate(new Date());

  const getDateRangeLabel = () => {
    if (activeTab === "hours") {
      return format(currentDate, "MMMM yyyy", { locale: dateLocale });
    }
    const start = startOfWeek(currentDate, { weekStartsOn: 1 });
    const end = endOfWeek(currentDate, { weekStartsOn: 1 });
    return `${format(start, "d MMM", { locale: dateLocale })} - ${format(end, "d MMM yyyy", { locale: dateLocale })}`;
  };

  // DnD handlers
  const handleMovePlayer = async (bookingId: string, newSlotId: string) => {
    try {
      const { error } = await supabase
        .from('bookings')
        .update({ slot_id: newSlotId })
        .eq('id', bookingId);
      if (error) throw error;
      toast({ title: t('calendar.playerMoved', { defaultValue: 'Player moved' }) });
      fetchSlots();
    } catch (error) {
      logger.error('Error moving player', error as Error, { component: 'AcademyCalendar' });
      toast({ title: t('calendar.moveFailed', { defaultValue: 'Failed to move player' }), variant: 'destructive' });
    }
  };

  const handleRemovePlayer = async (bookingId: string) => {
    try {
      const { error } = await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', bookingId);
      if (error) throw error;
      toast({ title: t('calendar.playerRemoved', { defaultValue: 'Player removed from slot' }) });
      fetchSlots();
    } catch (error) {
      logger.error('Error removing player', error as Error, { component: 'AcademyCalendar' });
      toast({ title: t('calendar.removeFailed', { defaultValue: 'Failed to remove player' }), variant: 'destructive' });
    }
  };

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

  const handleEditSlot = (slot: SlotWithBookings) => {
    setSlotToEdit(slot);
    setEditSlotOpen(true);
  };

  const handleEditBooking = async (bookingId: string) => {
    try {
      const { data, error } = await supabase
        .from("bookings")
        .select(`
          id, status, notes, payment_status, payment_amount, guest_player_id, paid_externally,
          availability_slots (id, start_time, end_time, price_per_session, cyclus_name),
          profiles:player_id (id, full_name, email)
        `)
        .eq("id", bookingId)
        .single();

      if (error) throw error;
      setBookingToEdit({ ...data, player: data.profiles });
      setEditBookingOpen(true);
    } catch (error) {
      logger.error("Error fetching booking", error instanceof Error ? error : new Error(String(error)), { component: 'AcademyCalendar' });
    }
  };

  const handleToggleMarkedFull = async (slotId: string, value: boolean, applyToCyclus?: boolean) => {
    try {
      if (applyToCyclus) {
        const slot = slots.find((s) => s.id === slotId);
        if (slot?.cyclus_id) {
          const { error } = await supabase
            .from("availability_slots")
            .update({ is_public: !value })
            .eq("cyclus_id", slot.cyclus_id)
            .gte("start_time", new Date().toISOString());
          if (error) throw error;
          toast({ title: value ? tTrainer("calendar.cyclusMarkedFull") : tTrainer("calendar.cyclusMarkedOpen") });
        }
      } else {
        const { error } = await supabase
          .from("availability_slots")
          .update({ is_public: !value })
          .eq("id", slotId);
        if (error) throw error;
        toast({ title: value ? tTrainer("calendar.slotMarkedFull") : tTrainer("calendar.slotMarkedOpen") });
      }
      fetchSlots();
    } catch (error) {
      logger.error("Error toggling marked full", error instanceof Error ? error : new Error(String(error)), { component: 'AcademyCalendar' });
    }
  };

  const handleSlotsCreated = () => {
    fetchSlots();
    fetchMonthSlots();
  };

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

  const getTrainerIdForSlot = () => {
    if (selectedSlot?.trainer_id) return selectedSlot.trainer_id;
    if (selectedTrainerId !== "all") return selectedTrainerId;
    return trainers[0]?.id || "";
  };

  const handleOverviewDayClick = (date: Date) => {
    setCurrentDate(date);
    setActiveTab("manage");
    setManageView("day");
  };

  const handleSlotClick = (slotId: string) => {
    navigate(`/app/academy/slot/${slotId}`);
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
            <h1 className="text-xl font-bold">{t("calendar.title", "Agenda")}</h1>
          </div>
        </div>
      </div>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabValue)}>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <TabsList className="h-9">
              <TabsTrigger value="overview" className="text-xs sm:text-sm gap-1.5">
                <LayoutGrid className="h-3.5 w-3.5" />
                {t("calendar.tabs.overview", "Overview")}
              </TabsTrigger>
              <TabsTrigger value="cycles" className="text-xs sm:text-sm gap-1.5">
                <Repeat className="h-3.5 w-3.5" />
                {t("calendar.tabs.cycles", "Cycles")}
              </TabsTrigger>
              <TabsTrigger value="manage" className="text-xs sm:text-sm gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                {t("calendar.tabs.manage", "Manage")}
              </TabsTrigger>
              <TabsTrigger value="create" className="text-xs sm:text-sm gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                {t("calendar.tabs.create", "Create")}
              </TabsTrigger>
              <TabsTrigger value="hours" className="text-xs sm:text-sm gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                {t("calendar.tabs.hours", "Trainer Hours")}
              </TabsTrigger>
              <TabsTrigger value="reports" className="text-xs sm:text-sm gap-1.5">
                <BarChart3 className="h-3.5 w-3.5" />
                {t("calendar.tabs.reports", "Reports")}
              </TabsTrigger>
            </TabsList>

            <Button size="sm" className="h-9 gap-1.5" onClick={() => setActiveTab("create" as TabValue)}>
              <Plus className="h-4 w-4" />
              {t("calendar.new", "New")}
            </Button>

            {/* Date Navigation (only for hours tab — overview and manage have their own) */}
            {activeTab === "hours" && (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" className="h-8 w-8" onClick={navigatePrevious}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <div className="min-w-[120px] sm:min-w-[200px] text-center font-medium text-sm">
                  {getDateRangeLabel()}
                </div>
                <Button variant="outline" size="icon" className="h-8 w-8" onClick={navigateNext}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" className="h-8" onClick={goToToday}>
                  {t("calendar.today", "Today")}
                </Button>
              </div>
            )}
          </div>

          {/* ── Tab 1: Overview ── */}
          <TabsContent value="overview" className="mt-4">
            <AcademyCalendarOverview
              slots={overviewSlots}
              currentDate={currentDate}
              onDayClick={handleOverviewDayClick}
              onSlotClick={handleSlotClick}
              trainers={trainers.map(t => ({ id: t.id, name: t.name }))}
              locations={locations.map(l => ({ id: l.id, name: l.name }))}
              onNavigatePrevious={navigatePrevious}
              onNavigateNext={navigateNext}
              onGoToday={goToToday}
              dateRangeLabel={getDateRangeLabel()}
              warningMaxRatingSpread={warningMaxRatingSpread}
              warningMaxAgeDiffYears={warningMaxAgeDiffYears}
            />
          </TabsContent>

          {/* ── Tab: Cycles ── */}
          <TabsContent value="cycles" className="mt-4">
            <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
              <AcademyCyclusOverviewContent />
            </Suspense>
          </TabsContent>

          {/* ── Tab 3: Manage Agenda ── */}
          <TabsContent value="manage" className="mt-4 space-y-4">
            {/* Controls Card */}
            <Card>
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
                  {/* Left: View Toggle + Navigation */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex items-center gap-1">
                      <Button variant={manageView === "day" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setManageView("day")}>
                        <Calendar className="h-4 w-4 sm:mr-1" />
                        <span className="hidden sm:inline">{t("calendar.dayView", "Day")}</span>
                      </Button>
                      <Button variant={manageView === "week" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setManageView("week")}>
                        <CalendarDays className="h-4 w-4 sm:mr-1" />
                        <span className="hidden sm:inline">{t("calendar.weekView", "Week")}</span>
                      </Button>
                    </div>
                    <div className="w-px h-6 bg-border hidden sm:block" />
                    <Button variant="outline" size="icon" className="h-8 w-8" onClick={navigatePrevious}>
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <div className="min-w-[140px] text-center font-medium text-sm">
                      {getDateRangeLabel()}
                    </div>
                    <Button variant="outline" size="icon" className="h-8 w-8" onClick={navigateNext}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <Button variant="outline" size="sm" className="h-8" onClick={goToToday}>
                      {t("calendar.today", "Today")}
                    </Button>
                  </div>

                  {/* Right: Filters */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
                      <SelectTrigger className="w-[160px] h-8">
                        <SelectValue placeholder={t("calendar.allLocations", "All Locations")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t("calendar.allLocations", "All Locations")}</SelectItem>
                        {locations.map(loc => (
                          <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
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
                          <SelectItem key={trainer.id} value={trainer.id}>{trainer.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Quick Stats */}
                <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded bg-muted border border-border" />
                    <span>{t("calendar.available", "Available")}: {freeSlots}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700" />
                    <span>{t("calendar.pending", "Pending")}: {pendingSlots}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded bg-emerald-100 dark:bg-emerald-900/30 border border-emerald-300 dark:border-emerald-700" />
                    <span>{t("calendar.booked", "Booked")}: {bookedSlots}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Calendar Grid */}
            {manageView === "day" ? (
              <AcademyDayGrid
                slots={mappedSlots}
                currentDate={currentDate}
                allKnownPlayers={allKnownPlayers}
                trainers={trainers.map(t => ({ id: t.id, name: t.name, avatar: t.avatar }))}
                onMovePlayer={handleMovePlayer}
                onRemovePlayer={handleRemovePlayer}
                onBookForPlayer={handleBookForPlayer}
                onEditBooking={handleEditBooking}
                onEditSlot={handleEditSlot}
                onDeleteSlot={handleDeleteSlot}
                onCellClick={handleCellClick}
              />
            ) : (
              <Card>
                <CardContent className="p-4">
                  <AcademyWeekOverview
                    slots={mappedSlots}
                    currentDate={currentDate}
                    trainers={trainers.map(t => ({ id: t.id, name: t.name, avatar: t.avatar }))}
                    onDayClick={(date) => {
                      setCurrentDate(date);
                      setManageView("day");
                    }}
                  />
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── Tab 4: Create Cyclus ── */}
          <TabsContent value="create" className="mt-4">
            <div className="max-w-lg">
              {activeAcademy && (
                <BulkCreateContent
                  trainerId={selectedSlotTrainerId}
                  defaultDuration={60}
                  defaultWeeks={8}
                  onSlotsCreated={handleSlotsCreated}
                  availableLocations={locations}
                  availableTrainers={trainers.map(t => ({ id: t.id, name: t.name }))}
                  academyId={activeAcademy?.id}
                />
              )}
            </div>
          </TabsContent>

          {/* ── Tab 5: Trainer Hours ── */}
          <TabsContent value="hours" className="mt-4">
            <AcademyTrainerHours
              slots={trainerHoursSlots}
              trainers={trainers.map(t => ({
                id: t.id,
                name: t.name,
                avatar: t.avatar,
                hourly_rate: t.hourly_rate,
              }))}
              currentDate={currentDate}
            />
          </TabsContent>

          {/* ── Tab 6: Reports ── */}
          <TabsContent value="reports" className="mt-4">
            {activeAcademy && (
              <AcademyReportsTab
                academyId={activeAcademy.id}
                trainers={trainers.map(t => ({ id: t.id, name: t.name }))}
                locations={locations.map(l => ({ id: l.id, name: l.name }))}
              />
            )}
          </TabsContent>
        </Tabs>
      </main>
      
      {/* Dialogs */}
      {activeAcademy && (
        <>
          <BulkCreateSheet
            open={bulkCreateOpen}
            onOpenChange={(open) => {
              setBulkCreateOpen(open);
              if (!open) setPreselectedCyclusId(undefined);
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

          <EditSlotDialog
            open={editSlotOpen}
            onOpenChange={(open) => {
              setEditSlotOpen(open);
              if (!open) setSlotToEdit(null);
            }}
            slot={slotToEdit}
            onSlotUpdated={handleSlotsCreated}
            trainers={trainers.map(t => ({ id: t.id, name: t.name }))}
            locations={locations.map(l => ({ id: l.id, name: l.name }))}
          />

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

          {/* SlotDetailDialog removed — using /app/academy/slot/:slotId */}
        </>
      )}
    </>
  );
}
