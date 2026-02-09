import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format, addMinutes, setHours, setMinutes, startOfDay, isBefore, addWeeks, getDay } from "date-fns";
import { CalendarIcon, Plus, Repeat, UserPlus } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";

const TIME_OPTIONS = Array.from({ length: 24 * 2 }, (_, i) => {
  const hours = Math.floor(i / 2);
  const minutes = (i % 2) * 30;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
});

// Lesson interface removed - lessons table no longer exists

interface Trainer {
  id: string;
  name: string;
}

interface ClubAddSlotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainers: Trainer[];
  defaultTrainerId?: string;
  defaultDate?: Date;
  defaultTime?: string;
  defaultDuration: number;
  clubLocationId?: string;
  onSlotsCreated: () => void;
}

export function ClubAddSlotDialog({
  open,
  onOpenChange,
  trainers,
  defaultTrainerId,
  defaultDate,
  defaultTime,
  defaultDuration,
  clubLocationId,
  onSlotsCreated,
}: ClubAddSlotDialogProps) {
  const { t } = useTranslation("club");
  const { t: tTrainer } = useTranslation("trainer");
  const { toast } = useToast();

  const [selectedTrainerId, setSelectedTrainerId] = useState<string>(defaultTrainerId || "");
  const [slotDate, setSlotDate] = useState<Date>(defaultDate || new Date());
  const [slotTime, setSlotTime] = useState(defaultTime || "09:00");
  const [slotDuration, setSlotDuration] = useState(defaultDuration);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedTrainerId(defaultTrainerId || "");
      setSlotDate(defaultDate || new Date());
      setSlotTime(defaultTime || "09:00");
    }
  }, [open, defaultTrainerId, defaultDate, defaultTime, trainers]);

  

  const handleAddSingleSlot = async () => {
    if (!selectedTrainerId) {
      toast({
        title: t("calendar.error", "Error"),
        description: t("calendar.selectTrainerFirst", "Please select a trainer first"),
        variant: "destructive",
      });
      return;
    }
    setIsSaving(true);

    try {
      const [hours, minutes] = slotTime.split(":").map(Number);
      const startDateTime = setMinutes(setHours(slotDate, hours), minutes);
      const endDateTime = addMinutes(startDateTime, slotDuration);

      const { error } = await supabase.from("availability_slots").insert({
        trainer_id: selectedTrainerId,
        start_time: startDateTime.toISOString(),
        end_time: endDateTime.toISOString(),
        location_id: clubLocationId || null,
      });

      if (error) throw error;

      toast({ title: t("calendar.slotCreated", "Slot created successfully") });
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
            {t("calendar.addSlot", "Add Slot")}
          </DialogTitle>
          <DialogDescription>
            {t("calendar.addSlotDescription", "Create a new availability slot for a trainer")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-4">
          {/* Trainer Selection */}
          <div className="space-y-2">
            <Label>{t("calendar.selectTrainer", "Trainer")} *</Label>
            <Select value={selectedTrainerId} onValueChange={setSelectedTrainerId}>
              <SelectTrigger>
                <SelectValue placeholder={t("calendar.selectTrainerPlaceholder", "Select a trainer")} />
              </SelectTrigger>
              <SelectContent>
                {trainers.map((trainer) => (
                  <SelectItem key={trainer.id} value={trainer.id}>
                    {trainer.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date */}
          <div className="space-y-2">
            <Label>{tTrainer("calendar.date")}</Label>
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
            <Label>{tTrainer("calendar.time")}</Label>
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
            <Label>{tTrainer("calendar.duration")}</Label>
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

          <Button
            onClick={handleAddSingleSlot}
            disabled={isSaving || !selectedTrainerId}
            className="w-full"
          >
            {isSaving ? t("common.saving", "Saving...") : t("calendar.addSlot", "Add Slot")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface ClubBulkCreateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainers: Trainer[];
  defaultTrainerId?: string;
  defaultDate?: Date;
  defaultTime?: string;
  defaultDuration: number;
  defaultWeeks: number;
  clubLocationId?: string;
  onSlotsCreated: () => void;
}

interface BulkSlotConfig {
  trainerId: string;
  startDate: Date;
  startTime: string;
  durationMinutes: number;
  recurrenceWeeks: number;
  cyclusName: string;
}

export function ClubBulkCreateSheet({
  open,
  onOpenChange,
  trainers,
  defaultTrainerId,
  defaultDate,
  defaultTime,
  defaultDuration,
  defaultWeeks,
  clubLocationId,
  onSlotsCreated,
}: ClubBulkCreateSheetProps) {
  const { t } = useTranslation("club");
  const { t: tTrainer } = useTranslation("trainer");
  const { toast } = useToast();

  const [bulkSlots, setBulkSlots] = useState<BulkSlotConfig[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const getInitialStartDate = () => {
    if (defaultDate) return startOfDay(defaultDate);
    const today = new Date();
    const dayOfWeek = getDay(today);
    const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
    return startOfDay(addMinutes(today, daysUntilMonday * 24 * 60));
  };

  const getInitialStartTime = () => defaultTime || "09:00";

  const generateCyclusName = (trainerId: string, startDate: Date, startTime: string, _lessonId: string | null) => {
    if (!trainerId) return "";
    const trainer = trainers.find((t) => t.id === trainerId);
    const dayName = format(startDate, "EEEE");
    const trainerName = trainer?.name || "Trainer";
    return `${trainerName} - ${dayName} ${startTime}`;
  };

  useEffect(() => {
    if (open && defaultDate && bulkSlots.length === 0) {
      const newStartDate = getInitialStartDate();
      const newStartTime = getInitialStartTime();
      const trainerId = defaultTrainerId || "";
      setBulkSlots([
        {
          trainerId,
          startDate: newStartDate,
          startTime: newStartTime,
          durationMinutes: defaultDuration,
          recurrenceWeeks: defaultWeeks,
        cyclusName: generateCyclusName(trainerId, newStartDate, newStartTime, null),
        },
      ]);
    }
  }, [open, defaultDate]);

  const addBulkSlotConfig = () => {
    const newStartDate = getInitialStartDate();
    const newStartTime = getInitialStartTime();
    const trainerId = defaultTrainerId || "";
    setBulkSlots([
      ...bulkSlots,
      {
        trainerId,
        startDate: newStartDate,
        startTime: newStartTime,
        durationMinutes: defaultDuration,
        recurrenceWeeks: defaultWeeks,
        cyclusName: generateCyclusName(trainerId, newStartDate, newStartTime, null),
      },
    ]);
  };

  const updateBulkSlot = (index: number, updates: Partial<BulkSlotConfig>) => {
    setBulkSlots((prev) =>
      prev.map((slot, i) => {
        if (i !== index) return slot;
        const updated = { ...slot, ...updates };
        if (updates.trainerId || updates.startDate || updates.startTime) {
          updated.cyclusName = generateCyclusName(
            updates.trainerId || slot.trainerId,
            updates.startDate || slot.startDate,
            updates.startTime || slot.startTime,
            null
          );
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
    setIsGenerating(true);

    try {
      const slotsToInsert: {
        trainer_id: string;
        start_time: string;
        end_time: string;
        cyclus_id: string | null;
        cyclus_name: string | null;
        location_id: string | null;
      }[] = [];

      for (const config of bulkSlots) {
        if (!config.trainerId) continue;
        
        const [startH, startM] = config.startTime.split(":").map(Number);
        let slotStart = setMinutes(setHours(config.startDate, startH), startM);
        const cyclusId = crypto.randomUUID();

        for (let week = 0; week < config.recurrenceWeeks; week++) {
          const currentSlotStart = addWeeks(slotStart, week);
          const currentSlotEnd = addMinutes(currentSlotStart, config.durationMinutes);

          slotsToInsert.push({
            trainer_id: config.trainerId,
            start_time: currentSlotStart.toISOString(),
            end_time: currentSlotEnd.toISOString(),
            cyclus_id: cyclusId,
            cyclus_name: config.cyclusName,
            location_id: clubLocationId || null,
          });
        }
      }

      if (slotsToInsert.length === 0) {
        toast({
          title: tTrainer("calendar.noNewSlots"),
          description: tTrainer("calendar.noNewSlotsDescription"),
        });
        setIsGenerating(false);
        return;
      }

      const { error } = await supabase.from("availability_slots").insert(slotsToInsert);
      if (error) throw error;

      toast({
        title: t("calendar.slotsGenerated", "Slots Generated"),
        description: t("calendar.slotsGeneratedDescription", "{{count}} slots created successfully", { count: slotsToInsert.length }),
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
            {t("calendar.createCyclus", "Create Training Cycle")}
          </SheetTitle>
          <SheetDescription>
            {t("calendar.cyclusDescription", "Create recurring training slots for your trainers")}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 py-6">
          {bulkSlots.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Repeat className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="mb-4">{tTrainer("calendar.noCyclusConfigured")}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {bulkSlots.map((slot, index) => (
                <div key={index} className="p-4 border rounded-lg bg-muted/30 space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{tTrainer("calendar.slot")} {index + 1}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeBulkSlot(index)}
                      className="text-destructive hover:text-destructive"
                    >
                      {tTrainer("calendar.remove")}
                    </Button>
                  </div>

                  {/* Trainer Selection */}
                  <div className="space-y-1">
                    <Label className="text-xs">{t("calendar.selectTrainer", "Trainer")}</Label>
                    <Select
                      value={slot.trainerId}
                      onValueChange={(v) => updateBulkSlot(index, { trainerId: v })}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue placeholder={t("calendar.selectTrainerPlaceholder", "Select trainer")} />
                      </SelectTrigger>
                      <SelectContent>
                        {trainers.map((trainer) => (
                          <SelectItem key={trainer.id} value={trainer.id}>
                            {trainer.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {/* Start Date */}
                    <div className="space-y-1">
                      <Label className="text-xs">{tTrainer("calendar.startDate")}</Label>
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
                            onSelect={(date) => date && updateBulkSlot(index, { startDate: startOfDay(date) })}
                            initialFocus
                            className="p-3 pointer-events-auto"
                          />
                        </PopoverContent>
                      </Popover>
                    </div>

                    {/* Time */}
                    <div className="space-y-1">
                      <Label className="text-xs">{tTrainer("calendar.time")}</Label>
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
                      <Label className="text-xs">{tTrainer("calendar.duration")}</Label>
                      <Select
                        value={slot.durationMinutes.toString()}
                        onValueChange={(v) => updateBulkSlot(index, { durationMinutes: parseInt(v) })}
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
                      <Label className="text-xs">{tTrainer("calendar.repeatFor")}</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          max={52}
                          value={slot.recurrenceWeeks}
                          onChange={(e) => updateBulkSlot(index, { recurrenceWeeks: Math.max(1, Math.min(52, parseInt(e.target.value) || 1)) })}
                          className="h-8 w-20"
                        />
                        <span className="text-sm text-muted-foreground">{tTrainer("calendar.weeks")}</span>
                      </div>
                    </div>
                  </div>

                  {/* Cyclus Name */}
                  <div className="space-y-1">
                    <Label className="text-xs">{tTrainer("calendar.cyclusName")}</Label>
                    <Input
                      value={slot.cyclusName}
                      onChange={(e) => updateBulkSlot(index, { cyclusName: e.target.value })}
                      placeholder={tTrainer("calendar.cyclusNamePlaceholder")}
                      className="h-8"
                    />
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {tTrainer("calendar.recurringSummary", {
                      count: slot.recurrenceWeeks,
                      day: format(slot.startDate, "EEEE"),
                      time: slot.startTime,
                      startDate: format(slot.startDate, "MMM d"),
                      endDate: format(addWeeks(slot.startDate, slot.recurrenceWeeks - 1), "MMM d, yyyy"),
                    })}
                  </p>
                </div>
              ))}
            </div>
          )}

          <Button onClick={addBulkSlotConfig} variant="outline" className="w-full gap-2">
            <Plus className="h-4 w-4" />
            {tTrainer("calendar.addRecurringSlot")}
          </Button>

          {bulkSlots.length > 0 && (
            <div className="p-4 border rounded-lg bg-primary/5 border-primary/30 space-y-3">
              <div>
                <h4 className="font-semibold">{tTrainer("calendar.generateCycle")}</h4>
                <p className="text-sm text-muted-foreground">
                  {tTrainer("calendar.generateCycleDescription", {
                    slotCount: bulkSlots.length,
                    sessionCount: totalSessions,
                  })}
                </p>
              </div>
              <Button
                onClick={generateBulkSlots}
                disabled={isGenerating || bulkSlots.some(s => !s.trainerId)}
                className="w-full gap-2"
              >
                <Repeat className={cn("h-4 w-4", isGenerating && "animate-spin")} />
                {isGenerating ? tTrainer("calendar.generating") : tTrainer("calendar.generateSlots")}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
