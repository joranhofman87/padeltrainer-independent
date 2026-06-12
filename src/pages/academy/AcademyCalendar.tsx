import { useState, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
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
  parseISO,
} from "date-fns";
import { nl, enUS, es, de, fr } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, CalendarDays, CalendarRange, ArrowLeft, Plus, Clock, BarChart3, List, SlidersHorizontal, X, User, MapPin, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AgendaWeekByTrainer, { type AgendaSlot } from "@/components/agenda/AgendaWeekByTrainer";
import AgendaMonth from "@/components/agenda/AgendaMonth";
import { useAcademyContext } from "@/components/academy/AcademyLayout";
import { getAcademyTrainersWithProfiles, getAcademyLocations } from "@/lib/academy";
import {
  GUEST_PLAYER_CALENDAR_SELECT,
  loadGuestPlayersForAcademy,
} from "@/lib/guestPlayers";
import {
  fetchRemovedPlayerKeysForAcademyContext,
  filterGuestRowsByRemoval,
  filterProfileIdsByRemoval,
} from "@/lib/playerRemovalVisibility";
import { supabase } from "@/lib/supabaseClient";
import { logger } from "@/lib/logger";
import {
  parseAcademyCalendarTab,
  ACADEMY_CALENDAR_PRIMARY_TABS,
  isAcademyCalendarScheduleTab,
  type AcademyCalendarTabValue,
} from "@/lib/academyCalendarTab";
import { useToast } from "@/hooks/use-toast";
import { BulkCreateContent } from "@/components/trainer/AddSlotDialog";
import { BookForPlayerDialog } from "@/components/trainer/BookForPlayerDialog";
import { DeleteSlotDialog } from "@/components/trainer/DeleteSlotDialog";
// EditBookingDialog + EditSlotDialog removed — navigating to slot detail page instead
// SlotDetailDialog removed — now using /app/academy/slot/:slotId page

import { SlotWithBookings, BookedPlayer } from "@/components/trainer/CalendarSlotCard";
import AcademyDayGrid, { type KnownPlayer } from "@/components/academy/AcademyDayGrid";
// Legacy week/overview components retired in favor of AgendaWeekByTrainer + AgendaMonth
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
  location_logo: string | null;
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

type TabValue = AcademyCalendarTabValue;

