import { useState, useEffect } from "react";
import { TIME_OPTIONS } from '@/lib/timeOptions';
import { useTranslation } from "react-i18next";
import { format, addMinutes, setHours, setMinutes, startOfDay, isBefore } from "date-fns";
import { CalendarIcon, Plus, Repeat, GraduationCap, User } from "lucide-react";
import { insertAvailabilitySlots } from "@/lib/slots";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { getFriendlyErrorMessage } from "@/lib/friendlyError";
import { SlotLocationPicker, type SlotLocation } from "@/components/slots/SlotLocationPicker";
import { SlotRatingPicker } from "@/components/slots/SlotRatingPicker";
import { getTrainerAcademy, type AcademyProfile } from "@/lib/academy";
import { useTrainerRatingSystem } from "@/hooks/useTrainerRatingSystem";
import { BulkCreateContent, type BulkCreateContentProps } from "./BulkCreateContent";


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
  academyId?: string;
}

export function AddSlotDialog({
  open,
  onOpenChange,
  trainerId,
  defaultDate,
  defaultTime,
  defaultDuration,
  defaultWeeks: _defaultWeeks,
  onSlotsCreated,
  availableLocations,
  academyId: _academyId,
}: AddSlotDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();
  const { trainerRatingSystem } = useTrainerRatingSystem(trainerId || undefined);

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
  const [pricesIncludeVat] = useState(true);

  // Sync date/time when dialog opens with new defaults (e.g. clicking a calendar cell)
  useEffect(() => {
    if (open) {
      if (defaultDate) setSlotDate(defaultDate);
      if (defaultTime) setSlotTime(defaultTime);
    }
  }, [open, defaultDate, defaultTime]);

  // Fetch trainer's academy affiliation and auto-set academy ID
  useEffect(() => {
    async function fetchAcademy() {
      if (!trainerId) return;
      const academy = await getTrainerAcademy(trainerId);
      setTrainerAcademy(academy);
      if (academy?.id) {
        setSlotAcademyId(academy.id);
      }
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

      const { error } = await insertAvailabilitySlots({
        trainer_id: trainerId,
        start_time: startDateTime.toISOString(),
        end_time: endDateTime.toISOString(),
        court_type: slotCourtType,
        location_id: slotLocationId,
        academy_profile_id: slotAcademyId,
        rating_system: slotRatingSystem,
        min_rating: slotMinRating,
        max_rating: slotMaxRating,
        prices_include_vat: pricesIncludeVat,
      });

      if (error) throw error;

      toast({ title: t("calendar.slotCreated") });
      onSlotsCreated();
      onOpenChange(false);
    } catch (error: any) {
      toast({
        title: "Error",
        description: getFriendlyErrorMessage(error, t("calendar.slotCreateError", "Could not create the slot. Please try again.")),
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

          {/* Rating Level */}
          <SlotRatingPicker
            ratingSystem={slotRatingSystem}
            minRating={slotMinRating}
            maxRating={slotMaxRating}
            onChange={(vals) => {
              setSlotRatingSystem(vals.ratingSystem);
              setSlotMinRating(vals.minRating);
              setSlotMaxRating(vals.maxRating);
            }}
            fixedRatingSystem={trainerRatingSystem}
          />

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

interface BulkCreateSheetProps extends BulkCreateContentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BulkCreateSheet({
  open,
  onOpenChange,
  ...contentProps
}: BulkCreateSheetProps) {
  const { t } = useTranslation("trainer");
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
        <BulkCreateContent
          {...contentProps}
          isActive={open}
          onClose={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

// BulkCreateContent now lives in its own file; re-export so by-name importers are untouched.
export { BulkCreateContent };
export type { BulkCreateContentProps };

