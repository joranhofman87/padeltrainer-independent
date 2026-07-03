import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Locale } from "date-fns";
import { useNavigate } from "react-router-dom";
import { format, isPast, parseISO, differenceInCalendarDays, addDays } from "date-fns";
import { nl, enUS, de, fr, es, it as itLocale } from "date-fns/locale";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/hooks/useAuth";
import { getTrainerProfile } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { invalidateAllPlayerData } from "@/lib/playerQueryKeys";
import { syncSplitCountForCycle } from "@/lib/invoiceSync";
import { cancelBookingsAndSync, setBookingPaymentAndReconcile, insertBookings } from "@/lib/bookings";
import { applySlotDeleteToCycle } from "@/lib/slotDeleteGuard";
import { insertAvailabilitySlots, setSlotVisibility } from "@/lib/slots";
import { updateCycleSettings, type CycleSettings } from "@/lib/cycles";
import { mergeNewBookingIdsIntoCycleInvoices, syncInvoicesAfterCycleEdit } from "@/lib/cycleEditInvoiceSync";
import { getFriendlyErrorMessage } from "@/lib/friendlyError";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SelectFilter } from "@/components/ui/select-filter";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import {
  Search,
  ChevronDown,
  ChevronRight,
  Calendar,
  CalendarIcon,
  Users,
  Pencil,
  MapPin,
  Loader2,
  X,
  AlertTriangle,
  Lock,
  LockOpen,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TrainerAttendanceForm } from "@/components/attendance/TrainerAttendanceForm";
import { useToast } from "@/hooks/use-toast";
import { ExtraCostPresetPicker } from "@/components/settings/ExtraCostPresetPicker";
import { fetchBookableGuestPlayers } from '@/lib/playersOverview';

const localeMap: Record<string, Locale> = { nl, en: enUS, de, fr, es, it: itLocale };

type ExtraCost = { description: string; price: number; type?: 'per_session' | 'one_time'; vat_rate?: number };

type SlotWithBookings = {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  max_participants: number | null;
  is_public: boolean;
  location_id: string | null;
  price_per_session: number | null;
  prices_include_vat: boolean;
  extra_costs: ExtraCost[] | null;
  split_payment: boolean | null;
  locations?: { name: string; city: string } | null;
  bookings: {
    id: string;
    status: string;
    payment_status: string;
    player_id: string | null;
    guest_player_id: string | null;
    profiles?: { full_name: string | null } | null;
    guest_players?: { full_name: string } | null;
  }[];
};

type TabValue = "current" | "future" | "past";

type CycleEditData = {
  name: string;
  pricePerSession: string;
  locationId: string;
  maxParticipants: string;
  isPrivate: boolean;
  extraCosts: ExtraCost[];
  startDate: Date | undefined;
  originalStartDate: Date | undefined;
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
  originalStartTime: string;
  originalEndTime: string;
  repeatCount: string;
  originalRepeatCount: number;
  pricesIncludeVat: boolean;
  splitPayment: boolean;
  originalSplitPayment: boolean;
  // Captured at open so the save can detect whether the price/extra-costs/VAT-mode
  // actually changed → only then re-derive the cyclus's unpaid invoices.
  originalPricePerSession: string;
  originalExtraCosts: ExtraCost[];
  originalPricesIncludeVat: boolean;
};

type TrainerLocationOption = {
  id: string;
  name: string;
  city: string;
};