export default function AcademyCalendar() {
  const { t, i18n } = useTranslation("academy");
  const dateLocale = dateFnsLocales[i18n.language] || dateFnsLocales[i18n.language?.split("-")[0]] || enUS;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeAcademy } = useAcademyContext();
  const { toast } = useToast();

  const rawTab = searchParams.get("tab");
  const activeTab = parseAcademyCalendarTab(rawTab);
  const highlightCyclusId = searchParams.get("cyclusId");

  const setActiveTab = (tab: TabValue) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", tab);
    if (tab !== "list") {
      params.delete("cyclusId");
    }
    setSearchParams(params, { replace: true });
  };

  const isPrimaryView = ACADEMY_CALENDAR_PRIMARY_TABS.includes(activeTab);
  const isScheduleView = isAcademyCalendarScheduleTab(activeTab);
  const isMonth = activeTab === "month";

  const [currentDate, setCurrentDate] = useState(new Date());
  const [slots, setSlots] = useState<AcademySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [allKnownPlayers, setAllKnownPlayers] = useState<KnownPlayer[]>([]);

  // For overview: month-wide slots
  const [monthSlots, setMonthSlots] = useState<AcademySlot[]>([]);
  
  // Warning thresholds
  const [_warningMaxRatingSpread, setWarningMaxRatingSpread] = useState<number | null>(null);
  const [_warningMaxAgeDiffYears, setWarningMaxAgeDiffYears] = useState<number | null>(null);

  // Filter state
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>("all");
  const [selectedLocationId, setSelectedLocationId] = useState<string>("all");
  
  // Selected trainer for create tab
  const [selectedSlotTrainerId, _setSelectedSlotTrainerId] = useState<string | null>(null);

  // Action dialog state
  const [bookForPlayerOpen, setBookForPlayerOpen] = useState(false);
  const [deleteSlotOpen, setDeleteSlotOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SlotWithBookings | null>(null);
  const [slotToDelete, setSlotToDelete] = useState<SlotWithBookings | null>(null);
  const [_preselectedCyclusId] = useState<string | undefined>();
  const [_trainerLocationMap, setTrainerLocationMap] = useState<Record<string, string[]>>({});
  // SlotDetailDialog state removed — using page navigation now

  const handleCellClick = (day: Date, hour: number) => {
    const dateStr = format(day, "yyyy-MM-dd");
    const timeStr = `${String(hour).padStart(2, "0")}:00`;
    const trainerParam = selectedTrainerId !== "all" ? `&trainer=${selectedTrainerId}` : "";
    navigate(`/app/academy/slot/new?date=${dateStr}&time=${timeStr}${trainerParam}`);
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
      const tlMap: Record<string, string[]> = {};
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
        price_per_session, locations(name, logo_url)
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
        location_logo: slot.locations?.logo_url || null,
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

      const playerMap = new Map<string, KnownPlayer>();
      const removedKeys = await fetchRemovedPlayerKeysForAcademyContext(
        activeAcademy.id,
        trainerIds,
      );

      // 1) Guest players: trainer-owned (for academy trainers) + academy-level
      const guestRows: any[] = [];
      if (trainerIds.length > 0) {
        const { data: trainerGuests } = await supabase
          .from('guest_players')
          .select(GUEST_PLAYER_CALENDAR_SELECT)
          .in('trainer_id', trainerIds);
        if (trainerGuests) {
          guestRows.push(...filterGuestRowsByRemoval(trainerGuests, removedKeys));
        }
      }

      const { data: academyGuests, error: academyGuestsError } =
        await loadGuestPlayersForAcademy(activeAcademy.id);
      if (academyGuestsError) {
        logger.error(
          "Failed to load academy guest players for calendar",
          academyGuestsError,
          { component: "AcademyCalendar", academyId: activeAcademy.id },
        );
      } else if (academyGuests) {
        guestRows.push(...academyGuests);
      }

      const linkedProfileIds = new Set<string>();
      const seenGuestIds = new Set<string>();
      guestRows.forEach((g) => {
        if (seenGuestIds.has(g.id)) return;
        seenGuestIds.add(g.id);
        if (g.linked_profile_id) linkedProfileIds.add(g.linked_profile_id);
        playerMap.set(`guest-${g.id}`, {
          id: g.id,
          full_name: g.full_name || 'Guest',
          skill_rating: g.skill_rating,
          rating_system: g.rating_system || 'knltb',
          is_guest: true,
        });
      });

      // 2) Registered players: distinct profiles tied to academy trainers via bookings.
      //    Use a two-step query (slot ids first, then bookings) to match the AcademyPlayers
      //    page and avoid PostgREST nested-filter pitfalls.
      if (trainerIds.length > 0) {
        const profileIds = new Set<string>();

        const { data: trainerSlotIds } = await supabase
          .from('availability_slots')
          .select('id')
          .in('trainer_id', trainerIds);

        const slotIdList = (trainerSlotIds || []).map((s: any) => s.id);
        if (slotIdList.length > 0) {
          const { data: bookingPlayers } = await supabase
            .from('bookings')
            .select('player_id')
            .in('slot_id', slotIdList)
            .not('player_id', 'is', null);
          bookingPlayers?.forEach((b: any) => { if (b.player_id) profileIds.add(b.player_id); });
        }

        // Drop ids already covered by a linked guest record
        linkedProfileIds.forEach((id) => profileIds.delete(id));

        const activeProfileIds = filterProfileIdsByRemoval(
          Array.from(profileIds),
          removedKeys,
        );
        if (activeProfileIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, full_name, skill_rating, rating_system')
            .in('id', activeProfileIds);
          profiles?.forEach((p: any) => {
            if (playerMap.has(p.id)) return;
            playerMap.set(p.id, {
              id: p.id,
              full_name: p.full_name || 'Unknown',
              skill_rating: p.skill_rating,
              rating_system: p.rating_system || 'knltb',
              is_guest: false,
            });
          });
        }
      }

      setAllKnownPlayers(
        Array.from(playerMap.values()).sort((a, b) => a.full_name.localeCompare(b.full_name)),
      );
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
    if (activeTab === "hours" || activeTab === "month") {
      setCurrentDate(subMonths(currentDate, 1));
    } else {
      setCurrentDate(subWeeks(currentDate, 1));
    }
  };
  const navigateNext = () => {
    if (activeTab === "hours" || activeTab === "month") {
      setCurrentDate(addMonths(currentDate, 1));
    } else {
      setCurrentDate(addWeeks(currentDate, 1));
    }
  };
  const goToToday = () => setCurrentDate(new Date());

  const getDateRangeLabel = () => {
    if (activeTab === "hours" || activeTab === "month") {
      return format(currentDate, "MMMM yyyy", { locale: dateLocale });
    }
    if (activeTab === "day") {
      return format(currentDate, "EEEE d MMMM", { locale: dateLocale });
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

  const handleDeleteSlot = (slot: SlotWithBookings) => {
    setSlotToDelete(slot);
    setDeleteSlotOpen(true);
  };

  const handleEditSlot = (slot: SlotWithBookings) => {
    navigate(`/app/academy/slot/${slot.id}`);
  };

  const handleEditBooking = async (bookingId: string) => {
    // Find which slot this booking belongs to and navigate to slot detail
    const slot = slots.find(s => s.booked_players.some(p => p.bookingId === bookingId));
    if (slot) {
      navigate(`/app/academy/slot/${slot.id}`);
    }
  };

  const handleSlotsCreated = () => {
    fetchSlots();
    fetchMonthSlots();
  };

  const getTrainerIdForSlot = () => {
    if (selectedSlot?.trainer_id) return selectedSlot.trainer_id;
    if (selectedTrainerId !== "all") return selectedTrainerId;
    return trainers[0]?.id || "";
  };

  const handleSlotClick = (slotId: string) => {
    navigate(`/app/academy/slot/${slotId}`);
  };

  // Build slot list for the new agenda views (week/month).
  const agendaSlots: AgendaSlot[] = useMemo(() => {
    return slots
      .filter((s) => {
        if (selectedTrainerId !== "all" && s.trainer_id !== selectedTrainerId) return false;
        if (selectedLocationId !== "all" && s.location_id !== selectedLocationId) return false;
        return true;
      })
      .map((s) => ({
        id: s.id,
        start_time: s.start_time,
        end_time: s.end_time,
        trainer_id: s.trainer_id,
        trainer_name: s.trainer_name,
        trainer_avatar: s.trainer_avatar,
        max_participants: s.max_participants || 4,
        booked_count: s.active_bookings + s.pending_bookings,
        location_id: s.location_id,
        location_name: s.location_name,
        location_logo: s.location_logo,
        is_public: s.is_public,
      }));
  }, [slots, selectedTrainerId, selectedLocationId]);

  const agendaMonthSlots: AgendaSlot[] = useMemo(() => {
    return monthSlots
      .filter((s) => {
        if (selectedTrainerId !== "all" && s.trainer_id !== selectedTrainerId) return false;
        if (selectedLocationId !== "all" && s.location_id !== selectedLocationId) return false;
        return true;
      })
      .map((s) => ({
        id: s.id,
        start_time: s.start_time,
        end_time: s.end_time,
        trainer_id: s.trainer_id,
        trainer_name: s.trainer_name,
        trainer_avatar: s.trainer_avatar,
        max_participants: s.max_participants || 4,
        booked_count: s.active_bookings + s.pending_bookings,
        location_id: s.location_id,
        location_name: s.location_name,
        location_logo: s.location_logo,
        is_public: s.is_public,
      }));
  }, [monthSlots, selectedTrainerId, selectedLocationId]);

  const trainerOptions = useMemo(
    () => trainers.map((tr) => ({ id: tr.id, name: tr.name, avatar: tr.avatar })),
    [trainers],
  );

  // Summary tiles: scoped to visible range (week or month)
  const summaryStats = useMemo(() => {
    const sourceSlots = isMonth ? agendaMonthSlots : agendaSlots;

    const trainerMap = new Map<string, { id: string; name: string; avatar: string | null }>();
    const locMap = new Map<string, { id: string; name: string; logo: string | null }>();
    let bookedHours = 0;
    let freeHours = 0;

    sourceSlots.forEach((s) => {
      const dur = (parseISO(s.end_time).getTime() - parseISO(s.start_time).getTime()) / 3_600_000;
      const max = s.max_participants || 1;
      const booked = Math.min(s.booked_count, max);
      const fillRatio = booked / max;
      bookedHours += dur * fillRatio;
      freeHours += dur * (1 - fillRatio);

      if (s.trainer_id && !trainerMap.has(s.trainer_id)) {
        trainerMap.set(s.trainer_id, {
          id: s.trainer_id,
          name: s.trainer_name,
          avatar: s.trainer_avatar,
        });
      }
      const lkey = s.location_id || s.location_name || '__none__';
      if (!locMap.has(lkey) && (s.location_id || s.location_name)) {
        locMap.set(lkey, {
          id: s.location_id || lkey,
          name: s.location_name || '',
          logo: s.location_logo || null,
        });
      }
    });

    return {
      activeTrainers: Array.from(trainerMap.values()),
      activeLocations: Array.from(locMap.values()),
      bookedHours,
      freeHours,
    };
  }, [isMonth, agendaSlots, agendaMonthSlots]);

  if (loading && slots.length === 0) {
    return (
      <div className="min-h-screen bg-background p-4">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }


  const filtersActive = selectedTrainerId !== "all" || selectedLocationId !== "all";
  const activeFilterCount = (selectedTrainerId !== "all" ? 1 : 0) + (selectedLocationId !== "all" ? 1 : 0);

  // Map to label primary view in segmented control
  const viewLabel: Record<TabValue, { label: string; icon: typeof CalendarIcon }> = {
    week:    { label: t("calendar.viewWeek", "Week"),     icon: CalendarDays },
    day:     { label: t("calendar.viewDay", "Day"),       icon: CalendarIcon },
    month:   { label: t("calendar.viewMonth", "Month"),   icon: CalendarRange },
    list:    { label: t("calendar.viewList", "List"),      icon: List },
    create:  { label: t("calendar.tabs.create", "Create"), icon: Plus },
    hours:   { label: t("calendar.tabs.hours", "Hours"),   icon: Clock },
    reports: { label: t("calendar.tabs.reports", "Reports"), icon: BarChart3 },
  };

  return (
    <>
      {/* Sub-page Header */}
      <div className="border-b bg-background">
        <div className="container mx-auto px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" aria-label={t("calendar.goBack", "Go back")} onClick={() => navigate("/app/academy")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-xl font-display font-semibold">{t("calendar.title", "Agenda")}</h1>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" className="h-9 gap-1.5" aria-label={t("calendar.new", "New session")} onClick={() => navigate("/app/academy/slot/new")}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("calendar.new", "New session")}</span>
              <span className="sm:hidden">{t("calendar.new", "New")}</span>
            </Button>
          </div>
        </div>
      </div>

      <main className="container mx-auto px-4 py-5 sm:py-6 space-y-4">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabValue)}>
          {/* Summary tiles removed — info surfaced inline in the week table footer/cells */}

          {/* ── Primary view switcher + date nav (only for week/day/month) ── */}
          {isPrimaryView && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {/* Segmented control: Week / Day / Month / List */}
              <div className="inline-flex rounded-lg border bg-muted/40 p-0.5 self-start">
                {ACADEMY_CALENDAR_PRIMARY_TABS.map((v) => {
                  const Icon = viewLabel[v].icon;
                  const active = activeTab === v;
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setActiveTab(v)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all",
                        active
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {viewLabel[v].label}
                    </button>
                  );
                })}
              </div>

              {/* Date nav + filters (week / day / month only) */}
              {isScheduleView && (
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="outline" size="icon" className="h-9 w-9" onClick={navigatePrevious} aria-label={t("calendar.previous", "Previous")}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <div className="min-w-[160px] sm:min-w-[200px] text-center font-medium text-sm tabular-nums">
                  {getDateRangeLabel()}
                </div>
                <Button variant="outline" size="icon" className="h-9 w-9" onClick={navigateNext} aria-label={t("calendar.next", "Next")}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" className="h-9" onClick={goToToday}>
                  {t("common:today", "Today")}
                </Button>

                {/* Filters popover */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9 gap-1.5">
                      <SlidersHorizontal className="h-4 w-4" />
                      <span className="hidden sm:inline">{t("calendar.filters", "Filters")}</span>
                      {activeFilterCount > 0 && (
                        <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                          {activeFilterCount}
                        </Badge>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-72 space-y-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t("calendar.trainer", "Trainer")}</Label>
                      <Select value={selectedTrainerId} onValueChange={setSelectedTrainerId}>
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">{t("calendar.allTrainers", "All trainers")}</SelectItem>
                          {trainers.map((tr) => (
                            <SelectItem key={tr.id} value={tr.id}>{tr.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t("calendar.location", "Location")}</Label>
                      <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">{t("calendar.allLocations", "All locations")}</SelectItem>
                          {locations.map((loc) => (
                            <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {filtersActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full"
                        onClick={() => { setSelectedTrainerId("all"); setSelectedLocationId("all"); }}
                      >
                        {t("calendar.clearFilters", "Clear filters")}
                      </Button>
                    )}
                  </PopoverContent>
                </Popover>
              </div>
              )}
            </div>
          )}

          {/* Active filter chips */}
          {isScheduleView && filtersActive && (() => {
            const trainerName = selectedTrainerId !== "all" ? trainers.find((tr) => tr.id === selectedTrainerId)?.name : null;
            const locationName = selectedLocationId !== "all" ? locations.find((l) => l.id === selectedLocationId)?.name : null;
            const scopeLabel = trainerName && locationName
              ? t("calendar.scopeTrainerAtLocation", { trainer: trainerName, location: locationName, defaultValue: "{{trainer}} at {{location}}" })
              : (trainerName || locationName);
            return (
              <>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    <Filter className="h-3 w-3" />
                    {t("calendar.filteredBy", { defaultValue: "Filtered by" })}
                  </span>
                  {trainerName && (
                    <button
                      onClick={() => setSelectedTrainerId("all")}
                      className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 text-primary px-3 py-1 text-sm font-medium hover:bg-primary/15 transition-colors"
                      aria-label={t("calendar.clearTrainerFilter", { defaultValue: "Clear trainer filter" })}
                    >
                      <User className="h-3.5 w-3.5" />
                      {trainerName}
                      <X className="h-3.5 w-3.5 opacity-70" />
                    </button>
                  )}
                  {locationName && (
                    <button
                      onClick={() => setSelectedLocationId("all")}
                      className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 text-primary px-3 py-1 text-sm font-medium hover:bg-primary/15 transition-colors"
                      aria-label={t("calendar.clearLocationFilter", { defaultValue: "Clear location filter" })}
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      {locationName}
                      <X className="h-3.5 w-3.5 opacity-70" />
                    </button>
                  )}
                  {activeFilterCount > 1 && (
                    <button
                      onClick={() => { setSelectedTrainerId("all"); setSelectedLocationId("all"); }}
                      className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline ml-1"
                    >
                      {t("calendar.clearAll", { defaultValue: "Clear all" })}
                    </button>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
                  <span className="flex items-center gap-2 min-w-0">
                    <Filter className="h-4 w-4 shrink-0" />
                    <span className="truncate">
                      {t("calendar.showingScope", { scope: scopeLabel, defaultValue: "Showing {{scope}}" })}
                    </span>
                  </span>
                  <button
                    onClick={() => { setSelectedTrainerId("all"); setSelectedLocationId("all"); }}
                    className="shrink-0 text-xs font-medium underline-offset-2 hover:underline"
                  >
                    {t("calendar.showAll", { defaultValue: "Show all" })}
                  </button>
                </div>
              </>
            );
          })()}

          {/* Secondary navigation: less-used sections (above agenda so it stays visible) */}
          {isScheduleView && (
            <nav className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">
                {t("calendar.moreSections", "More")}
              </span>
              {(["hours", "reports"] as TabValue[]).map((v) => {
                const Icon = viewLabel[v].icon;
                return (
                  <Button
                    key={v}
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-muted-foreground hover:text-foreground"
                    onClick={() => setActiveTab(v)}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {viewLabel[v].label}
                  </Button>
                );
              })}
            </nav>
          )}

          {/* ── View: Week (per trainer swimlanes) ── */}
          <TabsContent value="week" className="mt-4">
            <AgendaWeekByTrainer
              slots={agendaSlots}
              trainers={trainerOptions}
              currentDate={currentDate}
              summary={summaryStats}
              onCellClick={(trainerId, day) => {
                setSelectedTrainerId(trainerId);
                setCurrentDate(day);
                setActiveTab("day");
              }}
              onTrainerClick={(trainerId) => {
                setSelectedTrainerId(trainerId);
              }}
              onDayHeaderClick={(day) => {
                setCurrentDate(day);
                setActiveTab("day");
              }}
              onSlotClick={handleSlotClick}
            />
          </TabsContent>

          {/* ── View: Day ── */}
          <TabsContent value="day" className="mt-4">
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
          </TabsContent>

          {/* ── View: Month ── */}
          <TabsContent value="month" className="mt-4">
            <AgendaMonth
              slots={agendaMonthSlots}
              currentDate={currentDate}
              onDayClick={(day) => {
                setCurrentDate(day);
                setActiveTab("day");
              }}
            />
          </TabsContent>

          {/* ── View: List (recurring cycle groups) ── */}
          <TabsContent value="list" className="mt-4">
            <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
              <AcademyCyclusOverviewContent highlightCyclusId={highlightCyclusId} />
            </Suspense>
          </TabsContent>

          {/* ── Tab: Create Cyclus ── */}
          <TabsContent value="create" className="mt-4">
            <div className="max-w-6xl w-full">
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

          {/* ── Tab: Trainer Hours ── */}
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

          {/* ── Tab: Reports ── */}
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

        {/* Back-to-agenda link when on a secondary tab */}
        {!isPrimaryView && (
          <div>
            <Button variant="ghost" size="sm" onClick={() => setActiveTab("week")} className="gap-1.5">
              <ArrowLeft className="h-4 w-4" />
              {t("calendar.backToAgenda", "Back to agenda")}
            </Button>
          </div>
        )}
      </main>

      {/* Dialogs */}
      {activeAcademy && (
        <>

          {selectedSlot && (
            <BookForPlayerDialog
              open={bookForPlayerOpen}
              onOpenChange={(open) => {
                setBookForPlayerOpen(open);
                if (!open) setSelectedSlot(null);
              }}
              trainerId={selectedSlot.trainer_id || getTrainerIdForSlot()}
              academyProfileId={activeAcademy.id}
              slot={{
                id: selectedSlot.id,
                start_time: selectedSlot.start_time,
                end_time: selectedSlot.end_time,
                cyclus_id: selectedSlot.cyclus_id,
                cyclus_name: selectedSlot.cyclus_name,
                price_per_session: selectedSlot.price_per_session,
                split_payment: selectedSlot.split_payment,
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

          {/* EditSlotDialog + EditBookingDialog removed — navigating to slot detail page */}

          {/* SlotDetailDialog removed — using /app/academy/slot/:slotId */}
        </>
      )}
    </>
  );
}
