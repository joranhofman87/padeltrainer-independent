// Extracted verbatim from AddSlotDialog.tsx (god-component decomposition, behavior-frozen).
// The multi-week cyclus bulk-create feature: self-contained state, communicates only via props.
// AddSlotDialog re-exports BulkCreateContent so the three by-name importers stay unchanged.
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { format, addMinutes, setHours, setMinutes, startOfDay, addWeeks, getDay } from "date-fns";
import { CalendarIcon, Plus, Repeat, Lock, GraduationCap, User, Euro, Users, Trash2 } from "lucide-react";
import { calculateSlotPrice, formatPrice } from "@/lib/pricing";
import { logger } from "@/lib/logger";
import { createCycle, type CycleSettings, type ExtraCost } from "@/lib/cycles";
import { expandWeeklySessions, insertAvailabilitySlots } from "@/lib/slots";
import { epochRange, fetchTrainerSlotRanges, isTrainerSlotOverlapError, rangesOverlap } from "@/lib/slotConflicts";
import { insertBookings } from "@/lib/bookings";
import { formatDate } from "@/lib/format";
import { ExtraCostPresetPicker } from "@/components/settings/ExtraCostPresetPicker";
import type { Json } from "@/integrations/supabase/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TimeSelect } from "@/components/ui/time-select";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { getFriendlyErrorMessage } from "@/lib/friendlyError";
import { AddPlayerDialog, GuestPlayer } from "@/components/players/AddPlayerDialog";
import { GuestPlayerSlotCombobox } from "@/components/players/GuestPlayerSlotCombobox";
import { SlotLocationPicker, type SlotLocation } from "@/components/slots/SlotLocationPicker";
import { SlotRatingPicker } from "@/components/slots/SlotRatingPicker";
import { getTrainerAcademy, type AcademyProfile } from "@/lib/academy";
import { expectsBulkGuestBookings, getBulkGenerateBookingOutcome, getBulkGenerateValidationError, resolveAcademyDefaultBulkTrainerId, shouldInitializeAcademyDefaultBulkSlot } from "@/lib/academyCreateSlot";
import { logSupabaseError } from "@/lib/trainerOnboardingLegacy";
import { getBulkCreateVatSettingsPath, priceDisplayModeToIncludesVat, shouldUseTrainerPricesIncludeVat } from "@/lib/academyPriceDisplay";
import { buildBulkCycleBookings } from "@/lib/bulkCycleBookings";
import { splitAmongPlayersForInvoiceCreate } from "@/lib/invoiceSplitPricing";
import { resolveSplitDivisor } from "@/lib/splitDivisor";
import { getSelectedGuestPlayerIds, groupChargeableBookingsByGuest, normalizePayerId, shouldShowPayerSelector } from "@/lib/cyclePayerSelection";
import { notifyFollowers } from "@/lib/notifyFollowers";
import { buildDefaultBulkSlotOwnership, shouldInvokeNotifyFollowersOnBulkGenerate, shouldShowBulkBookingPartialFailureToast, shouldShowBulkPlayersAddedToast } from "@/lib/bulkCreateSlot";
import { useTrainerRatingSystem } from "@/hooks/useTrainerRatingSystem";
import { invalidateAllPlayerData } from "@/lib/playerQueryKeys";
import { fetchBookableGuestPlayers } from '@/lib/playersOverview';


interface BulkSlotConfig {
  startDate: Date;
  startTime: string;
  durationMinutes: number;
  recurrenceWeeks: number;
  cyclusName: string;
  addPlayers: boolean;
  selectedPlayers: string[];
  courtType: 'indoor' | 'outdoor' | null;
  locationId: string | null;
  isMarkedFull: boolean;
  academyProfileId: string | null;
  trainerId: string | null;
  ratingSystem: string | null;
  minRating: number | null;
  maxRating: number | null;
  pricePerSession: number | null;
  totalPrice: number | null;
  allowSingleBooking: boolean;
  wholeSlotBooking?: boolean;
  minParticipants: number | null;
  maxParticipants: number | null;
  priceManuallyEdited: boolean;
  markAsPaid: boolean;
  extraCosts: ExtraCost[];
  hasExtraCosts: boolean;
  splitPayment: boolean;
  /** Guest player invoiced for full price when split payment is off. */
  payerGuestPlayerId: string | null;
}

interface TrainerOption {
  id: string;
  name: string;
}

export interface BulkCreateContentProps {
  trainerId: string | null;
  defaultDate?: Date;
  defaultTime?: string;
  defaultDuration: number;
  defaultWeeks: number;
  onSlotsCreated: () => void;
  availableLocations?: SlotLocation[];
  availableTrainers?: TrainerOption[];
  prefillFromCyclusId?: string | null;
  academyId?: string;
  /** When used inside a Sheet, pass this to allow closing on success */
  onClose?: () => void;
}