export default function TrainerScheduleOverview() {
  const { t, i18n } = useTranslation("trainer");
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<TabValue>("current");
  // Scale guard: load only the recent past by default (all current + future are always loaded since
  // the bound has no upper limit). "Load older" widens the window so no history is ever lost.
  const HISTORY_WINDOW_STEP = 12; // months added per "load older" click
  const [historyMonths, setHistoryMonths] = useState(6);
  const [search, setSearch] = useState("");
  const [filterDay, setFilterDay] = useState("all");
  const [filterLocation, setFilterLocation] = useState("all");
  const [filterTime, setFilterTime] = useState("all");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["__individual__"]));
  const [expandedSlots, setExpandedSlots] = useState<Set<string>>(new Set());

  // Edit cycle dialog
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editCycleId, setEditCycleId] = useState<string | null>(null);
  const [editCycleSlotCount, setEditCycleSlotCount] = useState(0);
  const [cycleEditData, setCycleEditData] = useState<CycleEditData>({
    name: "",
    pricePerSession: "",
    locationId: "",
    maxParticipants: "",
    isPrivate: false,
    extraCosts: [],
    startDate: undefined,
    originalStartDate: undefined,
    startTime: "",
    endTime: "",
    originalStartTime: "",
    originalEndTime: "",
    repeatCount: "0",
    originalRepeatCount: 0,
    pricesIncludeVat: true,
    splitPayment: false,
    originalSplitPayment: false,
    originalPricePerSession: "",
    originalExtraCosts: [],
    originalPricesIncludeVat: true,
  });
  const [savingEdit, setSavingEdit] = useState(false);

  // Cycle player management
  type CyclePlayer = { id: string; name: string; type: 'player' | 'guest'; bookingCount: number };
  type GuestPlayerOption = { id: string; full_name: string };
  const [editCyclePlayers, setEditCyclePlayers] = useState<CyclePlayer[]>([]);
  const [availableGuestPlayers, setAvailableGuestPlayers] = useState<GuestPlayerOption[]>([]);
  const [addingPlayerToCycle, setAddingPlayerToCycle] = useState(false);
  const [removingPlayerFromCycle, setRemovingPlayerFromCycle] = useState<string | null>(null);
  const [confirmRemoveCyclePlayer, setConfirmRemoveCyclePlayer] = useState<CyclePlayer | null>(null);

  // Remove player confirm
  const [removeBookingId, setRemoveBookingId] = useState<string | null>(null);
  const [removingBooking, setRemovingBooking] = useState(false);

  // Payment toggle loading
  const [togglingPayment, setTogglingPayment] = useState<string | null>(null);
  const [togglingPrivacy, setTogglingPrivacy] = useState<string | null>(null);

  const dateFnsLocale = localeMap[i18n.language] || enUS;

  const { data: slots, isLoading, isFetching } = useQuery({
    queryKey: ["trainer-schedule-overview", user?.id, historyMonths],
    queryFn: async () => {
      if (!user) return [];
      const tp = await getTrainerProfile(user.id);
      if (!tp) return [];

      // Lower-bound the fetch to the last `historyMonths` (no upper bound → all current + future
      // sessions always load). Widening historyMonths via "Load older" re-runs this query with an
      // earlier bound, so older history is loaded on demand and never silently dropped.
      const historyStart = new Date();
      historyStart.setMonth(historyStart.getMonth() - historyMonths);

      const { data, error } = await supabase
        .from("availability_slots")
        .select(`
          id, start_time, end_time, cyclus_id, cyclus_name, max_participants, is_public, location_id, price_per_session, prices_include_vat, extra_costs, split_payment,
          locations:location_id (name, city),
          bookings (id, status, payment_status, player_id, guest_player_id,
            profiles:player_id (full_name),
            guest_players:guest_player_id (full_name)
          )
        `)
        .eq("trainer_id", tp.id)
        .gte("start_time", historyStart.toISOString())
        .order("start_time", { ascending: true });

      if (error) throw error;
      return (data || []) as unknown as SlotWithBookings[];
    },
    enabled: !!user,
  });

  // Fetch trainer profile ID for preset picker
  const { data: trainerProfileId } = useQuery({
    queryKey: ["trainer-profile-id-for-overview", user?.id],
    queryFn: async () => {
      if (!user) return null;
      const tp = await getTrainerProfile(user.id);
      return tp?.id || null;
    },
    enabled: !!user,
  });

  // Fetch trainer locations for edit dialog
  const { data: trainerLocations } = useQuery({
    queryKey: ["trainer-locations-for-overview", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const tp = await getTrainerProfile(user.id);
      if (!tp) return [];
      const { data, error } = await supabase
        .from("trainer_locations")
        .select("location_id, locations:location_id (id, name, city)")
        .eq("trainer_id", tp.id);
      if (error) return [];
      return (data || [])
        .map((tl: any) => tl.locations)
        .filter(Boolean) as TrainerLocationOption[];
    },
    enabled: !!user,
  });

  const grouped = useMemo(() => {
    if (!slots) return new Map<string, { name: string; slots: SlotWithBookings[] }>();
    const map = new Map<string, { name: string; slots: SlotWithBookings[] }>();
    for (const s of slots) {
      const key = s.cyclus_id || "__individual__";
      if (!map.has(key)) {
        map.set(key, {
          name: s.cyclus_name || t("scheduleOverview.individualSessions", "Individual Sessions"),
          slots: [],
        });
      }
      map.get(key)!.slots.push(s);
    }
    return map;
  }, [slots, t]);

  const hasActiveFilters = filterDay !== "all" || filterLocation !== "all" || filterTime !== "all";

  // Filter by tab (per-cycle-group) + day/location/time (per-slot, but if any slot matches, show ALL slots)
  const filtered = useMemo(() => {
    const now = new Date();
    const result = new Map<string, { name: string; slots: SlotWithBookings[] }>();

    grouped.forEach((group, key) => {
      // Classify the entire cycle based on first/last session dates
      const allStarts = group.slots.map((s) => parseISO(s.start_time).getTime());
      const allEnds = group.slots.map((s) => parseISO(s.end_time).getTime());
      const firstStart = Math.min(...allStarts);
      const lastEnd = Math.max(...allEnds);
      const nowMs = now.getTime();

      let cycleStatus: "past" | "current" | "future";
      if (lastEnd < nowMs) {
        cycleStatus = "past";
      } else if (firstStart > nowMs) {
        cycleStatus = "future";
      } else {
        cycleStatus = "current";
      }

      // Tab filter: skip entire cycle if it doesn't match the selected tab
      if (tab !== cycleStatus) return;

      // Check if any slot in this cycle matches the day/location/time filters
      const anySlotMatchesFilters = group.slots.some((s) => {
        const start = parseISO(s.start_time);

        if (filterDay !== "all" && start.getDay().toString() !== filterDay) return false;
        if (filterLocation !== "all" && s.location_id !== filterLocation) return false;
        if (filterTime !== "all") {
          const hour = start.getHours();
          if (filterTime === "morning" && (hour < 6 || hour >= 12)) return false;
          if (filterTime === "afternoon" && (hour < 12 || hour >= 17)) return false;
          if (filterTime === "evening" && (hour < 17 || hour >= 23)) return false;
        }
        return true;
      });

      if (!anySlotMatchesFilters) return;

      // Show ALL slots from matching cycles (don't split them)
      const allSlots = group.slots;

      if (search.trim()) {
        const q = search.toLowerCase();
        const nameMatch = group.name.toLowerCase().includes(q);
        const slotMatches = allSlots.filter((s) => {
          const playerNames = s.bookings.map((b) =>
            (b.profiles?.full_name || b.guest_players?.full_name || "").toLowerCase()
          );
          return playerNames.some((n) => n.includes(q));
        });
        if (nameMatch) {
          result.set(key, { name: group.name, slots: allSlots });
        } else if (slotMatches.length > 0) {
          result.set(key, { name: group.name, slots: allSlots });
        }
      } else {
        result.set(key, { name: group.name, slots: allSlots });
      }
    });

    return result;
  }, [grouped, tab, search, filterDay, filterLocation, filterTime]);

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSlot = (id: string) => {
    setExpandedSlots((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const getActiveBookings = (bookings: SlotWithBookings["bookings"]) =>
    bookings.filter((b) => b.status !== "cancelled");

  const getPaidCount = (bookings: SlotWithBookings["bookings"]) =>
    getActiveBookings(bookings).filter((b) => b.payment_status === "paid").length;

  const getUnpaidCount = (bookings: SlotWithBookings["bookings"]) =>
    getActiveBookings(bookings).filter((b) => b.payment_status !== "paid").length;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["trainer-schedule-overview"] });

  // Edit cycle
  const openEditDialog = async (cycleId: string, group: { name: string; slots: SlotWithBookings[] }) => {
    const firstSlot = group.slots[0];
    const sortedSlots = [...group.slots].sort((a, b) => a.start_time.localeCompare(b.start_time));
    const earliestStart = sortedSlots[0] ? parseISO(sortedSlots[0].start_time) : undefined;
    const slotStartTime = firstSlot ? format(parseISO(firstSlot.start_time), "HH:mm") : "";
    const slotEndTime = firstSlot ? format(parseISO(firstSlot.end_time), "HH:mm") : "";
    const extraCosts: ExtraCost[] = Array.isArray(firstSlot?.extra_costs) ? (firstSlot.extra_costs as ExtraCost[]) : [];
    setEditCycleId(cycleId);
    setEditCycleSlotCount(group.slots.length);
    setCycleEditData({
      name: group.name,
      pricePerSession: firstSlot?.price_per_session != null ? String(firstSlot.price_per_session) : "",
      locationId: firstSlot?.location_id || "",
      maxParticipants: firstSlot?.max_participants != null ? String(firstSlot.max_participants) : "",
      isPrivate: !(firstSlot?.is_public ?? true),
      extraCosts: extraCosts.length > 0 ? extraCosts : [],
      startDate: earliestStart,
      originalStartDate: earliestStart,
      startTime: slotStartTime,
      endTime: slotEndTime,
      originalStartTime: slotStartTime,
      originalEndTime: slotEndTime,
      repeatCount: String(group.slots.length),
      originalRepeatCount: group.slots.length,
      pricesIncludeVat: firstSlot?.prices_include_vat ?? true,
      splitPayment: firstSlot?.split_payment ?? false,
      originalSplitPayment: firstSlot?.split_payment ?? false,
      originalPricePerSession: firstSlot?.price_per_session != null ? String(firstSlot.price_per_session) : "",
      originalExtraCosts: extraCosts.length > 0 ? extraCosts : [],
      originalPricesIncludeVat: firstSlot?.prices_include_vat ?? true,
    });

    // Collect unique players from all bookings across cycle slots
    const playerMap = new Map<string, CyclePlayer>();
    for (const slot of group.slots) {
      for (const b of slot.bookings) {
        if (b.status === 'cancelled') continue;
        const id = b.guest_player_id || b.player_id || '';
        if (!id) continue;
        const existing = playerMap.get(id);
        if (existing) {
          existing.bookingCount++;
        } else {
          playerMap.set(id, {
            id,
            name: b.profiles?.full_name || b.guest_players?.full_name || t("scheduleOverview.unknownPlayer", "Unknown"),
            type: b.guest_player_id ? 'guest' : 'player',
            bookingCount: 1,
          });
        }
      }
    }
    setEditCyclePlayers(Array.from(playerMap.values()));

    // Fetch trainer's guest players
    if (user) {
      const tp = await getTrainerProfile(user.id);
      if (tp) {
        const guests = await fetchBookableGuestPlayers({ kind: 'trainer', id: tp.id });
        setAvailableGuestPlayers(guests.map((g) => ({ id: g.id, full_name: g.full_name })));
      }
    }

    setEditDialogOpen(true);
  };

  const handleSaveCycleEdit = async () => {
    if (!editCycleId || !cycleEditData.name.trim()) return;
    setSavingEdit(true);

    try {
      const normalizedSessionPrice = cycleEditData.pricePerSession.trim().replace(",", ".");
      const parsedSessionPrice = normalizedSessionPrice === "" ? null : Number(normalizedSessionPrice);
      const hasValidSessionPrice = parsedSessionPrice !== null && Number.isFinite(parsedSessionPrice);
      const sessionPrice = hasValidSessionPrice ? parsedSessionPrice : null;

      if (cycleEditData.pricePerSession !== "" && sessionPrice === null) {
        toast({
          title: t("scheduleOverview.invalidPrice", "Enter a valid session price"),
          variant: "destructive",
        });
        return;
      }

      // 1. Build bulk updates for all existing slots
      const updates: Record<string, unknown> = {
        cyclus_name: cycleEditData.name.trim(),
        is_public: !cycleEditData.isPrivate,
        extra_costs: cycleEditData.extraCosts.length > 0 ? cycleEditData.extraCosts : null,
        prices_include_vat: cycleEditData.pricesIncludeVat,
        split_payment: cycleEditData.splitPayment,
      };
      if (sessionPrice !== null) {
        updates.price_per_session = sessionPrice;
      }
      if (cycleEditData.locationId) {
        updates.location_id = cycleEditData.locationId;
      }
      if (cycleEditData.maxParticipants !== "") {
        updates.max_participants = parseInt(cycleEditData.maxParticipants, 10);
      }

      // 2. Handle date/time shift
      const dateChanged = cycleEditData.startDate && cycleEditData.originalStartDate &&
        cycleEditData.startDate.getTime() !== cycleEditData.originalStartDate.getTime();
      const timeChanged = cycleEditData.startTime !== cycleEditData.originalStartTime ||
        cycleEditData.endTime !== cycleEditData.originalEndTime;

      if (dateChanged || timeChanged) {
        const { data: cycleSlots } = await supabase
          .from("availability_slots")
          .select("id, start_time, end_time")
          .eq("cyclus_id", editCycleId)
          .order("start_time", { ascending: true });

        if (cycleSlots) {
          for (const cs of cycleSlots) {
            const oldStart = new Date(cs.start_time);
            const oldEnd = new Date(cs.end_time);
            let newStart = new Date(oldStart);
            let newEnd = new Date(oldEnd);

            // Apply date shift using calendar days (timezone-safe)
            if (dateChanged) {
              const dayDelta = differenceInCalendarDays(cycleEditData.startDate!, cycleEditData.originalStartDate!);
              newStart = addDays(newStart, dayDelta);
              newEnd = addDays(newEnd, dayDelta);
            }

            // Apply time change (set new hours/minutes on each slot)
            if (timeChanged) {
              const [startH, startM] = cycleEditData.startTime.split(":").map(Number);
              const [endH, endM] = cycleEditData.endTime.split(":").map(Number);
              newStart.setHours(startH, startM, 0, 0);
              newEnd.setHours(endH, endM, 0, 0);
              // Handle end time crossing midnight
              if (newEnd <= newStart) {
                newEnd.setDate(newEnd.getDate() + 1);
              }
            }

            const { error: slotShiftErr } = await supabase
              .from("availability_slots")
              .update({ ...updates, start_time: newStart.toISOString(), end_time: newEnd.toISOString() })
              .eq("id", cs.id);
            if (slotShiftErr) throw slotShiftErr;
          }
        }
      } else {
        // No date/time shift — just bulk update
        const { error: bulkUpdateErr } = await supabase
          .from("availability_slots")
          .update(updates)
          .eq("cyclus_id", editCycleId);
        if (bulkUpdateErr) throw bulkUpdateErr;
      }

      // 3. Handle repeat count change
      const newCount = parseInt(cycleEditData.repeatCount, 10);
      if (!isNaN(newCount) && newCount !== cycleEditData.originalRepeatCount) {
        const { data: cycleSlots } = await supabase
          .from("availability_slots")
          .select("*")
          .eq("cyclus_id", editCycleId)
          .order("start_time", { ascending: true });

        if (cycleSlots && cycleSlots.length > 0) {
          if (newCount > cycleSlots.length) {
            // Add new slots at the end
            const lastSlot = cycleSlots[cycleSlots.length - 1];
            const lastStart = new Date(lastSlot.start_time);
            const lastEnd = new Date(lastSlot.end_time);
            const slotsToAdd = newCount - cycleSlots.length;

            const newSlots = [];
            for (let i = 1; i <= slotsToAdd; i++) {
              const newStart = new Date(lastStart.getTime() + i * 7 * 24 * 60 * 60 * 1000);
              const newEnd = new Date(lastEnd.getTime() + i * 7 * 24 * 60 * 60 * 1000);
              newSlots.push({
                trainer_id: lastSlot.trainer_id,
                start_time: newStart.toISOString(),
                end_time: newEnd.toISOString(),
                cyclus_id: editCycleId,
                cyclus_name: cycleEditData.name.trim(),
                max_participants: lastSlot.max_participants,
                is_public: !cycleEditData.isPrivate,
                location_id: cycleEditData.locationId || lastSlot.location_id,
                price_per_session: sessionPrice ?? lastSlot.price_per_session,
                extra_costs: cycleEditData.extraCosts.length > 0 ? cycleEditData.extraCosts : lastSlot.extra_costs,
                academy_profile_id: lastSlot.academy_profile_id,
                allow_single_booking: lastSlot.allow_single_booking,
                court_type: lastSlot.court_type,
                min_participants: lastSlot.min_participants,
                min_rating: lastSlot.min_rating,
                max_rating: lastSlot.max_rating,
                rating_system: lastSlot.rating_system,
                training_level: lastSlot.training_level,
                total_price: lastSlot.total_price,
                prices_include_vat: cycleEditData.pricesIncludeVat,
              });
            }
            const { data: insertedSlotsData, error: insertSlotsErr } = await insertAvailabilitySlots(newSlots, supabase, "id, start_time");
            if (insertSlotsErr) throw insertSlotsErr;
            const insertedSlots = insertedSlotsData as { id: string; start_time: string }[] | null;

            // Auto-book existing players/guests on the new slots
            if (insertedSlots && insertedSlots.length > 0) {
              // Find all enrolled players/guests from existing cycle bookings
              const existingSlotIds = cycleSlots.map((s) => s.id);
              const { data: existingBookings } = await supabase
                .from("bookings")
                .select("player_id, guest_player_id, status, payment_amount, payment_status")
                .in("slot_id", existingSlotIds)
                .in("status", ["confirmed", "attended", "pending"]);

              if (existingBookings && existingBookings.length > 0) {
                // Get unique players (by player_id or guest_player_id)
                const playerMap = new Map<string, typeof existingBookings[0]>();
                for (const b of existingBookings) {
                  const key = b.player_id || b.guest_player_id || "";
                  if (key && !playerMap.has(key)) playerMap.set(key, b);
                }

                const newBookings: any[] = [];
                for (const [, templateBooking] of playerMap) {
                  for (const newSlot of insertedSlots) {
                    newBookings.push({
                      slot_id: newSlot.id,
                      player_id: templateBooking.player_id,
                      guest_player_id: templateBooking.guest_player_id,
                      status: templateBooking.status,
                      payment_amount: templateBooking.payment_amount,
                      payment_status: templateBooking.payment_status || "pending",
                    });
                  }
                }

                if (newBookings.length > 0) {
                  const { data, error: createBookingsErr } = await insertBookings(newBookings, supabase, "id, player_id, guest_player_id");
                  if (createBookingsErr) throw createBookingsErr;
                  const createdBookings = data as { id: string; player_id: string | null; guest_player_id: string | null }[] | null;

                  // Add new booking IDs to unpaid invoices so section 3b recalculates them.
                  // Owner: src/lib/cycleEditInvoiceSync.ts (per-player routing; see
                  // docs/audits/TSO_INVOICE_WRITES_AUDIT.md).
                  await mergeNewBookingIdsIntoCycleInvoices(
                    { createdBookings: createdBookings ?? [], existingSlotIds },
                    supabase,
                  );
                }
              }
            }
          } else if (newCount < cycleSlots.length) {
            // Remove trailing slots without active bookings. Route through the atomic
            // guard (the canonical RPC slot-detail / cycle-detail already use): it locks
            // the bookings FOR UPDATE and KEEPS any trailing slot that gained a booking
            // since the list loaded — closing the client check-then-delete TOCTOU vs
            // bookings.slot_id ON DELETE CASCADE (a concurrent booking landing between the
            // check and the delete would otherwise be cascade-destroyed). Only unbooked
            // slots are ever deleted, so no booking is removed and no invoice changes.
            const slotsToRemove = cycleSlots.length - newCount;
            const trailingSlots = cycleSlots.slice(-slotsToRemove);
            const res = await applySlotDeleteToCycle(editCycleId, trailingSlots.map((s) => s.id));

            if (res.protectedCount > 0) {
              toast({
                title: t("scheduleOverview.cannotRemoveBookedSlots", "Cannot remove {{count}} session(s) with active bookings", { count: res.protectedCount }),
                variant: "destructive",
              });
            }
          }
        }
      }

      // 3b. Re-derive this cyclus's unpaid invoices — but ONLY when something that
      // affects the billed price actually changed. A benign edit (rename, location,
      // privacy, max-participants) must NOT rewrite every overlapping invoice.
      const sessionPriceChanged = cycleEditData.pricePerSession.trim() !== cycleEditData.originalPricePerSession.trim();
      const extraCostsChanged = JSON.stringify(cycleEditData.extraCosts) !== JSON.stringify(cycleEditData.originalExtraCosts);
      const lengthChanged = !isNaN(newCount) && newCount !== cycleEditData.originalRepeatCount;
      const vatModeChanged = cycleEditData.pricesIncludeVat !== cycleEditData.originalPricesIncludeVat;
      const splitChanged = cycleEditData.splitPayment !== cycleEditData.originalSplitPayment;
      const recalcNeeded = sessionPriceChanged || extraCostsChanged || lengthChanged || vatModeChanged;

      // Persist split_payment + the fresh extra_costs to the cycle settings (the single
      // write authority; a DB trigger mirrors split_payment onto the slots). extra_costs
      // MUST be written here BEFORE the recalc: the canonical extra-cost resolver prefers
      // cycles.settings.extra_costs over the slot value, so a stale entry would otherwise
      // win and bill the old extras. (Previously only split_payment was persisted, and
      // only on a split change — div-009.)
      if (splitChanged || recalcNeeded) {
        const { data: cycleRow } = await supabase
          .from("cycles")
          .select("settings")
          .eq("id", editCycleId)
          .maybeSingle();
        if (cycleRow) {
          const settings: Record<string, unknown> = ((cycleRow.settings as Record<string, unknown>) || {});
          settings.split_payment = cycleEditData.splitPayment;
          settings.extra_costs = cycleEditData.extraCosts;
          await updateCycleSettings(editCycleId, settings as CycleSettings);
        }
      }

      // Route the recalc through the canonical cycle resync (rebuilds line items from
      // the real bookings, reads invoices.split_count, total = subtotal + vat, guarded
      // optimistic write). owner: src/lib/cycleEditInvoiceSync.ts.
      if (recalcNeeded) {
        await syncInvoicesAfterCycleEdit(editCycleId);
      }

      // 4. If splitPayment toggled ON (from off), re-split existing invoices.
      if (cycleEditData.splitPayment && !cycleEditData.originalSplitPayment) {
        // Find all bookings on this cycle's slots
        const { data: cycleSlotIds } = await supabase
          .from("availability_slots")
          .select("id")
          .eq("cyclus_id", editCycleId);

        if (cycleSlotIds && cycleSlotIds.length > 0) {
          const slotIdList = cycleSlotIds.map((s) => s.id);
          const { data: cycleBookings } = await supabase
            .from("bookings")
            .select("id")
            .in("slot_id", slotIdList)
            .in("status", ["confirmed", "attended"]);

          if (cycleBookings && cycleBookings.length > 0) {
            const bookingIdList = cycleBookings.map((b) => b.id);

            // Find active unpaid invoices (exclude cancelled and paid, skip already-split)
            const { data: invoices } = await supabase
              .from("invoices")
              .select("id, booking_ids, status, line_items")
              .in("status", ["draft", "sent", "overdue", "pending"]);

            if (invoices && invoices.length > 0) {
              const matchingInvoices = invoices.filter((inv) => {
                const ids = (inv.booking_ids as string[]) || [];
                const hasMatchingBooking = ids.some((bid) => bookingIdList.includes(bid));
                // Skip invoices already split (line items contain "(1/" pattern)
                const lineItems = (inv.line_items as any[]) || [];
                const alreadySplit = lineItems.some((li: any) => /\(1\/\d+\)/.test(li.description || ""));
                return hasMatchingBooking && !alreadySplit;
              });

              let splitCount = 0;
              for (const inv of matchingInvoices) {
                try {
                  const { error: splitErr } = await supabase.functions.invoke("split-invoice", {
                    body: { invoiceId: inv.id },
                  });
                  if (!splitErr) splitCount++;
                } catch {
                  // non-blocking
                }
              }

              if (splitCount > 0) {
                toast({
                  title: t("scheduleOverview.invoicesSplit", "{{count}} invoice(s) split over players", { count: splitCount }),
                });
              }
            }
          }
        }
      }

      toast({ title: t("scheduleOverview.cycleSaved", "Cycle updated") });
      setEditDialogOpen(false);
      invalidate();
    } catch (err: any) {
      toast({ title: "Error", description: getFriendlyErrorMessage(err, t("scheduleOverview.genericError", "Something went wrong. Please try again.")), variant: "destructive" });
    } finally {
      setSavingEdit(false);
    }
  };

  // Toggle payment — route through the canonical facade so the linked invoice is
  // reconciled (marked paid when fully covered / reverted when not), never left stale.
  const handleTogglePayment = async (bookingId: string, currentStatus: string) => {
    setTogglingPayment(bookingId);
    const { bookingError, invoiceSyncError } = await setBookingPaymentAndReconcile(
      bookingId,
      currentStatus !== "paid",
    );
    setTogglingPayment(null);
    if (bookingError) {
      toast({ title: "Error", description: getFriendlyErrorMessage(bookingError, t("scheduleOverview.genericError", "Something went wrong. Please try again.")), variant: "destructive" });
      return;
    }
    if (invoiceSyncError) {
      toast({ title: "Error", description: t("scheduleOverview.invoiceSyncFailed", "Payment saved, but a linked invoice could not be updated. Please check the invoice."), variant: "destructive" });
    } else {
      toast({ title: t("scheduleOverview.paymentUpdated", "Payment status updated") });
    }
    invalidate();
  };

  // Remove player
  const handleRemovePlayer = async () => {
    if (!removeBookingId) return;
    setRemovingBooking(true);
    // Canonical cancel + invoice reconcile (src/lib/bookings.ts) so the
    // booking↔invoice write matches every other remove-player path. The cancel
    // commits before the sync, so a sync failure is surfaced as a stale-invoice
    // warning rather than a false "removed".
    const { cancelError, syncError } = await cancelBookingsAndSync([removeBookingId]);
    if (cancelError) {
      setRemovingBooking(false);
      toast({ title: "Error", description: getFriendlyErrorMessage(cancelError, t("scheduleOverview.genericError", "Something went wrong. Please try again.")), variant: "destructive" });
      return;
    }
    const syncFailed = !!syncError;
    if (syncError) {
      logger.error("Invoice sync failed after player removal", syncError, { component: 'TrainerScheduleOverview' });
    }
    setRemovingBooking(false);
    setRemoveBookingId(null);
    if (syncFailed) {
      toast({
        title: t("scheduleOverview.removedButSyncFailed", "Player removed, but invoices could not be fully updated"),
        description: t("scheduleOverview.removedSyncFailedDesc", "Some invoices may still bill the removed player or show the wrong split. Please review this cycle's invoices."),
        variant: "destructive",
      });
    } else {
      toast({ title: t("scheduleOverview.playerRemoved", "Player removed from session") });
    }
    invalidate();
  };

  // Toggle slot privacy
  const handleToggleSlotPrivacy = async (slotId: string, currentValue: boolean) => {
    setTogglingPrivacy(slotId);
    const { error } = await setSlotVisibility(slotId, currentValue);
    setTogglingPrivacy(null);
    if (error) {
      toast({ title: "Error", description: getFriendlyErrorMessage(error, t("scheduleOverview.genericError", "Something went wrong. Please try again.")), variant: "destructive" });
    } else {
      toast({
        title: !currentValue
          ? t("scheduleOverview.markAsPrivate", "Mark as private")
          : t("scheduleOverview.markAsPublic", "Mark as public"),
      });
      invalidate();
    }
  };

  // Add player to all cycle slots
  const handleAddPlayerToCycle = async (guestPlayerId: string) => {
    if (!editCycleId) return;
    setAddingPlayerToCycle(true);
    try {
      const { data: cycleSlots } = await supabase
        .from("availability_slots")
        .select("id")
        .eq("cyclus_id", editCycleId);

      if (!cycleSlots || cycleSlots.length === 0) return;

      // Check which slots already have this guest player booked
      const { data: existingBookings } = await supabase
        .from("bookings")
        .select("slot_id")
        .eq("guest_player_id", guestPlayerId)
        .in("slot_id", cycleSlots.map(s => s.id))
        .neq("status", "cancelled");

      const alreadyBookedSlotIds = new Set((existingBookings || []).map(b => b.slot_id));
      const slotsToBook = cycleSlots.filter(s => !alreadyBookedSlotIds.has(s.id));

      if (slotsToBook.length > 0) {
        const newBookings = slotsToBook.map(s => ({
          slot_id: s.id,
          guest_player_id: guestPlayerId,
          status: 'confirmed',
          payment_status: 'pending',
        }));
        await insertBookings(newBookings);

        // Mark player as has_trained
        await supabase.from("guest_players").update({ has_trained: true }).eq("id", guestPlayerId);
        if (trainerProfileId) {
          invalidateAllPlayerData(queryClient, { kind: "trainer", id: trainerProfileId });
        }
      }

      // Update local player list
      const guest = availableGuestPlayers.find(g => g.id === guestPlayerId);
      if (guest) {
        setEditCyclePlayers(prev => [...prev, {
          id: guestPlayerId,
          name: guest.full_name,
          type: 'guest',
          bookingCount: cycleSlots.length,
        }]);
      }

      // Recalculate split invoices for all players in the cycle
      try {
        await syncSplitCountForCycle(editCycleId);
      } catch (err) {
        logger.error("Split count sync failed after adding player to cycle", err instanceof Error ? err : new Error(String(err)), { component: 'TrainerScheduleOverview' });
      }

      toast({ title: t("scheduleOverview.addedToCycle", "Player added to all sessions") });
      invalidate();
    } catch (err: any) {
      toast({ title: "Error", description: getFriendlyErrorMessage(err, t("scheduleOverview.genericError", "Something went wrong. Please try again.")), variant: "destructive" });
    } finally {
      setAddingPlayerToCycle(false);
    }
  };

  // Remove player from all cycle slots
  const handleRemovePlayerFromCycle = async () => {
    if (!confirmRemoveCyclePlayer || !editCycleId) return;
    const player = confirmRemoveCyclePlayer;
    setRemovingPlayerFromCycle(player.id);
    try {
      const { data: cycleSlots } = await supabase
        .from("availability_slots")
        .select("id")
        .eq("cyclus_id", editCycleId);

      if (cycleSlots && cycleSlots.length > 0) {
        const field = player.type === 'guest' ? 'guest_player_id' : 'player_id';
        
        // Get the booking IDs before cancelling so we can sync invoices
        const { data: bookingsToCancel } = await supabase
          .from("bookings")
          .select("id")
          .eq(field, player.id)
          .in("slot_id", cycleSlots.map(s => s.id))
          .neq("status", "cancelled");

        const cancelledIds = (bookingsToCancel || []).map(b => b.id);

        if (cancelledIds.length > 0) {
          // Canonical cancel + invoice reconcile (src/lib/bookings.ts), shared
          // with handleRemovePlayer. A cancel failure now surfaces (was
          // previously unchecked → could silently proceed as if removed).
          const { cancelError, syncError } = await cancelBookingsAndSync(cancelledIds);
          if (cancelError) throw cancelError;

          // Surface a sync failure instead of a false "success": the removed
          // player may still be billed / the split is stale (the cancel already
          // committed). The cycle-scope split recalc stays here (not a per-
          // booking concern).
          let syncFailed = !!syncError;
          if (syncError) {
            logger.error("Invoice sync failed after cycle player removal", syncError, { component: 'TrainerScheduleOverview' });
          }
          try {
            await syncSplitCountForCycle(editCycleId);
          } catch (err) {
            syncFailed = true;
            logger.error("Split count sync failed after cycle player removal", err instanceof Error ? err : new Error(String(err)), { component: 'TrainerScheduleOverview' });
          }

          if (syncFailed) {
            setEditCyclePlayers(prev => prev.filter(p => p.id !== player.id));
            toast({
              title: t("scheduleOverview.removedButSyncFailed", "Player removed, but invoices could not be fully updated"),
              description: t("scheduleOverview.removedSyncFailedDesc", "Some invoices may still bill the removed player or show the wrong split. Please review this cycle's invoices."),
              variant: "destructive",
            });
            invalidate();
            return;
          }
        }
      }

      setEditCyclePlayers(prev => prev.filter(p => p.id !== player.id));
      toast({ title: t("scheduleOverview.removedFromCycle", "Player removed from all sessions") });
      invalidate();
    } catch (err: any) {
      toast({ title: "Error", description: getFriendlyErrorMessage(err, t("scheduleOverview.genericError", "Something went wrong. Please try again.")), variant: "destructive" });
    } finally {
      setRemovingPlayerFromCycle(null);
      setConfirmRemoveCyclePlayer(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">
          {t("scheduleOverview.title", "Schedule Overview")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("scheduleOverview.description", "All your sessions grouped by cycle with payment status.")}
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
          <TabsList>
            <TabsTrigger value="current">
              {t("scheduleOverview.current", "Current")}
            </TabsTrigger>
            <TabsTrigger value="future">
              {t("scheduleOverview.future", "Future")}
            </TabsTrigger>
            <TabsTrigger value="past">
              {t("scheduleOverview.past", "Past")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("scheduleOverview.search", "Search...")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Day / Location / Time filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <SelectFilter
          value={filterDay}
          onValueChange={setFilterDay}
          allLabel={t("scheduleOverview.allDays", "All days")}
          options={[1, 2, 3, 4, 5, 6, 0].map((dayIdx) => {
            const refDate = new Date(2024, 0, dayIdx === 0 ? 7 : dayIdx);
            return {
              value: dayIdx.toString(),
              label: format(refDate, "EEEE", { locale: dateFnsLocale }),
            };
          })}
          triggerClassName="w-[140px] h-9 text-sm"
        />

        <SelectFilter
          value={filterLocation}
          onValueChange={setFilterLocation}
          allLabel={t("scheduleOverview.allLocations", "All locations")}
          options={(trainerLocations ?? []).map((loc) => ({
            value: loc.id,
            label: `${loc.name}, ${loc.city}`,
          }))}
          triggerClassName="w-[180px] h-9 text-sm"
        />

        <SelectFilter
          value={filterTime}
          onValueChange={setFilterTime}
          allLabel={t("scheduleOverview.allTimes", "All times")}
          options={[
            { value: "morning", label: `${t("scheduleOverview.morning", "Morning")} (06-12)` },
            { value: "afternoon", label: `${t("scheduleOverview.afternoon", "Afternoon")} (12-17)` },
            { value: "evening", label: `${t("scheduleOverview.evening", "Evening")} (17-23)` },
          ]}
          triggerClassName="w-[150px] h-9 text-sm"
        />

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 text-sm"
            onClick={() => { setFilterDay("all"); setFilterLocation("all"); setFilterTime("all"); }}
          >
            <X className="h-3.5 w-3.5 mr-1" />
            {t("scheduleOverview.clearFilters", "Clear filters")}
          </Button>
        )}
      </div>

      {filtered.size === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Calendar className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p>{t("scheduleOverview.noResults", "No sessions found.")}</p>
        </div>
      )}

      <div className="space-y-3">
        {Array.from(filtered.entries()).map(([key, group]) => {
          const isOpen = openGroups.has(key);
          const totalSlots = group.slots.length;
          const totalPaid = group.slots.reduce((acc, s) => acc + getPaidCount(s.bookings), 0);
          const totalUnpaid = group.slots.reduce((acc, s) => acc + getUnpaidCount(s.bookings), 0);

          return (
            <div key={key} className="border rounded-lg bg-card">
              {/* Group header */}
              <div className="flex items-center gap-2 w-full p-3 hover:bg-muted/50 transition-colors rounded-t-lg">
                <button
                  onClick={() => toggleGroup(key)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="font-semibold text-sm flex-1 truncate">
                    {key === "__individual__" ? (
                      group.name
                    ) : (
                      <>
                        {t("scheduleOverview.cycle", "Cycle")}: {group.name}
                      </>
                    )}
                  </span>
                </button>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {totalSlots} {t("scheduleOverview.sessions", "sessions")}
                </span>
                {totalPaid > 0 && (
                  <Badge variant="secondary" className="text-[10px] bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    {totalPaid} {t("scheduleOverview.paid", "paid")}
                  </Badge>
                )}
                {totalUnpaid > 0 && (
                  <Badge variant="secondary" className="text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                    {totalUnpaid} {t("scheduleOverview.unpaid", "unpaid")}
                  </Badge>
                )}
                {key !== "__individual__" && (
                  <Button
                    variant="ghost"
                    size="icon" aria-label="Edit"
                    className="h-7 w-7 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditDialog(key, group);
                    }}
                    title={t("scheduleOverview.editCycle", "Edit cycle")}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              {/* Slot rows */}
              {isOpen && (
                <div className="border-t divide-y">
                  {group.slots.map((slot) => {
                    const active = getActiveBookings(slot.bookings);
                    const paid = getPaidCount(slot.bookings);
                    const unpaid = getUnpaidCount(slot.bookings);
                    const slotExpanded = expandedSlots.has(slot.id);
                    const startDate = parseISO(slot.start_time);
                    const endDate = parseISO(slot.end_time);
                    const isPastSlot = isPast(endDate);
                    const location = slot.locations;

                    return (
                      <div key={slot.id} className={isPastSlot ? "opacity-60" : ""}>
                        <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
                          {/* Date & time */}
                          <div className="min-w-[140px] shrink-0">
                            <span className="font-medium">
                              {format(startDate, "EEEEEE d MMM", { locale: dateFnsLocale })}
                            </span>
                            <span className="text-muted-foreground ml-2">
                              {format(startDate, "HH:mm")}-{format(endDate, "HH:mm")}
                            </span>
                          </div>

                          {/* Location */}
                          {location && (
                            <div className="hidden md:flex items-center gap-1 text-muted-foreground text-xs min-w-[100px]">
                              <MapPin className="h-3 w-3" />
                              <span className="truncate">{location.name}</span>
                            </div>
                          )}

                          {/* Players */}
                          <div className="flex items-center gap-1 text-xs">
                            <Users className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>
                              {active.length}
                              {slot.max_participants ? `/${slot.max_participants}` : ""}
                            </span>
                          </div>

                          {/* Payment badges */}
                          <div className="flex items-center gap-1 flex-1">
                            {paid > 0 && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                                {paid} {t("scheduleOverview.paid", "paid")}
                              </Badge>
                            )}
                            {unpaid > 0 && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                {unpaid} {t("scheduleOverview.unpaid", "unpaid")}
                              </Badge>
                            )}
                            {!slot.is_public && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {t("scheduleOverview.private", "Private")}
                              </Badge>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => handleToggleSlotPrivacy(slot.id, !slot.is_public)}
                              disabled={togglingPrivacy === slot.id}
                              title={
                                !slot.is_public ? t("scheduleOverview.markAsPublic", "Mark as public")
                                  : t("scheduleOverview.markAsPrivate", "Mark as private")
                              }
                            >
                              {togglingPrivacy === slot.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : !slot.is_public ? (
                                <Lock className="h-3.5 w-3.5" />
                              ) : (
                                <LockOpen className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon" aria-label="Edit"
                              className="h-7 w-7"
                              onClick={() =>
                                navigate(
                                  `/app/trainer/calendar?date=${format(startDate, "yyyy-MM-dd")}`
                                )
                              }
                              title={t("scheduleOverview.edit", "Edit")}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            {active.length > 0 && (
                              <Button
                                variant="ghost"
                                size="icon" aria-label="Next"
                                className="h-7 w-7"
                                onClick={() => toggleSlot(slot.id)}
                              >
                                {slotExpanded ? (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            )}
                          </div>
                        </div>

                        {/* Expanded player list */}
                        {slotExpanded && active.length > 0 && (
                          <div className="px-6 pb-2 space-y-1">
                            {active.map((b) => {
                              const name =
                                b.profiles?.full_name ||
                                b.guest_players?.full_name ||
                                t("scheduleOverview.unknownPlayer", "Unknown");
                              const isToggling = togglingPayment === b.id;
                              return (
                                <div
                                  key={b.id}
                                  className="flex items-center justify-between text-xs py-1 group"
                                >
                                  <span>{name}</span>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      onClick={() => handleTogglePayment(b.id, b.payment_status)}
                                      disabled={isToggling}
                                      title={
                                        b.payment_status === "paid"
                                          ? t("scheduleOverview.markAsUnpaid", "Mark as unpaid")
                                          : t("scheduleOverview.markAsPaid", "Mark as paid")
                                      }
                                      className="cursor-pointer"
                                    >
                                      <Badge
                                        variant="secondary"
                                        className={
                                          b.payment_status === "paid"
                                            ? "text-[10px] bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
                                            : "text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                                        }
                                      >
                                        {isToggling ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : b.payment_status === "paid" ? (
                                          t("scheduleOverview.paid", "paid")
                                        ) : (
                                          t("scheduleOverview.unpaid", "unpaid")
                                        )}
                                      </Badge>
                                    </button>
                                    <Button
                                      variant="ghost"
                                      size="icon" aria-label="Close"
                                      className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                                      onClick={() => setRemoveBookingId(b.id)}
                                      title={t("scheduleOverview.removePlayer", "Remove player")}
                                    >
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Attendance form for past slots */}
                        {slotExpanded && isPastSlot && (
                          <div className="px-6 pb-3">
                            <TrainerAttendanceForm
                              slotId={slot.id}
                              players={active.map(b => ({
                                id: b.id,
                                name: b.profiles?.full_name || b.guest_players?.full_name || t("scheduleOverview.unknownPlayer", "Unknown"),
                                playerId: b.player_id || b.guest_player_id || undefined,
                              }))}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Load older: the default fetch covers the recent window + all future; this widens the past
          window on demand so deep history stays reachable without loading it up-front. */}
      {tab === "past" && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isFetching}
            onClick={() => setHistoryMonths((m) => m + HISTORY_WINDOW_STEP)}
          >
            {isFetching
              ? t("scheduleOverview.loadingOlder", "Loading…")
              : t("scheduleOverview.loadOlder", "Load older sessions")}
          </Button>
        </div>
      )}

      {/* Edit Cycle Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t("scheduleOverview.editCycleTitle", "Edit Cycle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("scheduleOverview.cycleName", "Name")}</Label>
              <Input
                value={cycleEditData.name}
                onChange={(e) => setCycleEditData((prev) => ({ ...prev, name: e.target.value }))}
                autoFocus
              />
            </div>

            {/* Start date */}
            <div className="space-y-2">
              <Label>{t("scheduleOverview.startDate", "Start date")}</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !cycleEditData.startDate && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {cycleEditData.startDate
                      ? format(cycleEditData.startDate, "PPP", { locale: dateFnsLocale })
                      : t("scheduleOverview.startDate", "Start date")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <CalendarComponent
                    mode="single"
                    selected={cycleEditData.startDate}
                    onSelect={(date) => setCycleEditData((prev) => ({ ...prev, startDate: date || undefined }))}
                    initialFocus
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>

            {/* Time */}
            <div className="space-y-2">
              <Label>{t("scheduleOverview.time", "Time")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="time"
                  value={cycleEditData.startTime}
                  onChange={(e) => setCycleEditData((prev) => ({ ...prev, startTime: e.target.value }))}
                  className="flex-1"
                />
                <span className="text-muted-foreground">—</span>
                <Input
                  type="time"
                  value={cycleEditData.endTime}
                  onChange={(e) => setCycleEditData((prev) => ({ ...prev, endTime: e.target.value }))}
                  className="flex-1"
                />
              </div>
            </div>

            {/* Number of weeks */}
            <div className="space-y-2">
              <Label>{t("scheduleOverview.repeatCount", "Number of weeks")}</Label>
              <Input
                type="number"
                min="1"
                value={cycleEditData.repeatCount}
                onChange={(e) => setCycleEditData((prev) => ({ ...prev, repeatCount: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label>{t("scheduleOverview.pricePerSession", "Price per session")}</Label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-sm text-muted-foreground">€</span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  className="pl-7"
                  value={cycleEditData.pricePerSession}
                  onChange={(e) => setCycleEditData((prev) => ({ ...prev, pricePerSession: e.target.value }))}
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="edit-vat-toggle" className="text-sm">
                {t("scheduleOverview.pricesIncludeVat", "Prices include VAT")}
              </Label>
              <Switch
                id="edit-vat-toggle"
                checked={cycleEditData.pricesIncludeVat}
                onCheckedChange={(checked) => setCycleEditData((prev) => ({ ...prev, pricesIncludeVat: checked }))}
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="edit-split-toggle" className="text-sm">
                {t("scheduleOverview.splitPayment", "Split payment over players")}
              </Label>
              <Switch
                id="edit-split-toggle"
                checked={cycleEditData.splitPayment}
                onCheckedChange={(checked) => setCycleEditData((prev) => ({ ...prev, splitPayment: checked }))}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("scheduleOverview.extraCosts", "Extra costs")}</Label>
                <div className="flex items-center gap-1">
                  <ExtraCostPresetPicker
                    trainerId={trainerProfileId}
                    onSelect={(cost) =>
                      setCycleEditData((prev) => ({
                        ...prev,
                        extraCosts: [...prev.extraCosts, { description: cost.description, price: cost.price, type: cost.type, vat_rate: cost.vat_rate }],
                      }))
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() =>
                      setCycleEditData((prev) => ({
                        ...prev,
                        extraCosts: [...prev.extraCosts, { description: "", price: 0, type: 'per_session' as const }],
                      }))
                    }
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    {t("scheduleOverview.addCost", "Add cost")}
                  </Button>
                </div>
              </div>
              {cycleEditData.extraCosts.map((cost, idx) => (
                <div key={idx} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder={t("scheduleOverview.costDescription", "Description")}
                      value={cost.description}
                      onChange={(e) => {
                        const updated = [...cycleEditData.extraCosts];
                        updated[idx] = { ...updated[idx], description: e.target.value };
                        setCycleEditData((prev) => ({ ...prev, extraCosts: updated }));
                      }}
                      className="flex-1"
                    />
                    <div className="relative w-24">
                      <span className="absolute left-2 top-2.5 text-xs text-muted-foreground">€</span>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        className="pl-6"
                        value={cost.price}
                        onChange={(e) => {
                          const updated = [...cycleEditData.extraCosts];
                          updated[idx] = { ...updated[idx], price: parseFloat(e.target.value) || 0 };
                          setCycleEditData((prev) => ({ ...prev, extraCosts: updated }));
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon" aria-label="Delete"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        const updated = cycleEditData.extraCosts.filter((_, i) => i !== idx);
                        setCycleEditData((prev) => ({ ...prev, extraCosts: updated }));
                      }}
                      title={t("scheduleOverview.removeCost", "Remove")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex gap-2 pl-1 items-center">
                    <div className="relative w-20">
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        className="pr-5 h-7 text-xs"
                        value={cost.vat_rate ?? 21}
                        onChange={(e) => {
                          const updated = [...cycleEditData.extraCosts];
                          updated[idx] = { ...updated[idx], vat_rate: parseFloat(e.target.value) || 0 };
                          setCycleEditData((prev) => ({ ...prev, extraCosts: updated }));
                        }}
                      />
                      <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                    </div>
                    <label className={cn(
                      "flex items-center gap-1 text-xs cursor-pointer px-2 py-0.5 rounded-md border transition-colors",
                      (cost.type || 'per_session') === 'per_session' ? "border-primary bg-primary/5 text-primary" : "border-transparent text-muted-foreground"
                    )}>
                      <input
                        type="radio"
                        name={`overview_cost_type_${idx}`}
                        checked={(cost.type || 'per_session') === 'per_session'}
                        onChange={() => {
                          const updated = [...cycleEditData.extraCosts];
                          updated[idx] = { ...updated[idx], type: 'per_session' };
                          setCycleEditData((prev) => ({ ...prev, extraCosts: updated }));
                        }}
                        className="sr-only"
                      />
                      {t("scheduleOverview.perSession", "Per session")}
                    </label>
                    <label className={cn(
                      "flex items-center gap-1 text-xs cursor-pointer px-2 py-0.5 rounded-md border transition-colors",
                      cost.type === 'one_time' ? "border-primary bg-primary/5 text-primary" : "border-transparent text-muted-foreground"
                    )}>
                      <input
                        type="radio"
                        name={`overview_cost_type_${idx}`}
                        checked={cost.type === 'one_time'}
                        onChange={() => {
                          const updated = [...cycleEditData.extraCosts];
                          updated[idx] = { ...updated[idx], type: 'one_time' };
                          setCycleEditData((prev) => ({ ...prev, extraCosts: updated }));
                        }}
                        className="sr-only"
                      />
                      {t("scheduleOverview.oneTime", "One-time")}
                    </label>
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-2">
              <Label>{t("scheduleOverview.location", "Location")}</Label>
              <Select
                value={cycleEditData.locationId}
                onValueChange={(val) => setCycleEditData((prev) => ({ ...prev, locationId: val }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("scheduleOverview.selectLocation", "Select location")} />
                </SelectTrigger>
                <SelectContent>
                  {trainerLocations?.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id}>
                      {loc.name}, {loc.city}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("scheduleOverview.maxPlayers", "Max players")}</Label>
              <Input
                type="number"
                min="1"
                value={cycleEditData.maxParticipants}
                onChange={(e) => setCycleEditData((prev) => ({ ...prev, maxParticipants: e.target.value }))}
              />
            </div>

            {/* Players section */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("scheduleOverview.players", "Players")}</Label>
              </div>
              {editCyclePlayers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("scheduleOverview.noPlayersInCycle", "No players in this cycle")}
                </p>
              ) : (
                <div className="space-y-1">
                  {editCyclePlayers.map((player) => (
                    <div key={player.id} className="flex items-center justify-between text-sm py-1 group">
                      <div className="flex items-center gap-2 min-w-0">
                        <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate">{player.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {t("scheduleOverview.sessionsLabel", "{{count}} sessions", { count: player.bookingCount })}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon" aria-label="Close"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => setConfirmRemoveCyclePlayer(player)}
                        disabled={removingPlayerFromCycle === player.id}
                        title={t("scheduleOverview.removeFromCycle", "Remove from all sessions")}
                      >
                        {removingPlayerFromCycle === player.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <X className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {/* Add player dropdown */}
              {(() => {
                const enrolledIds = new Set(editCyclePlayers.map(p => p.id));
                const available = availableGuestPlayers.filter(g => !enrolledIds.has(g.id));
                if (available.length === 0) return null;
                return (
                  <Select
                    value=""
                    onValueChange={(val) => handleAddPlayerToCycle(val)}
                    disabled={addingPlayerToCycle}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      {addingPlayerToCycle ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>{t("scheduleOverview.addPlayerToCycle", "Add player")}</span>
                        </div>
                      ) : (
                        <SelectValue placeholder={t("scheduleOverview.addPlayerToCycle", "Add player")} />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {available.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.full_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                );
              })()}
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="cycle-private-toggle">
                {t("scheduleOverview.cyclePrivate", "Private (hidden from players)")}
              </Label>
              <Switch
                id="cycle-private-toggle"
                checked={cycleEditData.isPrivate}
                onCheckedChange={(checked) =>
                  setCycleEditData((prev) => ({ ...prev, isPrivate: checked }))
                }
              />
            </div>
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-sm text-muted-foreground">
                {t("scheduleOverview.bulkWarning", "Changes apply to all {{count}} sessions in this cycle.", { count: editCycleSlotCount })}
              </AlertDescription>
            </Alert>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              {t("scheduleOverview.cancel", "Cancel")}
            </Button>
            <Button onClick={handleSaveCycleEdit} disabled={savingEdit || !cycleEditData.name.trim()}>
              {savingEdit && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {t("scheduleOverview.save", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Player Confirm. The old AlertDialog auto-closed on click and ran the
          cancel detached; ConfirmDialog stays open while `removingBooking` and closes on
          settle. handleRemovePlayer clears removeBookingId on success itself; the finally
          also clears it so the error path (which returns early) closes too.
          variant="default" preserves the original non-destructive confirm button. */}
      <ConfirmDialog
        open={!!removeBookingId}
        onOpenChange={(open) => !open && setRemoveBookingId(null)}
        title={t("scheduleOverview.removePlayer", "Remove player")}
        description={t("scheduleOverview.removePlayerConfirm", "Are you sure you want to remove this player from the session?")}
        confirmLabel={t("scheduleOverview.removePlayer", "Remove player")}
        cancelLabel={t("scheduleOverview.cancel", "Cancel")}
        loading={removingBooking}
        variant="default"
        onConfirm={async () => {
          try {
            await handleRemovePlayer();
          } finally {
            setRemoveBookingId(null);
          }
        }}
      />

      {/* Remove Player from Cycle Confirm. handleRemovePlayerFromCycle's own finally
          clears both removingPlayerFromCycle (shared with the row X-button spinner —
          keep it shared) and confirmRemoveCyclePlayer, so the handler owns close.
          variant="default" preserves the original non-destructive confirm button. */}
      <ConfirmDialog
        open={!!confirmRemoveCyclePlayer}
        onOpenChange={(open) => !open && setConfirmRemoveCyclePlayer(null)}
        title={t("scheduleOverview.removeFromCycle", "Remove from all sessions")}
        description={t("scheduleOverview.removeFromCycleConfirm", "Remove {{name}} from all sessions in this cycle?", { name: confirmRemoveCyclePlayer?.name })}
        confirmLabel={t("scheduleOverview.removeFromCycle", "Remove from all sessions")}
        cancelLabel={t("scheduleOverview.cancel", "Cancel")}
        loading={!!removingPlayerFromCycle}
        variant="default"
        onConfirm={handleRemovePlayerFromCycle}
      />
    </div>
  );
}
