import { useState } from "react";
import { useTranslation } from "react-i18next";
import { format, addMinutes, setHours, setMinutes, startOfDay, isBefore, addWeeks, getDay } from "date-fns";
import { CalendarIcon, Plus, Repeat } from "lucide-react";
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
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

const TIME_OPTIONS = Array.from({ length: 24 * 2 }, (_, i) => {
  const hours = Math.floor(i / 2);
  const minutes = (i % 2) * 30;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
});

interface Lesson {
  id: string;
  title: string;
}

interface BulkSlotConfig {
  startDate: Date;
  startTime: string;
  durationMinutes: number;
  recurrenceWeeks: number;
  lessonId: string | null;
}

interface AddSlotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string | null;
  lessons: Lesson[];
  defaultDate?: Date;
  defaultTime?: string;
  defaultDuration: number;
  defaultWeeks: number;
  onSlotsCreated: () => void;
}

export function AddSlotDialog({
  open,
  onOpenChange,
  trainerId,
  lessons,
  defaultDate,
  defaultTime,
  defaultDuration,
  defaultWeeks,
  onSlotsCreated,
}: AddSlotDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();

  const [slotDate, setSlotDate] = useState<Date>(defaultDate || new Date());
  const [slotTime, setSlotTime] = useState(defaultTime || "09:00");
  const [slotDuration, setSlotDuration] = useState(defaultDuration);
  const [slotLessonId, setSlotLessonId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

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
        lesson_id: slotLessonId,
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

          {/* Lesson */}
          <div className="space-y-2">
            <Label>{t("calendar.linkLesson")}</Label>
            <Select
              value={slotLessonId || "none"}
              onValueChange={(v) => setSlotLessonId(v === "none" ? null : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="No lesson linked" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("calendar.noLesson")}</SelectItem>
                {lessons.map((lesson) => (
                  <SelectItem key={lesson.id} value={lesson.id}>
                    {lesson.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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

interface BulkCreateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string | null;
  lessons: Lesson[];
  defaultDuration: number;
  defaultWeeks: number;
  onSlotsCreated: () => void;
}

export function BulkCreateSheet({
  open,
  onOpenChange,
  trainerId,
  lessons,
  defaultDuration,
  defaultWeeks,
  onSlotsCreated,
}: BulkCreateSheetProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();

  const [bulkSlots, setBulkSlots] = useState<BulkSlotConfig[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const getNextMonday = () => {
    const today = new Date();
    const dayOfWeek = getDay(today);
    const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
    return startOfDay(addMinutes(today, daysUntilMonday * 24 * 60));
  };

  const addBulkSlotConfig = () => {
    setBulkSlots([
      ...bulkSlots,
      {
        startDate: getNextMonday(),
        startTime: "09:00",
        durationMinutes: defaultDuration,
        recurrenceWeeks: defaultWeeks,
        lessonId: null,
      },
    ]);
  };

  const updateBulkSlot = (index: number, updates: Partial<BulkSlotConfig>) => {
    setBulkSlots((prev) =>
      prev.map((slot, i) => (i === index ? { ...slot, ...updates } : slot))
    );
  };

  const removeBulkSlot = (index: number) => {
    setBulkSlots((prev) => prev.filter((_, i) => i !== index));
  };

  const generateBulkSlots = async () => {
    if (!trainerId || bulkSlots.length === 0) return;
    setIsGenerating(true);

    try {
      const today = startOfDay(new Date());
      const slotsToInsert: {
        trainer_id: string;
        start_time: string;
        end_time: string;
        lesson_id: string | null;
        is_recurring: boolean;
        recurrence_rule: string | null;
      }[] = [];

      // Get existing slots to avoid duplicates
      const { data: existingSlots } = await supabase
        .from("availability_slots")
        .select("start_time")
        .eq("trainer_id", trainerId)
        .gte("start_time", today.toISOString());

      const existingTimes = new Set(existingSlots?.map((s) => s.start_time) || []);

      for (const config of bulkSlots) {
        const [startH, startM] = config.startTime.split(":").map(Number);
        let slotStart = setMinutes(setHours(config.startDate, startH), startM);

        // Skip if in the past
        if (isBefore(slotStart, today)) {
          const weeksToAdd = Math.ceil(
            (today.getTime() - slotStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
          );
          slotStart = addWeeks(slotStart, weeksToAdd);
        }

        const endDate = addWeeks(config.startDate, config.recurrenceWeeks);

        if (existingTimes.has(slotStart.toISOString())) {
          continue;
        }

        const weeksRemaining = Math.max(
          1,
          Math.ceil((endDate.getTime() - slotStart.getTime()) / (7 * 24 * 60 * 60 * 1000))
        );
        const recurrenceEndDate = format(endDate, "yyyy-MM-dd");

        slotsToInsert.push({
          trainer_id: trainerId,
          start_time: slotStart.toISOString(),
          end_time: addMinutes(slotStart, config.durationMinutes).toISOString(),
          lesson_id: config.lessonId,
          is_recurring: weeksRemaining > 1,
          recurrence_rule:
            weeksRemaining > 1
              ? `FREQ=WEEKLY;COUNT=${weeksRemaining};UNTIL=${recurrenceEndDate}`
              : null,
        });
      }

      if (slotsToInsert.length === 0) {
        toast({
          title: t("calendar.noNewSlots"),
          description: t("calendar.noNewSlotsDescription"),
        });
        setIsGenerating(false);
        return;
      }

      const { error } = await supabase.from("availability_slots").insert(slotsToInsert);
      if (error) throw error;

      const totalInstances = slotsToInsert.reduce((acc, slot) => {
        if (slot.is_recurring && slot.recurrence_rule) {
          const countMatch = slot.recurrence_rule.match(/COUNT=(\d+)/);
          return acc + (countMatch ? parseInt(countMatch[1]) : 1);
        }
        return acc + 1;
      }, 0);

      // Notify followers
      try {
        const earliestStart = new Date(
          Math.min(...slotsToInsert.map((s) => new Date(s.start_time).getTime()))
        );
        const latestEnd = new Date(
          Math.max(...bulkSlots.map((c) => addWeeks(c.startDate, c.recurrenceWeeks).getTime()))
        );

        await supabase.functions.invoke("notify-followers", {
          body: {
            trainer_id: trainerId,
            slot_count: totalInstances,
            date_range: `${format(earliestStart, "MMM d")} - ${format(latestEnd, "MMM d, yyyy")}`,
          },
        });
      } catch (notifyError) {
        console.log("Failed to notify followers:", notifyError);
      }

      toast({
        title: t("calendar.slotsGenerated"),
        description: t("calendar.slotsGeneratedDescription", {
          count: slotsToInsert.length,
          total: totalInstances,
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
      <SheetContent className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Repeat className="h-5 w-5" />
            {t("calendar.bulkCreateTitle")}
          </SheetTitle>
          <SheetDescription>
            {t("calendar.bulkCreateDescription")}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 py-6">
          {bulkSlots.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Repeat className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="mb-4">{t("calendar.noSlotsConfigured")}</p>
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
                            disabled={(date) => isBefore(date, startOfDay(new Date()))}
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
                      <Select
                        value={slot.recurrenceWeeks.toString()}
                        onValueChange={(v) =>
                          updateBulkSlot(index, { recurrenceWeeks: parseInt(v) })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[1, 2, 4, 6, 8, 10, 12].map((weeks) => (
                            <SelectItem key={weeks} value={weeks.toString()}>
                              {weeks} {t("calendar.weeks")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Lesson */}
                  <div className="space-y-1">
                    <Label className="text-xs">{t("calendar.linkLesson")}</Label>
                    <Select
                      value={slot.lessonId || "none"}
                      onValueChange={(v) =>
                        updateBulkSlot(index, { lessonId: v === "none" ? null : v })
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t("calendar.noLesson")}</SelectItem>
                        {lessons.map((lesson) => (
                          <SelectItem key={lesson.id} value={lesson.id}>
                            {lesson.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

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
      </SheetContent>
    </Sheet>
  );
}
