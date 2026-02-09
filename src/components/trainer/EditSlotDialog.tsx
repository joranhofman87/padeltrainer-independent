import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { CalendarIcon, Clock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { logger } from '@/lib/logger';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
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
import { SlotWithBookings } from "./CalendarSlotCard";

interface EditSlotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slot: SlotWithBookings | null;
  onSlotUpdated: () => void;
}

export function EditSlotDialog({
  open,
  onOpenChange,
  slot,
  onSlotUpdated,
}: EditSlotDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();

  const [date, setDate] = useState<Date | undefined>();
  const [startTime, setStartTime] = useState("09:00");
  const [durationMinutes, setDurationMinutes] = useState(60);
  
  const [cyclusName, setCyclusName] = useState("");
  const [applyToCyclus, setApplyToCyclus] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (slot && open) {
      const slotDate = new Date(slot.start_time);
      setDate(slotDate);
      setStartTime(format(slotDate, "HH:mm"));
      
      const start = new Date(slot.start_time);
      const end = new Date(slot.end_time);
      const duration = Math.round((end.getTime() - start.getTime()) / 60000);
      setDurationMinutes(duration);
      
      
      setCyclusName(slot.cyclus_name || "");
      setApplyToCyclus(false);
    }
  }, [slot, open]);

  const handleSave = async () => {
    if (!slot || !date) return;

    setIsLoading(true);
    try {
      const [hours, minutes] = startTime.split(":").map(Number);
      const startDateTime = new Date(date);
      startDateTime.setHours(hours, minutes, 0, 0);

      const endDateTime = new Date(startDateTime);
      endDateTime.setMinutes(endDateTime.getMinutes() + durationMinutes);

      // Check if slot is in the past
      if (startDateTime < new Date()) {
        toast({
          title: t("common:error"),
          description: t("calendar.slotInPast", "Cannot set slot time in the past"),
          variant: "destructive",
        });
        setIsLoading(false);
        return;
      }

      if (applyToCyclus && slot.cyclus_id) {
        // Apply changes to all future slots in cyclus
        const { data: cyclusSlots, error: fetchError } = await supabase
          .from("availability_slots")
          .select("id, start_time, end_time")
          .eq("cyclus_id", slot.cyclus_id)
          .gte("start_time", new Date().toISOString())
          .order("start_time");

        if (fetchError) throw fetchError;

        if (cyclusSlots && cyclusSlots.length > 0) {
          // Calculate time offset from original slot
          const originalStart = new Date(slot.start_time);
          const timeOfDayDiff = 
            (hours * 60 + minutes) - 
            (originalStart.getHours() * 60 + originalStart.getMinutes());

          // Update each slot
          for (const cs of cyclusSlots) {
            const csStart = new Date(cs.start_time);
            csStart.setMinutes(csStart.getMinutes() + timeOfDayDiff);
            
            const csEnd = new Date(csStart);
            csEnd.setMinutes(csEnd.getMinutes() + durationMinutes);

            await supabase
              .from("availability_slots")
              .update({
                start_time: csStart.toISOString(),
                end_time: csEnd.toISOString(),
                cyclus_name: cyclusName || null,
              })
              .eq("id", cs.id);
          }

          toast({
            title: t("calendar.cyclusUpdated", "Cyclus updated"),
            description: t("calendar.cyclusUpdatedDescription", "Updated {{count}} slots in the cyclus", { count: cyclusSlots.length }),
          });
        }
      } else {
        // Update single slot
        const { error } = await supabase
          .from("availability_slots")
          .update({
            start_time: startDateTime.toISOString(),
            end_time: endDateTime.toISOString(),
            cyclus_name: cyclusName || null,
          })
          .eq("id", slot.id);

        if (error) throw error;

        toast({
          title: t("calendar.slotUpdated", "Slot updated"),
          description: t("calendar.slotUpdatedDescription", "The time slot has been updated"),
        });
      }

      onSlotUpdated();
      onOpenChange(false);
    } catch (error: any) {
      logger.error('Error updating slot', error as Error, { component: 'EditSlotDialog' });
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (!slot) return null;

  const hasBookings = slot.active_bookings > 0 || slot.pending_bookings > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t("calendar.editSlot", "Edit Time Slot")}</DialogTitle>
          <DialogDescription>
            {t("calendar.editSlotDescription", "Modify the details of this time slot")}
          </DialogDescription>
        </DialogHeader>

        {hasBookings && (
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3 text-sm">
            <p className="text-yellow-800 dark:text-yellow-200">
              ⚠️ {t("calendar.slotHasBookings", "This slot has {{count}} booking(s). They will be preserved.", { count: slot.active_bookings + slot.pending_bookings })}
            </p>
          </div>
        )}

        <div className="space-y-4 py-4">
          {/* Date */}
          <div className="space-y-2">
            <Label>{t("calendar.date")}</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !date && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {date ? format(date, "PPP") : t("calendar.selectDate", "Select date")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar
                  mode="single"
                  selected={date}
                  onSelect={setDate}
                  disabled={(d) => d < new Date()}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Time */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("calendar.time")}</Label>
              <div className="relative">
                <Clock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("calendar.duration")}</Label>
              <Select
                value={String(durationMinutes)}
                onValueChange={(v) => setDurationMinutes(Number(v))}
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
          </div>


          {/* Cyclus Name */}
          {slot.cyclus_id && (
            <div className="space-y-2">
              <Label>{t("calendar.cyclusName")}</Label>
              <Input
                value={cyclusName}
                onChange={(e) => setCyclusName(e.target.value)}
                placeholder={t("calendar.cyclusNamePlaceholder")}
              />
            </div>
          )}

          {/* Apply to cyclus */}
          {slot.cyclus_id && (
            <div className="flex items-center space-x-2 pt-2">
              <Checkbox
                id="apply-cyclus"
                checked={applyToCyclus}
                onCheckedChange={(c) => setApplyToCyclus(!!c)}
              />
              <Label htmlFor="apply-cyclus" className="text-sm font-normal cursor-pointer">
                {t("calendar.applyToCyclus", "Apply time change to all future slots in this cyclus")}
              </Label>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSave} disabled={isLoading || !date}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("common:save", "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
