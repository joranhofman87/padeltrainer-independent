import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format, addMinutes, setHours, setMinutes, startOfDay, isBefore, addWeeks, getDay } from "date-fns";
import { CalendarIcon, Plus, Repeat, UserPlus, MapPin, Lock, GraduationCap, User, Euro, Users, Trash2 } from "lucide-react";
import { calculateSlotPrice, formatPrice } from "@/lib/pricing";
import { type ExtraCost } from "@/lib/cycles";
import type { Json } from "@/integrations/supabase/types";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { AddPlayerDialog, GuestPlayer } from "./AddPlayerDialog";
import { SlotLocationPicker, type SlotLocation } from "./SlotLocationPicker";
import { SlotRatingPicker } from "./SlotRatingPicker";
import { getTrainerAcademy, type AcademyProfile } from "@/lib/academy";

const TIME_OPTIONS = Array.from({ length: 24 * 2 }, (_, i) => {
  const hours = Math.floor(i / 2);
  const minutes = (i % 2) * 30;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
});


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
  minParticipants: number | null;
  maxParticipants: number | null;
  priceManuallyEdited: boolean;
  markAsPaid: boolean;
  extraCosts: ExtraCost[];
  hasExtraCosts: boolean;
}

interface AddSlotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string | null;
  defaultDate?: Date;
  defaultTime?: string;
  defaultDuration: number;
  defaultWeeks: number;
  onSlotsCreated: () => void;
  availableLocations?: SlotLocation[];
}