export function BulkCreateContent({
  trainerId,
  defaultDate,
  defaultTime,
  defaultDuration,
  defaultWeeks,
  onSlotsCreated,
  availableLocations,
  availableTrainers,
  prefillFromCyclusId,
  academyId,
  onClose,
  isActive = true,
}: BulkCreateContentProps & { isActive?: boolean }) {
  const { t } = useTranslation("trainer");
  const { t: tAcademy } = useTranslation("academy");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { trainerRatingSystem } = useTrainerRatingSystem(trainerId || undefined);

  const [bulkSlots, setBulkSlots] = useState<BulkSlotConfig[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [players, setPlayers] = useState<GuestPlayer[]>([]);
  const [addPlayerDialogOpen, setAddPlayerDialogOpen] = useState(false);
  const [addPlayerContext, setAddPlayerContext] = useState<{ slotIndex: number; playerIndex: number } | null>(null);
  const [trainerAcademy, setTrainerAcademy] = useState<Partial<AcademyProfile> | null>(null);
  const [trainerHourlyRates, setTrainerHourlyRates] = useState<Map<string, number>>(new Map());
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);

  useEffect(() => {
    if (isActive && (academyId || trainerId)) {
      fetchPlayers();
    }
    if (isActive && trainerId) {
      fetchAcademy();
      fetchTrainerHourlyRate(trainerId);
    }
    if (isActive && availableTrainers) {
      fetchAllTrainerRates();
    }
  }, [isActive, trainerId, academyId]);

  useEffect(() => {
    if (!isActive || !academyId) return;

    const loadAcademyPriceDisplay = async () => {
      const { data } = await supabase
        .from("academy_profiles")
        .select("price_display_mode")
        .eq("id", academyId)
        .maybeSingle();
      setPricesIncludeVat(priceDisplayModeToIncludesVat(data?.price_display_mode));
    };

    loadAcademyPriceDisplay();
  }, [isActive, academyId]);

  const fetchAcademy = async () => {
    if (!trainerId) return;
    const academy = await getTrainerAcademy(trainerId);
    setTrainerAcademy(academy);
  };

  const fetchTrainerHourlyRate = async (tId: string) => {
    const { data } = await supabase
      .from("trainer_profiles")
      .select("id, hourly_rate, prices_include_vat")
      .eq("id", tId)
      .maybeSingle();
    if (data?.hourly_rate) {
      setTrainerHourlyRates(prev => new Map(prev).set(tId, data.hourly_rate));
    }
    if (
      shouldUseTrainerPricesIncludeVat(academyId) &&
      data?.prices_include_vat !== undefined &&
      data.prices_include_vat !== null
    ) {
      setPricesIncludeVat(data.prices_include_vat);
    }
  };

  const fetchAllTrainerRates = async () => {
    if (!availableTrainers || availableTrainers.length === 0) return;
    const ids = availableTrainers.map(t => t.id);
    const { data } = await supabase
      .from("trainer_profiles")
      .select("id, hourly_rate")
      .in("id", ids);
    if (data) {
      const map = new Map<string, number>();
      data.forEach(d => { if (d.hourly_rate) map.set(d.id, d.hourly_rate); });
      setTrainerHourlyRates(map);
    }
  };

  const getHourlyRate = (tId: string | null): number | null => {
    if (!tId) return null;
    return trainerHourlyRates.get(tId) ?? null;
  };

  const autoCalcPricing = (tId: string | null, durationMinutes: number, recurrenceWeeks: number, extraCosts: ExtraCost[] = []) => {
    const rate = getHourlyRate(tId);
    if (!rate) return { pricePerSession: null, totalPrice: null };
    const pricePerSession = calculateSlotPrice(rate, durationMinutes);
    const perSessionExtra = extraCosts.filter(c => (c.type || 'per_session') === 'per_session').reduce((sum, c) => sum + (c.price || 0), 0);
    const oneTimeExtra = extraCosts.filter(c => c.type === 'one_time').reduce((sum, c) => sum + (c.price || 0), 0);
    const totalPrice = (pricePerSession + perSessionExtra) * recurrenceWeeks + oneTimeExtra;
    return { pricePerSession: Math.round(pricePerSession * 100) / 100, totalPrice: Math.round(totalPrice * 100) / 100 };
  };

  const fetchPlayers = async () => {
    try {
      if (!academyId && !trainerId) {
        setPlayers([]);
        return;
      }

      const data = await fetchBookableGuestPlayers(
        academyId
          ? { kind: 'academy', id: academyId }
          : { kind: 'trainer', id: trainerId! },
      ).catch((error: Error) => {
        setPlayers([]);
        return error;
      });
      if (data instanceof Error) {
        const error = data;
        toast({
          title: t("calendar.guestPlayersLoadError", "Could not load players"),
          description: getFriendlyErrorMessage(error, t("calendar.guestPlayersLoadErrorDescription", "Please try again.")),
          variant: "destructive",
        });
        setPlayers([]);
        return;
      }
      setPlayers((data as GuestPlayer[]) || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        "Unexpected error loading guest players",
        err instanceof Error ? err : new Error(message),
        { component: "BulkCreateContent", academyId, trainerId },
      );
      toast({
        title: t("calendar.guestPlayersLoadError", "Could not load players"),
        description: getFriendlyErrorMessage(err, t("calendar.guestPlayersLoadErrorDescription", "Please try again.")),
        variant: "destructive",
      });
      setPlayers([]);
    }
  };

  const getInitialStartDate = () => {
    if (defaultDate) {
      return startOfDay(defaultDate);
    }
    const today = new Date();
    const dayOfWeek = getDay(today);
    const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
    return startOfDay(addMinutes(today, daysUntilMonday * 24 * 60));
  };

  const getInitialStartTime = () => {
    return defaultTime || "09:00";
  };

  const generateCyclusName = (startDate: Date, startTime: string) => {
    const dayName = format(startDate, "EEEE"); // No locale — always English for DB storage
    return `Cyclus ${dayName} ${startTime}`;
  };

  const createDefaultSlotConfig = (startDate: Date, startTime: string, duration: number, weeks: number, tId: string | null, aId?: string | null): BulkSlotConfig => {
    const pricing = autoCalcPricing(tId, duration, weeks);
    const { academyProfileId, trainerId: slotTrainerId } = buildDefaultBulkSlotOwnership(tId, aId);
    return {
      startDate,
      startTime,
      durationMinutes: duration,
      recurrenceWeeks: weeks,
      cyclusName: generateCyclusName(startDate, startTime),
     addPlayers: true,
      selectedPlayers: [],
      courtType: null,
      locationId: null,
      isMarkedFull: false,
      academyProfileId,
      trainerId: slotTrainerId,
      ratingSystem: null,
      minRating: null,
      maxRating: null,
      pricePerSession: pricing.pricePerSession,
      totalPrice: pricing.totalPrice,
      allowSingleBooking: false,
      minParticipants: null,
      maxParticipants: null,
      priceManuallyEdited: false,
      markAsPaid: false,
      extraCosts: [],
      hasExtraCosts: false,
      splitPayment: false,
      payerGuestPlayerId: null,
    };
  };

  // Seed first recurring slot config when opened (academy page/calendar) or when date/time query params exist (trainer calendar).
  useEffect(() => {
    if (!isActive || prefillFromCyclusId) {
      return;
    }

    const initFromDate = Boolean(defaultDate);
    const initForAcademy = shouldInitializeAcademyDefaultBulkSlot({
      academyId,
      activeTrainerCount: availableTrainers?.length ?? 0,
      prefillFromCyclusId,
      existingBulkSlotCount: 0,
    });

    if (!initFromDate && !initForAcademy) {
      return;
    }

    const newStartDate = getInitialStartDate();
    const newStartTime = getInitialStartTime();
    const effectiveTrainerId = academyId
      ? resolveAcademyDefaultBulkTrainerId(trainerId, availableTrainers)
      : trainerId;

    setBulkSlots((prev) => {
      if (prev.length > 0) {
        return prev;
      }
      return [
        createDefaultSlotConfig(
          newStartDate,
          newStartTime,
          defaultDuration,
          defaultWeeks,
          effectiveTrainerId,
          academyId,
        ),
      ];
    });
  }, [
    isActive,
    defaultDate,
    defaultTime,
    academyId,
    availableTrainers,
    trainerId,
    prefillFromCyclusId,
    defaultDuration,
    defaultWeeks,
  ]);

  // Prefill from existing cyclus (duplicate mode)
  useEffect(() => {
    if (!isActive || !prefillFromCyclusId) return;

    const prefillFromCyclus = async () => {
      try {
        // Fetch all slots from the source cyclus
        const { data: sourceSlots, error } = await supabase
          .from("availability_slots")
          .select(`
            *,
            bookings(id, guest_player_id, player_id)
          `)
          .eq("cyclus_id", prefillFromCyclusId)
          .order("start_time", { ascending: true });

        if (error || !sourceSlots?.length) {
          logger.error("Error fetching cyclus for prefill", error instanceof Error ? error : new Error(String(error || "No slots")), { component: 'BulkCreateSheet' });
          // Fall back to default
          const newStartDate = getInitialStartDate();
          const newStartTime = getInitialStartTime();
          setBulkSlots([createDefaultSlotConfig(newStartDate, newStartTime, defaultDuration, defaultWeeks, trainerId, academyId)]);
          return;
        }

        const firstSlot = sourceSlots[0];
        const firstSlotDate = new Date(firstSlot.start_time);
        const lastSlotDate = new Date(sourceSlots[sourceSlots.length - 1].start_time);

        // Calculate duration from first slot
        const durationMs = new Date(firstSlot.end_time).getTime() - firstSlotDate.getTime();
        const durationMinutes = Math.round(durationMs / 60000);

        // New start date: one week after last slot
        const newStartDate = addWeeks(lastSlotDate, 1);
        const startTime = format(firstSlotDate, "HH:mm");

        // Collect unique guest player IDs from bookings
        const playerIds = new Set<string>();
        sourceSlots.forEach(slot => {
          slot.bookings?.forEach((b: any) => {
            if (b.guest_player_id) playerIds.add(b.guest_player_id);
          });
        });

        // Parse extra costs
        const extraCosts: ExtraCost[] = firstSlot.extra_costs 
          ? (Array.isArray(firstSlot.extra_costs) ? firstSlot.extra_costs as unknown as ExtraCost[] : [])
          : [];

        const prefilled: BulkSlotConfig = {
          startDate: startOfDay(newStartDate),
          startTime,
          durationMinutes,
          recurrenceWeeks: sourceSlots.length,
          cyclusName: generateCyclusName(newStartDate, startTime),
          addPlayers: playerIds.size > 0,
          selectedPlayers: Array.from(playerIds),
          courtType: firstSlot.court_type as 'indoor' | 'outdoor' | null,
          locationId: firstSlot.location_id,
          isMarkedFull: false,
          academyProfileId: firstSlot.academy_profile_id,
          trainerId: firstSlot.trainer_id || trainerId,
          ratingSystem: firstSlot.rating_system,
          minRating: firstSlot.min_rating,
          maxRating: firstSlot.max_rating,
          pricePerSession: firstSlot.price_per_session,
          totalPrice: firstSlot.total_price,
          allowSingleBooking: firstSlot.allow_single_booking ?? false,
          wholeSlotBooking: (firstSlot as { whole_slot_booking?: boolean | null }).whole_slot_booking ?? false,
          minParticipants: firstSlot.min_participants,
          maxParticipants: firstSlot.max_participants,
          priceManuallyEdited: true, // Keep the original pricing
          markAsPaid: false,
          extraCosts,
          hasExtraCosts: extraCosts.length > 0,
          splitPayment: firstSlot.split_payment ?? false,
          payerGuestPlayerId: normalizePayerId(Array.from(playerIds), null),
        };

        setBulkSlots([prefilled]);
      } catch (err) {
        logger.error("Error prefilling from cyclus", err instanceof Error ? err : new Error(String(err)), { component: 'BulkCreateSheet' });
      }
    };

    prefillFromCyclus();
  }, [isActive, prefillFromCyclusId]);


  const addBulkSlotConfig = () => {
    if (bulkSlots.length > 0) {
      const lastSlot = bulkSlots[bulkSlots.length - 1];
      
      const lastTimeMinutes = parseInt(lastSlot.startTime.split(':')[0]) * 60 
                            + parseInt(lastSlot.startTime.split(':')[1]);
      const nextTimeMinutes = lastTimeMinutes + lastSlot.durationMinutes;
      const nextHours = Math.floor(nextTimeMinutes / 60);
      const nextMins = nextTimeMinutes % 60;
      const newStartTime = nextHours < 24 
        ? `${nextHours.toString().padStart(2, '0')}:${nextMins.toString().padStart(2, '0')}`
        : lastSlot.startTime;
      
      const newCyclusName = generateCyclusName(lastSlot.startDate, newStartTime);
      const pricing = lastSlot.priceManuallyEdited 
        ? { pricePerSession: lastSlot.pricePerSession, totalPrice: lastSlot.totalPrice }
        : autoCalcPricing(lastSlot.trainerId, lastSlot.durationMinutes, lastSlot.recurrenceWeeks, lastSlot.extraCosts);
      
      setBulkSlots([
        ...bulkSlots,
        {
          startDate: lastSlot.startDate,
          startTime: newStartTime,
          durationMinutes: lastSlot.durationMinutes,
          recurrenceWeeks: lastSlot.recurrenceWeeks,
          locationId: lastSlot.locationId,
          courtType: lastSlot.courtType,
          cyclusName: newCyclusName,
          addPlayers: true,
          selectedPlayers: [],
          isMarkedFull: false,
          academyProfileId: lastSlot.academyProfileId,
          trainerId: lastSlot.trainerId,
          ratingSystem: lastSlot.ratingSystem,
          minRating: lastSlot.minRating,
          maxRating: lastSlot.maxRating,
          pricePerSession: pricing.pricePerSession,
          totalPrice: pricing.totalPrice,
          allowSingleBooking: lastSlot.allowSingleBooking,
          wholeSlotBooking: lastSlot.wholeSlotBooking ?? false,
          minParticipants: lastSlot.minParticipants,
          maxParticipants: lastSlot.maxParticipants,
          priceManuallyEdited: lastSlot.priceManuallyEdited,
          markAsPaid: false,
          extraCosts: lastSlot.extraCosts,
          hasExtraCosts: lastSlot.hasExtraCosts,
          splitPayment: lastSlot.splitPayment,
          payerGuestPlayerId: null,
        },
      ]);
    } else {
      const newStartDate = getInitialStartDate();
      const newStartTime2 = getInitialStartTime();
      setBulkSlots([
        createDefaultSlotConfig(newStartDate, newStartTime2, defaultDuration, defaultWeeks, trainerId, academyId),
      ]);
    }
  };

  const updateBulkSlot = (index: number, updates: Partial<BulkSlotConfig>) => {
    setBulkSlots((prev) =>
      prev.map((slot, i) => {
        if (i !== index) return slot;
        const updated = { ...slot, ...updates };
        if (updates.selectedPlayers !== undefined) {
          updated.payerGuestPlayerId = normalizePayerId(
            updated.selectedPlayers,
            updates.payerGuestPlayerId ?? slot.payerGuestPlayerId,
          );
        }
        // Auto-regenerate cyclus name if relevant fields changed
        if (updates.startDate || updates.startTime) {
          const autoName = generateCyclusName(
            updates.startDate || slot.startDate,
            updates.startTime || slot.startTime,
          );
          if (slot.cyclusName.startsWith(t("calendar.cyclus"))) {
            updated.cyclusName = autoName;
          }
        }
        // Auto-recalc pricing if trainer/duration/weeks/extraCosts changed and not manually edited
        if (!updated.priceManuallyEdited && (updates.trainerId !== undefined || updates.durationMinutes !== undefined || updates.recurrenceWeeks !== undefined || updates.extraCosts !== undefined)) {
          const pricing = autoCalcPricing(updated.trainerId, updated.durationMinutes, updated.recurrenceWeeks, updated.extraCosts);
          updated.pricePerSession = pricing.pricePerSession;
          updated.totalPrice = pricing.totalPrice;
        }
        return updated;
      })
    );
  };

  const removeBulkSlot = (index: number) => {
    setBulkSlots((prev) => prev.filter((_, i) => i !== index));
  };

  const academyTrainerBlocked =
    Boolean(academyId) && (!availableTrainers || availableTrainers.length === 0);

  const showBulkGenerateValidationError = (error: ReturnType<typeof getBulkGenerateValidationError>) => {
    if (!error || error === "empty_slots") return;

    if (error === "no_academy_trainers") {
      toast({
        title: tAcademy("createSlot.trainerRequiredToast", "Add a trainer before creating a cycle."),
        variant: "destructive",
      });
      return;
    }

    if (error === "missing_slot_trainer" || error === "no_trainer_id") {
      toast({
        title: t("calendar.trainerRequired", "Trainer required"),
        description: t("calendar.trainerRequiredDescription", "Please select a trainer for each slot."),
        variant: "destructive",
      });
    }
  };

  const generateBulkSlots = async () => {
    const validationError = getBulkGenerateValidationError({
      bulkSlotCount: bulkSlots.length,
      academyId,
      availableTrainers,
      bulkSlots,
      trainerId,
    });
    if (validationError) {
      showBulkGenerateValidationError(validationError);
      return;
    }

    setIsGenerating(true);

    // REBOOK-01: cycles rows created in this run, so an aborted generation can
    // clean them up again (no empty cycli without slots).
    const createdCycleIds: string[] = [];
    let slotsInserted = false;

    try {
      const today = startOfDay(new Date());
      const slotsToInsert: {
        trainer_id: string;
        start_time: string;
        end_time: string;
        cyclus_id: string | null;
        cyclus_name: string | null;
        court_type: 'indoor' | 'outdoor' | null;
        location_id: string | null;
        academy_profile_id: string | null;
        training_level: string | null;
        rating_system: string | null;
        min_rating: number | null;
        max_rating: number | null;
        price_per_session: number | null;
        total_price: number | null;
        allow_single_booking: boolean;
        min_participants: number | null;
        max_participants: number | null;
        extra_costs: Json;
      }[] = [];

      // Skip sessions that would double-book a trainer: fetch each trainer's existing
      // slot RANGES in the batch window and compare as EPOCHS via the slotConflicts
      // helpers — string comparison of PostgREST '+00:00' timestamps against
      // toISOString() '.000Z' never matches, which made the old dedup a silent no-op
      // across runs. Overlap-based, not exact-start: a shifted re-run must not put the
      // trainer on court twice. Best-effort UX; the DB trigger (20260708100000) is the
      // race-proof, RLS-blind backstop.
      const trainerIdsToCheck = availableTrainers
        ? availableTrainers.map(t => t.id)
        : (trainerId ? [trainerId] : []);

      // The read window spans the CANDIDATES (the date picker allows past dates, so
      // starting the window at "today" would let a past-dated session slip past the
      // client skip and have the DB trigger abort the whole batch instead).
      let earliestStartMs = today.getTime();
      let latestEndMs = today.getTime();
      for (const config of bulkSlots) {
        const [h, m] = config.startTime.split(":").map(Number);
        const start = setMinutes(setHours(config.startDate, h), m);
        const end = addMinutes(addWeeks(start, Math.max(config.recurrenceWeeks - 1, 0)), config.durationMinutes);
        earliestStartMs = Math.min(earliestStartMs, start.getTime());
        latestEndMs = Math.max(latestEndMs, end.getTime());
      }

      const { byTrainer: existingRangesByTrainer, error: existingReadErr } = await fetchTrainerSlotRanges(
        trainerIdsToCheck,
        new Date(earliestStartMs).toISOString(),
        new Date(latestEndMs).toISOString(),
      );
      // A failed read must not silently disable the dedup (the old code ignored it).
      if (existingReadErr) throw existingReadErr;

      // Map to track which cyclus_id belongs to which config index
      const configCyclusMap = new Map<number, string>();
      let skippedOverlapCount = 0;

      for (let configIndex = 0; configIndex < bulkSlots.length; configIndex++) {
        const config = bulkSlots[configIndex];
        const slotTrainerId = config.trainerId || trainerId;
        if (!slotTrainerId) continue;
        
        const [startH, startM] = config.startTime.split(":").map(Number);
        const slotStart = setMinutes(setHours(config.startDate, startH), startM);

        // Shared per-trainer range list: stored back into the map so a later config
        // for the SAME trainer also sees this config's accepted sessions (the old
        // `|| new Set()` fresh-set fallback broke within-batch dedup across configs).
        let trainerExistingRanges = existingRangesByTrainer.get(slotTrainerId);
        if (!trainerExistingRanges) {
          trainerExistingRanges = [];
          existingRangesByTrainer.set(slotTrainerId, trainerExistingRanges);
        }

        // Collect this config's session times first (skipping overlaps), so the
        // cycles row below can use the real first/last generated session dates.
        const configSessions: { start: Date; end: Date }[] = [];
        for (const session of expandWeeklySessions(
          slotStart,
          config.durationMinutes,
          config.recurrenceWeeks,
        )) {
          const range = epochRange(session.start, session.end);
          // Skip if this session would overlap any slot the trainer already has
          if (trainerExistingRanges.some((e) => rangesOverlap(e, range))) {
            skippedOverlapCount++;
            continue;
          }

          configSessions.push(session);

          // Track accepted sessions to prevent overlaps within the same batch
          trainerExistingRanges.push(range);
        }

        if (configSessions.length === 0) continue;

        // REBOOK-01: create a real cycles row FIRST so calendar-created cycli are
        // visible to the "Set up next round" rebooking wizard and the
        // registrations list (both read from the cycles table); its id becomes
        // the slots' cyclus_id. status 'closed' so it never renders as an open
        // public registration form. Ownership: on the academy calendar
        // (academyId prop) the cycle is academy-owned; on the trainer calendar
        // it is trainer-owned even when "working as" an academy, because cycles
        // RLS only lets academy MANAGERS insert academy-owned rows.
        const cycleSettings: CycleSettings = { split_payment: config.splitPayment };
        if (config.minParticipants != null) cycleSettings.min_group_size = config.minParticipants;
        if (config.maxParticipants != null) cycleSettings.max_group_size = config.maxParticipants;
        const cycle = await createCycle({
          owner_type: academyId ? "academy" : "trainer",
          owner_id: academyId ? (config.academyProfileId || academyId) : slotTrainerId,
          name: config.cyclusName,
          start_date: format(configSessions[0].start, "yyyy-MM-dd"),
          end_date: format(configSessions[configSessions.length - 1].start, "yyyy-MM-dd"),
          type: "cyclus",
          status: "closed",
          location_id: config.locationId,
          price_per_session: config.pricePerSession,
          total_price: config.totalPrice,
          settings: cycleSettings,
        });
        const cyclusId = cycle.id;
        createdCycleIds.push(cyclusId);
        configCyclusMap.set(configIndex, cyclusId);

        for (const session of configSessions) {
          slotsToInsert.push({
            trainer_id: slotTrainerId,
            start_time: session.start.toISOString(),
            end_time: session.end.toISOString(),
            cyclus_id: cyclusId,
            cyclus_name: config.cyclusName,
            court_type: config.courtType,
            location_id: config.locationId,
            is_public: !config.isMarkedFull,
            academy_profile_id: config.academyProfileId,
            training_level: null,
            rating_system: config.ratingSystem,
            min_rating: config.minRating,
            max_rating: config.maxRating,
            price_per_session: config.pricePerSession,
            total_price: config.totalPrice,
            allow_single_booking: config.allowSingleBooking,
            whole_slot_booking: config.wholeSlotBooking ?? false,
            min_participants: config.minParticipants,
            max_participants: config.maxParticipants,
            extra_costs: (config.hasExtraCosts && config.extraCosts.length > 0 
              ? config.extraCosts.filter(c => c.description || c.price > 0) 
              : []) as unknown as Json,
            prices_include_vat: pricesIncludeVat,
            split_payment: config.splitPayment,
          } as any);
        }
      }

      if (slotsToInsert.length === 0) {
        toast({
          title: t("calendar.noNewSlots"),
          description: t("calendar.noNewSlotsDescription"),
        });
        setIsGenerating(false);
        return;
      }

      // `is_public` and `start_time` come back from the INSERT itself so visibility is SERVER
      // truth, not what the client believed it was sending. This is an INSERT … RETURNING via
      // .select(), so widening the projection costs a few scalars per row and no extra round trip —
      // and it is the only shape that reflects BEFORE-trigger rewrites and excludes rows that were
      // not actually inserted.
      const { data, error } = await insertAvailabilitySlots(
        slotsToInsert,
        supabase,
        "id, cyclus_id, is_public, start_time",
      );
      if (error) throw error;
      const insertedSlots =
        (data as {
          id: string;
          cyclus_id: string | null;
          is_public: boolean | null;
          start_time: string;
        }[]) ?? [];
      slotsInserted = true;

      // Create bookings for selected players using the config-to-cyclus mapping
      let totalBookingsCreated = 0;
      let hadBookingInsertError = false;
      const expectedGuestEnrollment = expectsBulkGuestBookings(bulkSlots);
      for (let configIndex = 0; configIndex < bulkSlots.length; configIndex++) {
        const config = bulkSlots[configIndex];
        
        if (config.addPlayers && config.selectedPlayers.length > 0) {
          // Get the cyclus_id that was generated for this specific config
          const cyclusId = configCyclusMap.get(configIndex);
          
          // Find slots that belong to THIS config's cyclus
          const configSlots = insertedSlots?.filter(
            (slot) => slot.cyclus_id === cyclusId
          ) || [];

          if (configSlots.length > 0) {
            const bookingsToInsert = buildBulkCycleBookings({
              slotIds: configSlots.map((s) => s.id),
              selectedPlayers: config.selectedPlayers,
              payerGuestPlayerId: config.payerGuestPlayerId,
              sessionPrice: config.pricePerSession,
              splitPayment: config.splitPayment,
              markAsPaid: config.markAsPaid,
              // G5: seed each split share as slot/capacity (frozen), not slot/(this batch's size).
              slotCapacity: config.maxParticipants,
            });

            if (bookingsToInsert.length > 0) {
              const { error: bookingError } = await insertBookings(bookingsToInsert);
              if (bookingError) {
                hadBookingInsertError = true;
                logSupabaseError("Error creating bookings", bookingError, {
                  component: "AddSlotDialog",
                  academyId: academyId ?? null,
                });
              } else {
                totalBookingsCreated += bookingsToInsert.length;
                // Mark guest players as has_trained
                if (config.selectedPlayers.length > 0) {
                  await supabase.from("guest_players").update({ has_trained: true }).in("id", config.selectedPlayers.filter(Boolean));
                }

                // Auto-create draft invoices for non-externally-paid bookings
                if (!config.markAsPaid) {
                  const { data: insertedBookings } = await supabase
                    .from("bookings")
                    .select("id, guest_player_id, payment_amount")
                    .in("slot_id", configSlots.map((s) => s.id))
                    .in("guest_player_id", config.selectedPlayers.filter(Boolean))
                    .eq("status", "confirmed");

                  if (insertedBookings) {
                    const playerBookingMap = groupChargeableBookingsByGuest(insertedBookings);
                    // G5 frozen divisor: slot capacity, NOT playerBookingMap.size (this batch's live
                    // headcount). A court-of-4 split with 2 added must bill each slot/4, not slot/2 —
                    // and a lone add must still split, not carry the whole court. Matches the seeded
                    // payment_amount above + the invoice/recalc/charge paths (resolveSplitDivisor).
                    const splitDivisor = config.splitPayment
                      ? resolveSplitDivisor([{ max_participants: config.maxParticipants }])
                      : 1;

                    for (const [, bIds] of playerBookingMap) {
                      try {
                        const invoiceBody: Record<string, unknown> = { bookingIds: bIds, asDraft: true };
                        if (splitDivisor > 1) {
                          const playerBookings = (insertedBookings || []).filter((b) =>
                            bIds.includes(b.id),
                          );
                          const splitCount = splitAmongPlayersForInvoiceCreate(
                            playerBookings.map((b) => ({
                              payment_amount: b.payment_amount,
                              availability_slots: { price_per_session: config.pricePerSession },
                            })),
                            splitDivisor,
                          );
                          if (splitCount != null) {
                            invoiceBody.splitAmongPlayers = splitCount;
                          }
                        }
                        await supabase.functions.invoke("auto-create-invoice", { body: invoiceBody });
                      } catch (invoiceErr) {
                        logger.warn("Draft invoice creation failed (non-blocking)", {
                          error: invoiceErr,
                          component: "AddSlotDialog",
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (totalBookingsCreated > 0) {
        if (trainerId) invalidateAllPlayerData(queryClient, { kind: 'trainer', id: trainerId });
        if (academyId) invalidateAllPlayerData(queryClient, { kind: 'academy', id: academyId });
      }

      const bookingOutcome = getBulkGenerateBookingOutcome({
        expectedEnrollment: expectedGuestEnrollment,
        totalBookingsCreated,
        hadBookingInsertError,
      });

      if (shouldShowBulkBookingPartialFailureToast(bookingOutcome)) {
        toast({
          title: t("calendar.bookingsPartialSuccessTitle"),
          description: t("calendar.bookingsPartialSuccessDescription"),
          variant: "destructive",
        });
      } else if (shouldShowBulkPlayersAddedToast(bookingOutcome, totalBookingsCreated)) {
        toast({
          title: t("calendar.playersAddedToCyclus", {
            count: bulkSlots.reduce((acc, s) => acc + s.selectedPlayers.filter(Boolean).length, 0),
            sessions: totalSessions,
          }),
        });
      }

      // notify-followers requires caller's trainer_profiles; academy managers lack one (see
      // shouldInvokeNotifyFollowersOnBulkGenerate).
      //
      // VISIBILITY IS SERVER TRUTH. This used to be a hardcoded `const hasPublicSlots = true` with
      // `publicSlots = slotsToInsert` — the ENTIRE insert list — so a batch where every entry was
      // "Mark cyclus as private" still notified followers, and slot_count counted private slots.
      // `is_public` is written per row as `!config.isMarkedFull`, and the edge function never reads
      // it, so the client was the only place this could be enforced and it wasn't enforcing it.
      // Now the filter runs over the rows the DATABASE returned.
      const publicSlots = insertedSlots.filter((s) => s.is_public === true);
      const hasPublicSlots = publicSlots.length > 0;
      if (shouldInvokeNotifyFollowersOnBulkGenerate({ hasPublicSlots, academyId })) {
        try {
          const earliestStart = new Date(
            Math.min(...publicSlots.map((s) => new Date(s.start_time).getTime()))
          );
          // NOTE: this is the latest START, not an end time. The name is historical; it is left
          // unchanged here to keep this safety fix's diff focused.
          const latestEnd = new Date(
            Math.max(...publicSlots.map((s) => new Date(s.start_time).getTime()))
          );

          const { data: { session } } = await supabase.auth.getSession();
          // STRUCTURED ISO dates, not display text (10c-b D): the copy is rendered server-side
          // by trusted SQL and frozen into an immutable hash-covered item, so a locale-formatted
          // range is unparseable downstream and would change the event identity if the format did.
          //
          // Routed through the ONE typed caller, which retries a bounded number of times while
          // the run reports itself incomplete. That is safe and creates no backlog: the resolver
          // de-duplicates per recipient, so an already-enqueued follower is a no-op. Slot
          // creation is never repeated — only this notification call.
          const notifyOutcome = await notifyFollowers(
            {
              slot_count: publicSlots.length,
              // Dates are sent for BACKWARD COMPATIBILITY ONLY. The frontend deploys before the
              // edge function (ADR 0008: migrations -> frontend -> bundle-cache wait -> edge fn),
              // so during that window a new client still talks to the OLD edge, which needs them.
              // The NEW edge ignores them as authority and derives its own from the verified rows.
              date_from: format(earliestStart, "yyyy-MM-dd"),
              date_to: format(latestEnd, "yyyy-MM-dd"),
              // EXACT PROVENANCE. The occurrence used to come from a date-RANGE lookup built with
              // offsetless literals against a timestamptz column, which was both an off-by-one at
              // day boundaries (occurrence null -> 503, nothing enqueued) and a query that could
              // match slots this caller never created. These are the ids the database just
              // returned as public and owned.
              slot_ids: publicSlots.map((s) => s.id),
            },
            { client: supabase, accessToken: session?.access_token },
          );
          if (!notifyOutcome.complete) {
            // Honest partial state: the slots WERE created, but some followers were not
            // notified. Saying nothing here is what previously lost them silently.
            logger.warn("notify-followers did not complete", {
              component: 'AddSlotDialog',
              attempts: notifyOutcome.attempts,
              error: notifyOutcome.lastError,
            });
            toast({
              title: t("calendar.followersNotifiedPartially"),
              variant: "default",
            });
          }
          if (notifyOutcome.markerGap) {
            // Everyone was enqueued, so there is nothing to tell the trainer — but some
            // recipients carry no cross-version rollback marker, and no retry can write one.
            // Logged so the transition window is observable instead of silently discarded.
            logger.warn("notify-followers enqueued without the rollback marker", {
              component: 'AddSlotDialog',
              recipients: notifyOutcome.markerGap,
            });
          }
        } catch {
          logger.warn("Failed to notify followers", { component: 'AddSlotDialog' });
        }
      }

      toast({
        title: t("calendar.slotsGenerated"),
        description:
          skippedOverlapCount > 0
            ? t("calendar.slotsGeneratedWithSkips", {
                count: slotsToInsert.length,
                skipped: skippedOverlapCount,
              })
            : t("calendar.slotsGeneratedDescription", {
                count: slotsToInsert.length,
                total: slotsToInsert.length,
              }),
      });

      setBulkSlots([]);
      onSlotsCreated();
      onClose?.();
    } catch (error: any) {
      // Best-effort cleanup: remove cycles rows whose slots never got inserted,
      // so an aborted generation leaves no empty cycli behind.
      if (!slotsInserted && createdCycleIds.length > 0) {
        await supabase.from("cycles").delete().in("id", createdCycleIds);
      }
      toast({
        title: "Error",
        description: isTrainerSlotOverlapError(error)
          ? t("slotConflict.trainerOverlap", { ns: "common" })
          : getFriendlyErrorMessage(error, t("calendar.slotsGenerateError", "Could not create the slots. Please try again.")),
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const totalSessions = bulkSlots.reduce((acc, slot) => acc + slot.recurrenceWeeks, 0);

  return (
    <>
      <div className="space-y-4 py-6">
          {bulkSlots.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Repeat className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="mb-4">{t("calendar.noCyclusConfigured")}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {bulkSlots.map((slot, index) => (
                <div
                  key={index}
                  className="p-4 border rounded-lg bg-muted/30 space-y-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {t("calendar.slot")} {index + 1}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeBulkSlot(index)}
                      className="text-destructive hover:text-destructive"
                    >
                      {t("calendar.remove")}
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {/* Start Date */}
                    <div className="space-y-1">
                      <Label className="text-xs">{t("calendar.startDate")}</Label>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className={cn(
                              "w-full justify-start text-left font-normal",
                              !slot.startDate && "text-muted-foreground"
                            )}
                          >
                            <CalendarIcon className="mr-2 h-3 w-3" />
                            {format(slot.startDate, "MMM d, yyyy")}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={slot.startDate}
                            onSelect={(date) =>
                              date &&
                              updateBulkSlot(index, { startDate: startOfDay(date) })
                            }
                            disabled={false}
                            initialFocus
                            className="p-3 pointer-events-auto"
                          />
                        </PopoverContent>
                      </Popover>
                    </div>

                    {/* Time */}
                    <div className="space-y-1">
                      <Label className="text-xs">{t("calendar.time")}</Label>
                      <TimeSelect
                        value={slot.startTime}
                        onValueChange={(v) => updateBulkSlot(index, { startTime: v })}
                        triggerClassName="h-8"
                      />
                    </div>

                    {/* Duration */}
                    <div className="space-y-1">
                      <Label className="text-xs">{t("calendar.duration")}</Label>
                      <Select
                        value={slot.durationMinutes.toString()}
                        onValueChange={(v) =>
                          updateBulkSlot(index, { durationMinutes: parseInt(v) })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="30">30 min</SelectItem>
                          <SelectItem value="45">45 min</SelectItem>
                          <SelectItem value="60">60 min</SelectItem>
                          <SelectItem value="90">90 min</SelectItem>
                          <SelectItem value="120">120 min</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Recurrence */}
                    <div className="space-y-1">
                      <Label className="text-xs">{t("calendar.repeatFor")}</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          max={52}
                          value={slot.recurrenceWeeks}
                          onChange={(e) =>
                            updateBulkSlot(index, { recurrenceWeeks: Math.max(1, Math.min(52, parseInt(e.target.value) || 1)) })
                          }
                          className="h-8 w-20"
                        />
                        <span className="text-sm text-muted-foreground">{t("calendar.weeks")}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 font-medium">
                        📅 {t("cycles:form.endsOn", { date: formatDate(addWeeks(slot.startDate, slot.recurrenceWeeks - 1), "PPP") })}
                      </p>
                    </div>
                  </div>

                  {/* Trainer (Academy mode) */}
                  {availableTrainers && availableTrainers.length > 0 && (
                    <div className="space-y-1">
                      <Label className="text-xs">{t("calendar.trainer", "Trainer")}</Label>
                      <Select
                        value={slot.trainerId || "none"}
                        onValueChange={(v) =>
                          updateBulkSlot(index, { trainerId: v === "none" ? null : v })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue placeholder={t("calendar.selectTrainer", "Select trainer")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{t("calendar.selectTrainer", "Select trainer")}</SelectItem>
                          {availableTrainers.map((trainer) => (
                            <SelectItem key={trainer.id} value={trainer.id}>
                              {trainer.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Pricing */}
                  <div className="space-y-2 pt-2 border-t">
                    <Label className="text-xs flex items-center gap-1">
                      <Euro className="h-3 w-3" />
                      {t("calendar.pricing", "Pricing")}
                    </Label>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {pricesIncludeVat
                          ? t("cycles:form.pricesIncludeVat", "Prices include VAT")
                          : t("cycles:detail.pricesExcludeVat", "Prices exclude VAT")}
                        {" · "}
                        <Link
                          to={getBulkCreateVatSettingsPath(academyId)}
                          className="text-primary underline hover:text-primary/80"
                        >
                          {t("calendar.changeInSettings", "Change in settings")}
                        </Link>
                      </p>
                    </div>
                    {slot.trainerId && getHourlyRate(slot.trainerId) && (
                      <p className="text-xs text-muted-foreground">
                        {t("calendar.hourlyRate", "Hourly rate")}: {formatPrice(getHourlyRate(slot.trainerId)!)}
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">
                          {t("calendar.pricePerSession", "Price per session")} {pricesIncludeVat ? t("cycles:form.inclVatShort", "(incl.)") : t("cycles:form.exclVatShort", "(excl.)")}
                        </Label>
                        <Input
                          type="number"
                          step="0.01"
                          min={0}
                          value={slot.pricePerSession ?? ""}
                          onChange={(e) => {
                            const val = e.target.value ? parseFloat(e.target.value) : null;
                            updateBulkSlot(index, { 
                              pricePerSession: val, 
                              totalPrice: val !== null ? Math.round(val * slot.recurrenceWeeks * 100) / 100 : null,
                              priceManuallyEdited: true 
                            });
                          }}
                          placeholder="0.00"
                          className="h-8"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">{t("calendar.totalPrice", "Total cyclus price")}</Label>
                        <Input
                          type="number"
                          step="0.01"
                          min={0}
                          value={slot.totalPrice ?? ""}
                          onChange={(e) => {
                            const val = e.target.value ? parseFloat(e.target.value) : null;
                            updateBulkSlot(index, { totalPrice: val, priceManuallyEdited: true });
                          }}
                          placeholder="0.00"
                          className="h-8"
                        />
                  </div>

                  {/* Extra Costs */}
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id={`extra-costs-${index}`}
                        checked={slot.hasExtraCosts}
                        onCheckedChange={(checked) => {
                          const hasExtra = !!checked;
                          updateBulkSlot(index, { 
                            hasExtraCosts: hasExtra,
                            extraCosts: hasExtra ? (slot.extraCosts.length > 0 ? slot.extraCosts : [{ description: '', price: 0 }]) : []
                          });
                        }}
                      />
                      <Label htmlFor={`extra-costs-${index}`} className="text-sm cursor-pointer">
                        {t("calendar.addExtraCosts", "Add extra costs")}
                      </Label>
                    </div>

                    {slot.hasExtraCosts && (
                      <div className="space-y-2 pl-6 border-l-2 border-primary/20">
                        {/* Presets first */}
                        <div className="flex flex-wrap gap-2">
                          <ExtraCostPresetPicker
                            trainerId={slot.trainerId}
                            academyProfileId={slot.academyProfileId}
                            onSelect={(cost) => {
                              updateBulkSlot(index, { extraCosts: [...slot.extraCosts, cost] });
                            }}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              updateBulkSlot(index, { extraCosts: [...slot.extraCosts, { description: '', price: 0, type: 'per_session', vat_rate: 21 }] });
                            }}
                            className="gap-1 text-muted-foreground"
                          >
                            <Plus className="h-3 w-3" />
                            {t("calendar.addCostLine", "Handmatig toevoegen")}
                          </Button>
                        </div>

                        {/* Existing cost items */}
                        {slot.extraCosts.map((cost, costIndex) => (
                          <div key={costIndex} className="space-y-1.5">
                            <Input
                              value={cost.description}
                              onChange={(e) => {
                                const newCosts = [...slot.extraCosts];
                                newCosts[costIndex] = { ...newCosts[costIndex], description: e.target.value };
                                updateBulkSlot(index, { extraCosts: newCosts });
                              }}
                              placeholder={t("calendar.costDescription", "e.g. Court rental")}
                              className="h-8 w-full"
                            />
                            <div className="flex items-center gap-2">
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-muted-foreground">€</span>
                                <Input
                                  type="number"
                                  step="0.01"
                                  min={0}
                                  value={cost.price || ""}
                                  onChange={(e) => {
                                    const newCosts = [...slot.extraCosts];
                                    newCosts[costIndex] = { ...newCosts[costIndex], price: parseFloat(e.target.value) || 0 };
                                    updateBulkSlot(index, { extraCosts: newCosts });
                                  }}
                                  placeholder="0.00"
                                  className="h-8 w-24"
                                />
                              </div>
                              <div className="flex items-center gap-1">
                                <Input
                                  type="number"
                                  min={0}
                                  max={100}
                                  step={1}
                                  value={cost.vat_rate ?? 21}
                                  onChange={(e) => {
                                    const newCosts = [...slot.extraCosts];
                                    newCosts[costIndex] = { ...newCosts[costIndex], vat_rate: Number(e.target.value) || 0 };
                                    updateBulkSlot(index, { extraCosts: newCosts });
                                  }}
                                  className="h-8 w-16"
                                />
                                <span className="text-xs text-muted-foreground">%</span>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon" aria-label="Delete"
                                className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                                onClick={() => {
                                  const newCosts = slot.extraCosts.filter((_, i) => i !== costIndex);
                                  updateBulkSlot(index, { extraCosts: newCosts.length > 0 ? newCosts : [], hasExtraCosts: newCosts.length > 0 });
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                            <div className="flex gap-2">
                              <label className={cn(
                                "flex items-center gap-1 text-xs cursor-pointer px-2 py-0.5 rounded-md border transition-colors",
                                (cost.type || 'per_session') === 'per_session' ? "border-primary bg-primary/5 text-primary" : "border-transparent text-muted-foreground"
                              )}>
                                <input
                                  type="radio"
                                  name={`slot_cost_type_${index}_${costIndex}`}
                                  checked={(cost.type || 'per_session') === 'per_session'}
                                  onChange={() => {
                                    const newCosts = [...slot.extraCosts];
                                    newCosts[costIndex] = { ...newCosts[costIndex], type: 'per_session' };
                                    updateBulkSlot(index, { extraCosts: newCosts });
                                  }}
                                  className="sr-only"
                                />
                                {t("calendar.perSession", "Per session")}
                              </label>
                              <label className={cn(
                                "flex items-center gap-1 text-xs cursor-pointer px-2 py-0.5 rounded-md border transition-colors",
                                cost.type === 'one_time' ? "border-primary bg-primary/5 text-primary" : "border-transparent text-muted-foreground"
                              )}>
                                <input
                                  type="radio"
                                  name={`slot_cost_type_${index}_${costIndex}`}
                                  checked={cost.type === 'one_time'}
                                  onChange={() => {
                                    const newCosts = [...slot.extraCosts];
                                    newCosts[costIndex] = { ...newCosts[costIndex], type: 'one_time' };
                                    updateBulkSlot(index, { extraCosts: newCosts });
                                  }}
                                  className="sr-only"
                                />
                                {t("calendar.oneTime", "One-time")}
                              </label>
                            </div>
                          </div>
                        ))}
                        {slot.extraCosts.length > 0 && slot.extraCosts.some(c => c.price > 0) && (
                          <p className="text-xs text-muted-foreground">
                            {t("calendar.extraCostsPerSession", "Extra costs per session")}: {formatPrice(slot.extraCosts.filter(c => (c.type || 'per_session') === 'per_session').reduce((sum, c) => sum + (c.price || 0), 0))}
                            {slot.extraCosts.some(c => c.type === 'one_time' && c.price > 0) && (
                              <> + {formatPrice(slot.extraCosts.filter(c => c.type === 'one_time').reduce((sum, c) => sum + (c.price || 0), 0))} {t("calendar.oneTime", "one-time")}</>
                            )}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                    </div>
                  </div>

                  {/* Participants */}
                  <div className="space-y-2 pt-2 border-t">
                    <Label className="text-xs flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {t("calendar.participants", "Participants")}
                    </Label>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">{t("calendar.minParticipants", "Min participants")}</Label>
                        <Input
                          type="number"
                          min={1}
                          value={slot.minParticipants ?? ""}
                          onChange={(e) =>
                            updateBulkSlot(index, { minParticipants: e.target.value ? parseInt(e.target.value) : null })
                          }
                          placeholder="-"
                          className="h-8"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">{t("calendar.maxParticipants", "Max participants")}</Label>
                        <Input
                          type="number"
                          min={1}
                          value={slot.maxParticipants ?? ""}
                          onChange={(e) =>
                            updateBulkSlot(index, { maxParticipants: e.target.value ? parseInt(e.target.value) : null })
                          }
                          placeholder="-"
                          className="h-8"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Allow Single Booking */}
                  <div className="flex items-center space-x-2 pt-2 border-t">
                    <Checkbox
                      id={`allow-single-${index}`}
                      checked={slot.allowSingleBooking}
                      onCheckedChange={(checked) =>
                        updateBulkSlot(index, { allowSingleBooking: !!checked })
                      }
                    />
                    <div>
                      <Label htmlFor={`allow-single-${index}`} className="text-sm cursor-pointer">
                        {t("calendar.allowSingleBooking", "Allow players to book individual slots")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t("calendar.allowSingleBookingHint", "When enabled, players can book and pay for single sessions")}
                      </p>
                    </div>
                  </div>

                  {/* Split Payment */}
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id={`split-payment-${index}`}
                      checked={slot.splitPayment}
                      onCheckedChange={(checked) =>
                        updateBulkSlot(index, { splitPayment: !!checked })
                      }
                    />
                    <div>
                      <Label htmlFor={`split-payment-${index}`} className="text-sm cursor-pointer">
                        {t("calendar.splitPayment", "Split payment among participants")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t("calendar.splitPaymentHint", "Total price will be divided equally among all booked players")}
                      </p>
                    </div>
                  </div>

                  {/* Location */}
                  <div className="space-y-1">
                    <Label className="text-xs">{t("calendar.location", "Location")}</Label>
                    <SlotLocationPicker
                      value={slot.locationId}
                      onChange={(locationId) => updateBulkSlot(index, { locationId })}
                      trainerId={slot.trainerId || trainerId}
                      availableLocations={availableLocations}
                      compact
                    />
                  </div>

                  {/* Court Type */}
                  <div className="space-y-1">
                    <Label className="text-xs">{t("calendar.courtType", "Court Type")}</Label>
                    <Select
                      value={slot.courtType || "any"}
                      onValueChange={(v) =>
                        updateBulkSlot(index, { courtType: v === "any" ? null : v as 'indoor' | 'outdoor' })
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">{t("calendar.anyCourtType", "Any")}</SelectItem>
                        <SelectItem value="indoor">{t("calendar.indoor", "Indoor")}</SelectItem>
                        <SelectItem value="outdoor">{t("calendar.outdoor", "Outdoor")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Rating Level (optional) */}
                  <SlotRatingPicker
                    ratingSystem={slot.ratingSystem}
                    minRating={slot.minRating}
                    maxRating={slot.maxRating}
                    onChange={(vals) => updateBulkSlot(index, vals)}
                    compact
                    fixedRatingSystem={trainerRatingSystem}
                  />

                  {/* Cyclus Name */}
                  <div className="space-y-1">
                    <Label className="text-xs">{t("calendar.cyclusName")}</Label>
                    <Input
                      value={slot.cyclusName}
                      onChange={(e) => updateBulkSlot(index, { cyclusName: e.target.value })}
                      placeholder={t("calendar.cyclusNamePlaceholder")}
                      className="h-8"
                    />
                  </div>

                  {/* Working As (Academy) */}
                  {trainerAcademy && trainerAcademy.id && (
                    <div className="space-y-1">
                      <Label className="text-xs">{t("calendar.workingAs", "Working as")}</Label>
                      <Select
                        value={slot.academyProfileId || "independent"}
                        onValueChange={(v) =>
                          updateBulkSlot(index, { academyProfileId: v === "independent" ? null : v })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="independent">
                            <div className="flex items-center gap-2">
                              <User className="h-4 w-4" />
                              {t("calendar.independent", "Independent")}
                            </div>
                          </SelectItem>
                          <SelectItem value={trainerAcademy.id}>
                            <div className="flex items-center gap-2">
                              <GraduationCap className="h-4 w-4" />
                              {trainerAcademy.name}
                            </div>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Add Players Checkbox */}
                  <div className="space-y-3 pt-2 border-t">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id={`add-players-${index}`}
                        checked={slot.addPlayers}
                        onCheckedChange={(checked) =>
                          updateBulkSlot(index, { 
                            addPlayers: !!checked,
                            selectedPlayers: checked ? slot.selectedPlayers : []
                          })
                        }
                      />
                      <Label htmlFor={`add-players-${index}`} className="text-sm cursor-pointer">
                        {t("calendar.addPlayersToSlot")}
                      </Label>
                    </div>

                    {slot.addPlayers && (
                      <div className="space-y-2 pl-6 border-l-2 border-primary/20">
                        {[0, 1, 2, 3].map((playerIndex) => (
                          <div key={playerIndex} className="flex items-center gap-2">
                            <Label className="text-xs w-16 shrink-0">
                              {t("calendar.player")} {playerIndex + 1}:
                            </Label>
                            <GuestPlayerSlotCombobox
                              players={players}
                              value={slot.selectedPlayers[playerIndex] ?? ""}
                              placeholder={t("calendar.selectPlayer")}
                              disabledPlayerIds={slot.selectedPlayers.filter(
                                (id, i) => i !== playerIndex && !!id,
                              )}
                              data-testid={`bulk-slot-${index}-player-${playerIndex}-combobox`}
                              onValueChange={(playerId) => {
                                const newPlayers = [...slot.selectedPlayers];
                                newPlayers[playerIndex] = playerId;
                                updateBulkSlot(index, { selectedPlayers: newPlayers });
                              }}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="icon" aria-label="Add"
                              className="h-8 w-8 shrink-0"
                              onClick={() => {
                                setAddPlayerContext({ slotIndex: index, playerIndex });
                                setAddPlayerDialogOpen(true);
                              }}
                              title={t("players.addPlayer")}
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}

                        {shouldShowPayerSelector(
                          slot.splitPayment,
                          getSelectedGuestPlayerIds(slot.selectedPlayers),
                        ) && (
                          <div className="space-y-1.5 pt-2">
                            <Label className="text-xs">
                              {t("calendar.invoicePayerLabel", "Who should receive the invoice?")}
                            </Label>
                            <Select
                              value={slot.payerGuestPlayerId ?? ""}
                              onValueChange={(value) =>
                                updateBulkSlot(index, { payerGuestPlayerId: value })
                              }
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue
                                  placeholder={t("calendar.selectPlayer", "Select player")}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {getSelectedGuestPlayerIds(slot.selectedPlayers).map((playerId) => {
                                  const player = players.find((p) => p.id === playerId);
                                  return (
                                    <SelectItem key={playerId} value={playerId}>
                                      {player?.full_name ?? playerId}
                                    </SelectItem>
                                  );
                                })}
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                              {t(
                                "calendar.invoicePayerHint",
                                "Because split payment is off, only this player will be invoiced for the full amount.",
                              )}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Mark as Paid Checkbox */}
                  {slot.addPlayers && slot.selectedPlayers.some(Boolean) && (
                    <div className="flex items-start space-x-2 pt-2">
                      <Checkbox
                        id={`mark-paid-${index}`}
                        checked={slot.markAsPaid}
                        onCheckedChange={(checked) =>
                          updateBulkSlot(index, { markAsPaid: !!checked })
                        }
                      />
                      <div>
                        <Label htmlFor={`mark-paid-${index}`} className="text-sm cursor-pointer flex items-center gap-2">
                          <Euro className="h-4 w-4" />
                          {t("calendar.markAsPaid")}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {t("calendar.markAsPaidHint")}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Mark as Private Checkbox */}
                  <div className="flex items-center space-x-2 pt-2">
                    <Checkbox
                      id={`mark-full-${index}`}
                      checked={slot.isMarkedFull}
                      onCheckedChange={(checked) =>
                        updateBulkSlot(index, { isMarkedFull: !!checked })
                      }
                    />
                    <Label htmlFor={`mark-full-${index}`} className="text-sm cursor-pointer flex items-center gap-2">
                      <Lock className="h-4 w-4" />
                      {t("calendar.markAsPrivate")}
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground pl-6">
                    {t("calendar.markAsPrivateHint")}
                  </p>

                  <p className="text-xs text-muted-foreground">
                    {t("calendar.recurringSummary", {
                      count: slot.recurrenceWeeks,
                      day: formatDate(slot.startDate, "EEEE"),
                      time: slot.startTime,
                      startDate: formatDate(slot.startDate, "d MMM"),
                      endDate: formatDate(
                        addWeeks(slot.startDate, slot.recurrenceWeeks - 1),
                        "d MMM yyyy"
                      ),
                    })}
                  </p>
                </div>
              ))}
            </div>
          )}

          <Button
            onClick={addBulkSlotConfig}
            variant="outline"
            className="w-full gap-2"
          >
            <Plus className="h-4 w-4" />
            {t("calendar.addRecurringSlot")}
          </Button>

          {bulkSlots.length > 0 && (
            <div className="p-4 border rounded-lg bg-primary/5 border-primary/30 space-y-3">
              <div>
                <h4 className="font-semibold">{t("calendar.generateCycle")}</h4>
                <p className="text-sm text-muted-foreground">
                  {t("calendar.generateCycleDescription", {
                    // count drives the _one/_other plural; slotCount keeps the
                    // legacy "slot(s)" key working until the plural keys land.
                    count: bulkSlots.length,
                    slotCount: bulkSlots.length,
                    sessionCount: totalSessions,
                  })}
                </p>
              </div>
              <Button
                onClick={generateBulkSlots}
                disabled={isGenerating || academyTrainerBlocked}
                className="w-full gap-2"
              >
                <Repeat className={cn("h-4 w-4", isGenerating && "animate-spin")} />
                {isGenerating ? t("calendar.generating") : t("calendar.generateSlots")}
              </Button>
            </div>
          )}
        </div>

        <AddPlayerDialog
          open={addPlayerDialogOpen}
          onOpenChange={(open) => {
            setAddPlayerDialogOpen(open);
            if (!open) setAddPlayerContext(null);
          }}
          trainerId={trainerId || undefined}
          academyId={academyId}
          onPlayerCreated={(player) => {
            setPlayers((prev) => {
              if (prev.some((p) => p.id === player.id)) {
                return prev;
              }
              return [...prev, player].sort((a, b) => a.full_name.localeCompare(b.full_name));
            });
            if (academyId) {
              void fetchPlayers();
            }
            // Auto-fill the player in the slot that triggered the dialog
            if (addPlayerContext) {
              const { slotIndex, playerIndex } = addPlayerContext;
              setBulkSlots((prev) =>
                prev.map((slot, i) => {
                  if (i !== slotIndex) return slot;
                  const newPlayers = [...slot.selectedPlayers];
                  newPlayers[playerIndex] = player.id;
                  return { ...slot, selectedPlayers: newPlayers };
                })
              );
              setAddPlayerContext(null);
            }
          }}
        />
    </>

  );
}
