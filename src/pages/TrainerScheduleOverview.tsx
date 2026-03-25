import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Locale } from "date-fns";
import { useNavigate } from "react-router-dom";
import { format, isPast, isFuture, parseISO, differenceInCalendarDays, addDays } from "date-fns";
import { nl, enUS, de, fr, es } from "date-fns/locale";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/hooks/useAuth";
import { getTrainerProfile } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { syncInvoicesAfterBookingRemoval } from "@/lib/invoiceSync";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { useToast } from "@/hooks/use-toast";
import { ExtraCostPresetPicker } from "@/components/settings/ExtraCostPresetPicker";

const localeMap: Record<string, Locale> = { nl, en: enUS, de, fr, es };

type ExtraCost = { description: string; price: number; type?: 'per_session' | 'one_time'; vat_rate?: number };

type SlotWithBookings = {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  max_participants: number | null;
  is_public: boolean;
  is_marked_full: boolean;
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

  const { data: slots, isLoading } = useQuery({
    queryKey: ["trainer-schedule-overview", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const tp = await getTrainerProfile(user.id);
      if (!tp) return [];

      const { data, error } = await supabase
        .from("availability_slots")
        .select(`
          id, start_time, end_time, cyclus_id, cyclus_name, max_participants, is_public, is_marked_full, location_id, price_per_session, prices_include_vat, extra_costs, split_payment,
          locations:location_id (name, city),
          bookings (id, status, payment_status, player_id, guest_player_id,
            profiles:player_id (full_name),
            guest_players:guest_player_id (full_name)
          )
        `)
        .eq("trainer_id", tp.id)
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
      isPrivate: firstSlot?.is_marked_full ?? false,
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
        const { data: guests } = await supabase
          .from("guest_players")
          .select("id, full_name")
          .eq("trainer_id", tp.id)
          .order("full_name");
        setAvailableGuestPlayers(guests || []);
      }
    }

    setEditDialogOpen(true);
  };

  const handleSaveCycleEdit = async () => {
    if (!editCycleId || !cycleEditData.name.trim()) return;
    setSavingEdit(true);

    try {
      // 1. Build bulk updates for all existing slots
      const updates: Record<string, unknown> = {
        cyclus_name: cycleEditData.name.trim(),
        is_marked_full: cycleEditData.isPrivate,
        extra_costs: cycleEditData.extraCosts.length > 0 ? cycleEditData.extraCosts : null,
        prices_include_vat: cycleEditData.pricesIncludeVat,
        split_payment: cycleEditData.splitPayment,
      };
      if (cycleEditData.pricePerSession !== "") {
        updates.price_per_session = parseFloat(cycleEditData.pricePerSession);
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

            await supabase
              .from("availability_slots")
              .update({ ...updates, start_time: newStart.toISOString(), end_time: newEnd.toISOString() })
              .eq("id", cs.id);
          }
        }
      } else {
        // No date/time shift — just bulk update
        await supabase
          .from("availability_slots")
          .update(updates)
          .eq("cyclus_id", editCycleId);
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
                is_public: lastSlot.is_public,
                is_marked_full: cycleEditData.isPrivate,
                location_id: cycleEditData.locationId || lastSlot.location_id,
                price_per_session: cycleEditData.pricePerSession !== "" ? parseFloat(cycleEditData.pricePerSession) : lastSlot.price_per_session,
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
            const { data: insertedSlots } = await supabase.from("availability_slots").insert(newSlots).select("id, start_time");

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
                  const { data: createdBookings } = await supabase.from("bookings").insert(newBookings).select("id, player_id, guest_player_id");

                  // Add new booking IDs to unpaid invoices so section 3b recalculates them
                  if (createdBookings && createdBookings.length > 0) {
                    // Get all existing booking IDs for this cycle to find invoices
                    const { data: allCycleBookings } = await supabase
                      .from("bookings")
                      .select("id")
                      .in("slot_id", existingSlotIds)
                      .in("status", ["confirmed", "attended", "pending"]);

                    const allExistingBookingIds = (allCycleBookings || []).map((b) => b.id);

                    const { data: affectedInvoices } = await supabase
                      .from("invoices")
                      .select("id, booking_ids")
                      .in("status", ["draft", "sent", "pending"])
                      .overlaps("booking_ids", allExistingBookingIds);

                    if (affectedInvoices) {
                      for (const inv of affectedInvoices) {
                        const currentIds = (inv.booking_ids as string[]) || [];
                        // Find which players this invoice covers
                        const invExistingBookings = existingBookings.filter((eb) => {
                          const ebId = allCycleBookings?.find((ab) =>
                            existingBookings.some((x) => (x.player_id === eb.player_id && x.guest_player_id === eb.guest_player_id))
                          )?.id;
                          return ebId && currentIds.includes(ebId);
                        });
                        // Get new bookings for those same players
                        const playerKeys = new Set(invExistingBookings.map((b) => b.player_id || b.guest_player_id));
                        const relevantNewIds = createdBookings
                          .filter((nb) => playerKeys.has(nb.player_id || nb.guest_player_id))
                          .map((nb) => nb.id);

                        if (relevantNewIds.length > 0) {
                          await supabase
                            .from("invoices")
                            .update({ booking_ids: [...currentIds, ...relevantNewIds], pdf_url: null })
                            .eq("id", inv.id);
                        }
                      }
                    }
                  }
                }
              }
            }
          } else if (newCount < cycleSlots.length) {
            // Remove trailing slots without active bookings
            const slotsToRemove = cycleSlots.length - newCount;
            const trailingSlots = cycleSlots.slice(-slotsToRemove);
            // Check for active bookings
            const { data: bookingsCheck } = await supabase
              .from("bookings")
              .select("slot_id")
              .in("slot_id", trailingSlots.map((s) => s.id))
              .neq("status", "cancelled");

            const bookedSlotIds = new Set((bookingsCheck || []).map((b) => b.slot_id));
            const deletableSlots = trailingSlots.filter((s) => !bookedSlotIds.has(s.id));
            const blockedCount = trailingSlots.length - deletableSlots.length;

            if (blockedCount > 0) {
              toast({
                title: t("scheduleOverview.cannotRemoveBookedSlots", "Cannot remove {{count}} session(s) with active bookings", { count: blockedCount }),
                variant: "destructive",
              });
            }

            if (deletableSlots.length > 0) {
              await supabase
                .from("availability_slots")
                .delete()
                .in("id", deletableSlots.map((s) => s.id));
            }
          }
        }
      }

      // 3b. Sync extra costs to existing unpaid invoices
      {
        const { data: syncSlotIds } = await supabase
          .from("availability_slots")
          .select("id")
          .eq("cyclus_id", editCycleId);

        if (syncSlotIds && syncSlotIds.length > 0) {
          const syncSlotIdList = syncSlotIds.map((s) => s.id);
          const { data: syncBookings } = await supabase
            .from("bookings")
            .select("id")
            .in("slot_id", syncSlotIdList)
            .in("status", ["confirmed", "attended"]);

          if (syncBookings && syncBookings.length > 0) {
            const syncBookingIdList = syncBookings.map((b) => b.id);

            const { data: allInvoices } = await supabase
              .from("invoices")
              .select("id, booking_ids, line_items, vat_rate, status")
              .neq("status", "paid");

            if (allInvoices && allInvoices.length > 0) {
              const matchingUnpaidInvoices = allInvoices.filter((inv) => {
                const ids = (inv.booking_ids as string[]) || [];
                return ids.some((bid) => syncBookingIdList.includes(bid));
              });

              for (const inv of matchingUnpaidInvoices) {
                const existingItems = (inv.line_items as any[]) || [];
                // Keep only session line items (first item / items without extra cost markers)
                // Session items typically have quantity > 1 or are the first item
                const sessionItems = existingItems.filter(
                  (_item: any, idx: number) => idx === 0
                );

                // Build extra cost line items from current cycle settings
                const extraCostItems = cycleEditData.extraCosts.map((ec: any) => {
                  const isPerSession = ec.type === "per_session";
                  const bookingCount = (inv.booking_ids as string[])?.length || 1;
                  return {
                    description: `${ec.description}${isPerSession ? " (per sessie)" : ""}`,
                    quantity: isPerSession ? bookingCount : 1,
                    unit_price: ec.price,
                    amount: ec.price * (isPerSession ? bookingCount : 1),
                    vat_rate: ec.vat_rate ?? inv.vat_rate ?? 21,
                  };
                });

                const updatedItems = [...sessionItems, ...extraCostItems];

                // Recalculate totals
                const vatRate = inv.vat_rate || 21;
                const pricesIncVat = cycleEditData.pricesIncludeVat;

                // Check for multi-rate VAT
                const rates = updatedItems.map((it: any) => it.vat_rate ?? vatRate);
                const hasMultiRate = new Set(rates).size > 1;

                let subtotal = 0;
                let vatAmount = 0;
                let total = 0;
                let vatBreakdown: Record<number, { subtotal: number; vat: number }> = {};

                for (const item of updatedItems) {
                  const lineTotal = item.quantity * item.unit_price;
                  const lineVatRate = item.vat_rate ?? vatRate;

                  let lineSub: number;
                  let lineVat: number;
                  if (pricesIncVat) {
                    lineSub = lineTotal / (1 + lineVatRate / 100);
                    lineVat = lineTotal - lineSub;
                  } else {
                    lineSub = lineTotal;
                    lineVat = lineTotal * (lineVatRate / 100);
                  }

                  subtotal += lineSub;
                  vatAmount += lineVat;
                  total += pricesIncVat ? lineTotal : lineTotal + lineVat;

                  if (hasMultiRate) {
                    if (!vatBreakdown[lineVatRate]) {
                      vatBreakdown[lineVatRate] = { subtotal: 0, vat: 0 };
                    }
                    vatBreakdown[lineVatRate].subtotal += lineSub;
                    vatBreakdown[lineVatRate].vat += lineVat;
                  }
                }

                // Round breakdown values
                for (const rate in vatBreakdown) {
                  vatBreakdown[rate].subtotal = Math.round(vatBreakdown[rate].subtotal * 100) / 100;
                  vatBreakdown[rate].vat = Math.round(vatBreakdown[rate].vat * 100) / 100;
                }

                await supabase
                  .from("invoices")
                  .update({
                    line_items: updatedItems,
                    subtotal: Math.round(subtotal * 100) / 100,
                    vat_amount: Math.round(vatAmount * 100) / 100,
                    total: Math.round(total * 100) / 100,
                    ...(Object.keys(vatBreakdown).length > 0 ? { vat_breakdown: vatBreakdown } : {}),
                    pdf_url: null,
                  })
                  .eq("id", inv.id);
              }
            }
          }
        }
      }

      // 4. If splitPayment toggled ON (from off), update cycle settings and split existing invoices
      if (cycleEditData.splitPayment && !cycleEditData.originalSplitPayment) {
        // Update cycles table settings
        const { data: cycleRow } = await supabase
          .from("cycles")
          .select("settings")
          .eq("id", editCycleId)
          .maybeSingle();

        if (cycleRow) {
          const settings: Record<string, unknown> = ((cycleRow.settings as Record<string, unknown>) || {});
          settings.split_payment = true;
          await supabase.from("cycles").update({ settings: settings as any }).eq("id", editCycleId);
        }

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
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSavingEdit(false);
    }
  };

  // Toggle payment
  const handleTogglePayment = async (bookingId: string, currentStatus: string) => {
    setTogglingPayment(bookingId);
    const newStatus = currentStatus === "paid" ? "pending" : "paid";
    const updates: Record<string, unknown> = {
      payment_status: newStatus,
      paid_at: newStatus === "paid" ? new Date().toISOString() : null,
      paid_externally: newStatus === "paid" ? true : false,
    };
    const { error } = await supabase.from("bookings").update(updates).eq("id", bookingId);
    setTogglingPayment(null);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: t("scheduleOverview.paymentUpdated", "Payment status updated") });
      invalidate();
    }
  };

  // Remove player
  const handleRemovePlayer = async () => {
    if (!removeBookingId) return;
    setRemovingBooking(true);
    const { error } = await supabase
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("id", removeBookingId);
    if (error) {
      setRemovingBooking(false);
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }
    // Sync affected invoices
    try {
      await syncInvoicesAfterBookingRemoval([removeBookingId]);
    } catch (err) {
      logger.error("Invoice sync failed after player removal", err instanceof Error ? err : new Error(String(err)), { component: 'TrainerScheduleOverview' });
    }
    setRemovingBooking(false);
    toast({ title: t("scheduleOverview.playerRemoved", "Player removed from session") });
    setRemoveBookingId(null);
    invalidate();
  };

  // Toggle slot privacy
  const handleToggleSlotPrivacy = async (slotId: string, currentValue: boolean) => {
    setTogglingPrivacy(slotId);
    const { error } = await supabase
      .from("availability_slots")
      .update({ is_marked_full: !currentValue })
      .eq("id", slotId);
    setTogglingPrivacy(null);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
        await supabase.from("bookings").insert(newBookings);

        // Mark player as has_trained
        await supabase.from("guest_players").update({ has_trained: true }).eq("id", guestPlayerId);
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

      toast({ title: t("scheduleOverview.addedToCycle", "Player added to all sessions") });
      invalidate();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
          await supabase
            .from("bookings")
            .update({ status: 'cancelled' })
            .in("id", cancelledIds);

          // Sync affected invoices
          try {
            await syncInvoicesAfterBookingRemoval(cancelledIds);
          } catch (err) {
            logger.error("Invoice sync failed after cycle player removal", err instanceof Error ? err : new Error(String(err)), { component: 'TrainerScheduleOverview' });
          }
        }
      }

      setEditCyclePlayers(prev => prev.filter(p => p.id !== player.id));
      toast({ title: t("scheduleOverview.removedFromCycle", "Player removed from all sessions") });
      invalidate();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
        <Select value={filterDay} onValueChange={setFilterDay}>
          <SelectTrigger className="w-[140px] h-9 text-sm">
            <SelectValue placeholder={t("scheduleOverview.allDays", "All days")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("scheduleOverview.allDays", "All days")}</SelectItem>
            {[1, 2, 3, 4, 5, 6, 0].map((dayIdx) => {
              const refDate = new Date(2024, 0, dayIdx === 0 ? 7 : dayIdx);
              return (
                <SelectItem key={dayIdx} value={dayIdx.toString()}>
                  {format(refDate, "EEEE", { locale: dateFnsLocale })}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        <Select value={filterLocation} onValueChange={setFilterLocation}>
          <SelectTrigger className="w-[180px] h-9 text-sm">
            <SelectValue placeholder={t("scheduleOverview.allLocations", "All locations")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("scheduleOverview.allLocations", "All locations")}</SelectItem>
            {trainerLocations?.map((loc) => (
              <SelectItem key={loc.id} value={loc.id}>
                {loc.name}, {loc.city}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterTime} onValueChange={setFilterTime}>
          <SelectTrigger className="w-[150px] h-9 text-sm">
            <SelectValue placeholder={t("scheduleOverview.allTimes", "All times")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("scheduleOverview.allTimes", "All times")}</SelectItem>
            <SelectItem value="morning">{t("scheduleOverview.morning", "Morning")} (06-12)</SelectItem>
            <SelectItem value="afternoon">{t("scheduleOverview.afternoon", "Afternoon")} (12-17)</SelectItem>
            <SelectItem value="evening">{t("scheduleOverview.evening", "Evening")} (17-23)</SelectItem>
          </SelectContent>
        </Select>

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
                    size="icon"
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
                            {slot.is_marked_full && (
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
                              onClick={() => handleToggleSlotPrivacy(slot.id, slot.is_marked_full)}
                              disabled={togglingPrivacy === slot.id}
                              title={
                                slot.is_marked_full
                                  ? t("scheduleOverview.markAsPublic", "Mark as public")
                                  : t("scheduleOverview.markAsPrivate", "Mark as private")
                              }
                            >
                              {togglingPrivacy === slot.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : slot.is_marked_full ? (
                                <Lock className="h-3.5 w-3.5" />
                              ) : (
                                <LockOpen className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
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
                                size="icon"
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
                                      size="icon"
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
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

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
                      size="icon"
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
                        size="icon"
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

      {/* Remove Player Confirm */}
      <AlertDialog open={!!removeBookingId} onOpenChange={(open) => !open && setRemoveBookingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("scheduleOverview.removePlayer", "Remove player")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("scheduleOverview.removePlayerConfirm", "Are you sure you want to remove this player from the session?")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removingBooking}>
              {t("scheduleOverview.cancel", "Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleRemovePlayer} disabled={removingBooking}>
              {removingBooking && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {t("scheduleOverview.removePlayer", "Remove player")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove Player from Cycle Confirm */}
      <AlertDialog open={!!confirmRemoveCyclePlayer} onOpenChange={(open) => !open && setConfirmRemoveCyclePlayer(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("scheduleOverview.removeFromCycle", "Remove from all sessions")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("scheduleOverview.removeFromCycleConfirm", "Remove {{name}} from all sessions in this cycle?", { name: confirmRemoveCyclePlayer?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!removingPlayerFromCycle}>
              {t("scheduleOverview.cancel", "Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleRemovePlayerFromCycle} disabled={!!removingPlayerFromCycle}>
              {removingPlayerFromCycle && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {t("scheduleOverview.removeFromCycle", "Remove from all sessions")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