export function AddSlotDialog({
  open,
  onOpenChange,
  trainerId,
  defaultDate,
  defaultTime,
  defaultDuration,
  defaultWeeks,
  onSlotsCreated,
  availableLocations,
}: AddSlotDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();

  const [slotDate, setSlotDate] = useState<Date>(defaultDate || new Date());
  const [slotTime, setSlotTime] = useState(defaultTime || "09:00");
  const [slotDuration, setSlotDuration] = useState(defaultDuration);
  const [slotCourtType, setSlotCourtType] = useState<'indoor' | 'outdoor' | null>(null);
  const [slotLocationId, setSlotLocationId] = useState<string | null>(null);
  const [slotAcademyId, setSlotAcademyId] = useState<string | null>(null);
  const [slotRatingSystem, setSlotRatingSystem] = useState<string | null>(null);
  const [slotMinRating, setSlotMinRating] = useState<number | null>(null);
  const [slotMaxRating, setSlotMaxRating] = useState<number | null>(null);
  const [trainerAcademy, setTrainerAcademy] = useState<Partial<AcademyProfile> | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Sync date/time when dialog opens with new defaults (e.g. clicking a calendar cell)
  useEffect(() => {
    if (open) {
      if (defaultDate) setSlotDate(defaultDate);
      if (defaultTime) setSlotTime(defaultTime);
    }
  }, [open, defaultDate, defaultTime]);

  // Fetch trainer's academy affiliation
  useEffect(() => {
    async function fetchAcademy() {
      if (!trainerId) return;
      const academy = await getTrainerAcademy(trainerId);
      setTrainerAcademy(academy);
    }
    if (open && trainerId) {
      fetchAcademy();
    }
  }, [open, trainerId]);

  const handleAddSingleSlot = async () => {
    if (!trainerId) return;
    setIsSaving(true);

    try {
      const [hours, minutes] = slotTime.split(":").map(Number);
      const startDateTime = setMinutes(setHours(slotDate, hours), minutes);
      const endDateTime = addMinutes(startDateTime, slotDuration);

      const { error } = await supabase.from("availability_slots").insert({
        trainer_id: trainerId,
        start_time: startDateTime.toISOString(),
        end_time: endDateTime.toISOString(),
        court_type: slotCourtType,
        location_id: slotLocationId,
        academy_profile_id: slotAcademyId,
        rating_system: slotRatingSystem,
        min_rating: slotMinRating,
        max_rating: slotMaxRating,
      });

      if (error) throw error;

      toast({ title: t("calendar.slotCreated") });
      onSlotsCreated();
      onOpenChange(false);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            {t("calendar.addSlotTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("calendar.addSlotDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-4">
          {/* Date */}
          <div className="space-y-2">
            <Label>{t("calendar.date")}</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !slotDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {slotDate ? format(slotDate, "PPP") : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={slotDate}
                  onSelect={(date) => date && setSlotDate(date)}
                  disabled={(date) => isBefore(date, startOfDay(new Date()))}
                  initialFocus
                  className="p-3 pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Time */}
          <div className="space-y-2">
            <Label>{t("calendar.time")}</Label>
            <Select value={slotTime} onValueChange={setSlotTime}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_OPTIONS.map((time) => (
                  <SelectItem key={time} value={time}>
                    {time}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Duration */}
          <div className="space-y-2">
            <Label>{t("calendar.duration")}</Label>
            <Select
              value={slotDuration.toString()}
              onValueChange={(v) => setSlotDuration(parseInt(v))}
            >
              <SelectTrigger>
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

          {/* Location */}
          <div className="space-y-2">
            <Label>{t("calendar.location", "Location")}</Label>
            <SlotLocationPicker
              value={slotLocationId}
              onChange={setSlotLocationId}
              trainerId={trainerId}
              availableLocations={availableLocations}
            />
          </div>

          {/* Court Type */}
          <div className="space-y-2">
            <Label>{t("calendar.courtType", "Court Type")}</Label>
            <Select
              value={slotCourtType || "any"}
              onValueChange={(v) => setSlotCourtType(v === "any" ? null : v as 'indoor' | 'outdoor')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">{t("calendar.anyCourtType", "Any")}</SelectItem>
                <SelectItem value="indoor">{t("calendar.indoor", "Indoor")}</SelectItem>
                <SelectItem value="outdoor">{t("calendar.outdoor", "Outdoor")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Working As (Academy) */}
          {trainerAcademy && trainerAcademy.id && (
            <div className="space-y-2">
              <Label>{t("calendar.workingAs", "Working as")}</Label>
              <Select
                value={slotAcademyId || "independent"}
                onValueChange={(v) => setSlotAcademyId(v === "independent" ? null : v)}
              >
                <SelectTrigger>
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

          <Button
            onClick={handleAddSingleSlot}
            disabled={isSaving}
            className="w-full"
          >
            {isSaving ? "Saving..." : t("calendar.addSlot")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface TrainerOption {
  id: string;
  name: string;
}

interface BulkCreateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string | null;
  defaultDate?: Date;
  defaultTime?: string;
  defaultDuration: number;
  defaultWeeks: number;
  onSlotsCreated: () => void;
  availableLocations?: SlotLocation[];
  availableTrainers?: TrainerOption[];
}

export function BulkCreateSheet({
  open,
  onOpenChange,
  trainerId,
  defaultDate,
  defaultTime,
  defaultDuration,
  defaultWeeks,
  onSlotsCreated,
  availableLocations,
  availableTrainers,
}: BulkCreateSheetProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();

  const [bulkSlots, setBulkSlots] = useState<BulkSlotConfig[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [players, setPlayers] = useState<GuestPlayer[]>([]);
  const [addPlayerDialogOpen, setAddPlayerDialogOpen] = useState(false);
  const [addPlayerContext, setAddPlayerContext] = useState<{ slotIndex: number; playerIndex: number } | null>(null);
  const [trainerAcademy, setTrainerAcademy] = useState<Partial<AcademyProfile> | null>(null);
  const [trainerHourlyRates, setTrainerHourlyRates] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    if (open && trainerId) {
      fetchPlayers();
      fetchAcademy();
      fetchTrainerHourlyRate(trainerId);
    }
    if (open && availableTrainers) {
      fetchAllTrainerRates();
    }
  }, [open, trainerId]);

  const fetchAcademy = async () => {
    if (!trainerId) return;
    const academy = await getTrainerAcademy(trainerId);
    setTrainerAcademy(academy);
  };

  const fetchTrainerHourlyRate = async (tId: string) => {
    const { data } = await supabase
      .from("trainer_profiles")
      .select("id, hourly_rate")
      .eq("id", tId)
      .maybeSingle();
    if (data?.hourly_rate) {
      setTrainerHourlyRates(prev => new Map(prev).set(tId, data.hourly_rate));
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
    const extraCostsPerSession = extraCosts.reduce((sum, c) => sum + (c.price || 0), 0);
    const totalPrice = (pricePerSession + extraCostsPerSession) * recurrenceWeeks;
    return { pricePerSession: Math.round(pricePerSession * 100) / 100, totalPrice: Math.round(totalPrice * 100) / 100 };
  };

  const fetchPlayers = async () => {
    if (!trainerId) return;
    const { data } = await supabase
      .from("guest_players")
      .select("*")
      .eq("trainer_id", trainerId)
      .order("full_name");
    setPlayers(data || []);
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
    const dayName = format(startDate, "EEEE");
    return `${t("calendar.cyclus")} ${dayName} ${startTime}`;
  };

  const createDefaultSlotConfig = (startDate: Date, startTime: string, duration: number, weeks: number, tId: string | null): BulkSlotConfig => {
    const pricing = autoCalcPricing(tId, duration, weeks);
    return {
      startDate,
      startTime,
      durationMinutes: duration,
      recurrenceWeeks: weeks,
      cyclusName: generateCyclusName(startDate, startTime),
      addPlayers: false,
      selectedPlayers: [],
      courtType: null,
      locationId: null,
      isMarkedFull: false,
      academyProfileId: null,
      trainerId: tId,
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
    };
  };

  // Sync first slot when opened via cell click with default date/time
  useEffect(() => {
    if (open && defaultDate) {
      const newStartDate = getInitialStartDate();
      const newStartTime = getInitialStartTime();
      setBulkSlots([createDefaultSlotConfig(newStartDate, newStartTime, defaultDuration, defaultWeeks, trainerId)]);
    }
    if (!open) {
      setBulkSlots([]);
    }
  }, [open, defaultDate, defaultTime]);

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
          addPlayers: false,
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
          minParticipants: lastSlot.minParticipants,
          maxParticipants: lastSlot.maxParticipants,
          priceManuallyEdited: lastSlot.priceManuallyEdited,
          markAsPaid: false,
          extraCosts: lastSlot.extraCosts,
          hasExtraCosts: lastSlot.hasExtraCosts,
        },
      ]);
    } else {
      const newStartDate = getInitialStartDate();
      const newStartTime2 = getInitialStartTime();
      setBulkSlots([createDefaultSlotConfig(newStartDate, newStartTime2, defaultDuration, defaultWeeks, trainerId)]);
    }
  };

  const updateBulkSlot = (index: number, updates: Partial<BulkSlotConfig>) => {
    setBulkSlots((prev) =>
      prev.map((slot, i) => {
        if (i !== index) return slot;
        const updated = { ...slot, ...updates };
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

  const generateBulkSlots = async () => {
    if (bulkSlots.length === 0) return;
    
    // When availableTrainers is provided (academy mode), each slot must have a trainer
    if (availableTrainers && availableTrainers.length > 0) {
      const missingTrainer = bulkSlots.some(s => !s.trainerId);
      if (missingTrainer) {
        toast({
          title: t("calendar.trainerRequired", "Trainer required"),
          description: t("calendar.trainerRequiredDescription", "Please select a trainer for each slot."),
          variant: "destructive",
        });
        return;
      }
    } else if (!trainerId) {
      return;
    }
    
    setIsGenerating(true);

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
        is_marked_full: boolean;
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

      // Get existing slots to avoid duplicates per trainer
      const trainerIdsToCheck = availableTrainers 
        ? availableTrainers.map(t => t.id) 
        : (trainerId ? [trainerId] : []);
      
      const { data: existingSlots } = await supabase
        .from("availability_slots")
        .select("start_time, trainer_id")
        .in("trainer_id", trainerIdsToCheck)
        .gte("start_time", today.toISOString());

      const existingTimesByTrainer = new Map<string, Set<string>>();
      (existingSlots || []).forEach(s => {
        if (!existingTimesByTrainer.has(s.trainer_id)) {
          existingTimesByTrainer.set(s.trainer_id, new Set());
        }
        existingTimesByTrainer.get(s.trainer_id)!.add(s.start_time);
      });

      // Map to track which cyclus_id belongs to which config index
      const configCyclusMap = new Map<number, string>();

      for (let configIndex = 0; configIndex < bulkSlots.length; configIndex++) {
        const config = bulkSlots[configIndex];
        const slotTrainerId = config.trainerId || trainerId;
        if (!slotTrainerId) continue;
        
        const [startH, startM] = config.startTime.split(":").map(Number);
        let slotStart = setMinutes(setHours(config.startDate, startH), startM);

        // Generate a unique cyclus ID for this recurring slot configuration
        const cyclusId = crypto.randomUUID();
        configCyclusMap.set(configIndex, cyclusId);

        const trainerExistingTimes = existingTimesByTrainer.get(slotTrainerId) || new Set();

        // Generate slots for each week in the recurrence period
        for (let week = 0; week < config.recurrenceWeeks; week++) {
          const currentSlotStart = addWeeks(slotStart, week);
          const currentSlotEnd = addMinutes(currentSlotStart, config.durationMinutes);

          // Skip if this exact time already exists for this trainer
          if (trainerExistingTimes.has(currentSlotStart.toISOString())) {
            continue;
          }

          slotsToInsert.push({
            trainer_id: slotTrainerId,
            start_time: currentSlotStart.toISOString(),
            end_time: currentSlotEnd.toISOString(),
            cyclus_id: cyclusId,
            cyclus_name: config.cyclusName,
            court_type: config.courtType,
            location_id: config.locationId,
            is_marked_full: config.isMarkedFull,
            academy_profile_id: config.academyProfileId,
            training_level: null,
            rating_system: config.ratingSystem,
            min_rating: config.minRating,
            max_rating: config.maxRating,
            price_per_session: config.pricePerSession,
            total_price: config.totalPrice,
            allow_single_booking: config.allowSingleBooking,
            min_participants: config.minParticipants,
            max_participants: config.maxParticipants,
            extra_costs: (config.hasExtraCosts && config.extraCosts.length > 0 
              ? config.extraCosts.filter(c => c.description || c.price > 0) 
              : []) as unknown as Json,
          });

          // Add to existing times to prevent duplicates within same batch
          trainerExistingTimes.add(currentSlotStart.toISOString());
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

      const { data: insertedSlots, error } = await supabase
        .from("availability_slots")
        .insert(slotsToInsert)
        .select("id, cyclus_id");
      if (error) throw error;

      // Create bookings for selected players using the config-to-cyclus mapping
      let totalBookingsCreated = 0;
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
            const bookingsToInsert = [];
            for (const slot of configSlots) {
              for (const playerId of config.selectedPlayers) {
                if (playerId) {
                  bookingsToInsert.push({
                    slot_id: slot.id,
                    guest_player_id: playerId,
                    status: "confirmed",
                    payment_status: config.markAsPaid ? "paid" : "pending",
                    ...(config.markAsPaid ? { paid_at: new Date().toISOString(), paid_externally: true } : {}),
                  });
                }
              }
            }

            if (bookingsToInsert.length > 0) {
              const { error: bookingError } = await supabase
                .from("bookings")
                .insert(bookingsToInsert);
              if (bookingError) {
                console.error("Error creating bookings:", bookingError);
              } else {
                totalBookingsCreated += bookingsToInsert.length;
              }
            }
          }
        }
      }

      if (totalBookingsCreated > 0) {
        toast({
          title: t("calendar.playersAddedToCyclus", {
            count: bulkSlots.reduce((acc, s) => acc + s.selectedPlayers.filter(Boolean).length, 0),
            sessions: totalSessions,
          }),
        });
      }

      // Notify followers with authentication
      try {
        const earliestStart = new Date(
          Math.min(...slotsToInsert.map((s) => new Date(s.start_time).getTime()))
        );
        const latestEnd = new Date(
          Math.max(...slotsToInsert.map((s) => new Date(s.start_time).getTime()))
        );

        const { data: { session } } = await supabase.auth.getSession();
        await supabase.functions.invoke("notify-followers", {
          body: {
            slot_count: slotsToInsert.length,
            date_range: `${format(earliestStart, "MMM d")} - ${format(latestEnd, "MMM d, yyyy")}`,
          },
          headers: {
            Authorization: `Bearer ${session?.access_token}`,
          },
        });
      } catch (notifyError) {
        console.log("Failed to notify followers:", notifyError);
      }

      toast({
        title: t("calendar.slotsGenerated"),
        description: t("calendar.slotsGeneratedDescription", {
          count: slotsToInsert.length,
          total: slotsToInsert.length,
        }),
      });

      setBulkSlots([]);
      onSlotsCreated();
      onOpenChange(false);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const totalSessions = bulkSlots.reduce((acc, slot) => acc + slot.recurrenceWeeks, 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full h-full sm:w-auto sm:h-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Repeat className="h-5 w-5" />
            {t("calendar.cyclusTitle")}
          </SheetTitle>
          <SheetDescription>
            {t("calendar.cyclusDescription")}
          </SheetDescription>
        </SheetHeader>

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
                      <Select
                        value={slot.startTime}
                        onValueChange={(v) => updateBulkSlot(index, { startTime: v })}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TIME_OPTIONS.map((time) => (
                            <SelectItem key={time} value={time}>
                              {time}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                    {slot.trainerId && getHourlyRate(slot.trainerId) && (
                      <p className="text-xs text-muted-foreground">
                        {t("calendar.hourlyRate", "Hourly rate")}: {formatPrice(getHourlyRate(slot.trainerId)!)}
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">{t("calendar.pricePerSession", "Price per session")}</Label>
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
                        {slot.extraCosts.map((cost, costIndex) => (
                          <div key={costIndex} className="flex items-center gap-2">
                            <Input
                              value={cost.description}
                              onChange={(e) => {
                                const newCosts = [...slot.extraCosts];
                                newCosts[costIndex] = { ...newCosts[costIndex], description: e.target.value };
                                updateBulkSlot(index, { extraCosts: newCosts });
                              }}
                              placeholder={t("calendar.costDescription", "e.g. Court rental")}
                              className="h-8 flex-1"
                            />
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
                                className="h-8 w-20"
                              />
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                              onClick={() => {
                                const newCosts = slot.extraCosts.filter((_, i) => i !== costIndex);
                                updateBulkSlot(index, { extraCosts: newCosts.length > 0 ? newCosts : [], hasExtraCosts: newCosts.length > 0 });
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            updateBulkSlot(index, { extraCosts: [...slot.extraCosts, { description: '', price: 0 }] });
                          }}
                          className="gap-1"
                        >
                          <Plus className="h-3 w-3" />
                          {t("calendar.addCostLine", "Add cost")}
                        </Button>
                        {slot.extraCosts.length > 0 && slot.extraCosts.some(c => c.price > 0) && (
                          <p className="text-xs text-muted-foreground">
                            {t("calendar.extraCostsPerSession", "Extra costs per session")}: {formatPrice(slot.extraCosts.reduce((sum, c) => sum + (c.price || 0), 0))}
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
                            <Select
                              value={slot.selectedPlayers[playerIndex] || "none"}
                              onValueChange={(v) => {
                                const newPlayers = [...slot.selectedPlayers];
                                if (v === "none") {
                                  newPlayers[playerIndex] = "";
                                } else {
                                  newPlayers[playerIndex] = v;
                                }
                                updateBulkSlot(index, { 
                                  selectedPlayers: newPlayers 
                                });
                              }}
                            >
                              <SelectTrigger className="h-8 flex-1">
                                <SelectValue placeholder={t("calendar.selectPlayer")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">-</SelectItem>
                                {players.map((player) => (
                                  <SelectItem
                                    key={player.id}
                                    value={player.id}
                                    disabled={
                                      slot.selectedPlayers.includes(player.id) &&
                                      slot.selectedPlayers[playerIndex] !== player.id
                                    }
                                  >
                                    {player.full_name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
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
                      day: format(slot.startDate, "EEEE"),
                      time: slot.startTime,
                      startDate: format(slot.startDate, "MMM d"),
                      endDate: format(
                        addWeeks(slot.startDate, slot.recurrenceWeeks - 1),
                        "MMM d, yyyy"
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
                    slotCount: bulkSlots.length,
                    sessionCount: totalSessions,
                  })}
                </p>
              </div>
              <Button
                onClick={generateBulkSlots}
                disabled={isGenerating}
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
          trainerId={trainerId}
          onPlayerCreated={(player) => {
            setPlayers((prev) => [...prev, player].sort((a, b) => 
              a.full_name.localeCompare(b.full_name)
            ));
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
      </SheetContent>
    </Sheet>
  );
}
