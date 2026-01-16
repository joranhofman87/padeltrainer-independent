import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format, addWeeks, parseISO } from "date-fns";
import { toast } from "sonner";
import { Copy, Repeat, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { CalendarIcon } from "lucide-react";

interface CyclusInfo {
  cyclus_id: string;
  cyclus_name: string;
  slot_count: number;
  first_slot: string;
  last_slot: string;
  booking_count: number;
}

interface DuplicateCyclusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string;
  preselectedCyclusId?: string;
  onCyclusCreated: () => void;
}

export function DuplicateCyclusDialog({
  open,
  onOpenChange,
  trainerId,
  preselectedCyclusId,
  onCyclusCreated,
}: DuplicateCyclusDialogProps) {
  const { t } = useTranslation("trainer");
  const [cyclusList, setCyclusList] = useState<CyclusInfo[]>([]);
  const [selectedCyclusId, setSelectedCyclusId] = useState<string>("");
  const [newStartDate, setNewStartDate] = useState<Date | undefined>();
  const [numberOfSessions, setNumberOfSessions] = useState<number>(8);
  const [includeExistingPlayers, setIncludeExistingPlayers] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);

  useEffect(() => {
    if (open) {
      fetchCyclusList();
    }
  }, [open, trainerId]);

  useEffect(() => {
    if (preselectedCyclusId && cyclusList.length > 0) {
      setSelectedCyclusId(preselectedCyclusId);
      const cyclus = cyclusList.find((c) => c.cyclus_id === preselectedCyclusId);
      if (cyclus) {
        setNumberOfSessions(cyclus.slot_count);
        // Default new start date to one week after last slot
        setNewStartDate(addWeeks(parseISO(cyclus.last_slot), 1));
      }
    }
  }, [preselectedCyclusId, cyclusList]);

  const fetchCyclusList = async () => {
    setIsFetching(true);
    try {
      // Fetch cyclus info with booking counts
      const { data: slots, error } = await supabase
        .from("availability_slots")
        .select(`
          cyclus_id,
          cyclus_name,
          start_time,
          bookings(id)
        `)
        .eq("trainer_id", trainerId)
        .not("cyclus_id", "is", null);

      if (error) throw error;

      // Group by cyclus_id
      const cyclusMap = new Map<string, CyclusInfo>();
      slots?.forEach((slot) => {
        if (!slot.cyclus_id) return;
        
        const existing = cyclusMap.get(slot.cyclus_id);
        const slotTime = slot.start_time;
        const bookingCount = slot.bookings?.length || 0;

        if (existing) {
          existing.slot_count++;
          existing.booking_count += bookingCount;
          if (slotTime < existing.first_slot) existing.first_slot = slotTime;
          if (slotTime > existing.last_slot) existing.last_slot = slotTime;
        } else {
          cyclusMap.set(slot.cyclus_id, {
            cyclus_id: slot.cyclus_id,
            cyclus_name: slot.cyclus_name || "Unnamed Cyclus",
            slot_count: 1,
            first_slot: slotTime,
            last_slot: slotTime,
            booking_count: bookingCount,
          });
        }
      });

      const list = Array.from(cyclusMap.values()).sort(
        (a, b) => new Date(b.first_slot).getTime() - new Date(a.first_slot).getTime()
      );
      setCyclusList(list);
    } catch (error) {
      console.error("Error fetching cyclus list:", error);
      toast.error("Failed to load training cycles");
    } finally {
      setIsFetching(false);
    }
  };

  const selectedCyclus = cyclusList.find((c) => c.cyclus_id === selectedCyclusId);

  const handleDuplicate = async () => {
    if (!selectedCyclusId || !newStartDate || !trainerId) {
      toast.error("Please fill in all required fields");
      return;
    }

    setIsLoading(true);
    try {
      // Fetch original cyclus slots with their bookings
      const { data: originalSlots, error: slotsError } = await supabase
        .from("availability_slots")
        .select(`
          *,
          bookings(
            id,
            player_id,
            guest_player_id,
            notes
          )
        `)
        .eq("cyclus_id", selectedCyclusId)
        .order("start_time", { ascending: true });

      if (slotsError) throw slotsError;
      if (!originalSlots?.length) {
        toast.error("No slots found in the selected cycle");
        return;
      }

      // Calculate date offset
      const firstSlotDate = parseISO(originalSlots[0].start_time);
      const dateOffsetMs = newStartDate.getTime() - firstSlotDate.getTime();

      // Generate new cyclus ID and name
      const newCyclusId = crypto.randomUUID();
      const newCyclusName = `${selectedCyclus?.cyclus_name || "Cyclus"} (${format(newStartDate, "MMM d")})`;

      // Create new slots (limited to numberOfSessions)
      const slotsToCreate = originalSlots.slice(0, numberOfSessions).map((slot) => {
        const originalStart = parseISO(slot.start_time);
        const originalEnd = parseISO(slot.end_time);
        
        return {
          trainer_id: trainerId,
          start_time: new Date(originalStart.getTime() + dateOffsetMs).toISOString(),
          end_time: new Date(originalEnd.getTime() + dateOffsetMs).toISOString(),
          lesson_id: slot.lesson_id,
          cyclus_id: newCyclusId,
          cyclus_name: newCyclusName,
          is_recurring: false,
        };
      });

      const { data: newSlots, error: insertError } = await supabase
        .from("availability_slots")
        .insert(slotsToCreate)
        .select();

      if (insertError) throw insertError;

      // If including existing players, create bookings
      if (includeExistingPlayers && newSlots) {
        const bookingsToCreate: Array<{
          slot_id: string;
          player_id?: string | null;
          guest_player_id?: string | null;
          notes?: string | null;
          status: string;
          payment_status: string;
        }> = [];

        // Map original slots to new slots by index
        originalSlots.slice(0, numberOfSessions).forEach((originalSlot, index) => {
          const newSlot = newSlots[index];
          if (!newSlot || !originalSlot.bookings) return;

          originalSlot.bookings.forEach((booking) => {
            bookingsToCreate.push({
              slot_id: newSlot.id,
              player_id: booking.player_id,
              guest_player_id: booking.guest_player_id,
              notes: booking.notes,
              status: "confirmed",
              payment_status: "pending",
            });
          });
        });

        if (bookingsToCreate.length > 0) {
          const { error: bookingsError } = await supabase
            .from("bookings")
            .insert(bookingsToCreate);

          if (bookingsError) {
            console.error("Error copying bookings:", bookingsError);
            // Don't fail completely, just warn
            toast.warning("Cyclus created but some bookings could not be copied");
          }
        }
      }

      toast.success(t("calendar.cyclusDuplicated"));
      onCyclusCreated();
      onOpenChange(false);
      
      // Reset form
      setSelectedCyclusId("");
      setNewStartDate(undefined);
      setNumberOfSessions(8);
      setIncludeExistingPlayers(true);
    } catch (error) {
      console.error("Error duplicating cyclus:", error);
      toast.error("Failed to duplicate cycle");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-5 w-5" />
            {t("calendar.duplicateCyclusTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("calendar.duplicateCyclusDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Cyclus Selection */}
          <div className="space-y-2">
            <Label>{t("calendar.selectCyclus")}</Label>
            <Select value={selectedCyclusId} onValueChange={setSelectedCyclusId}>
              <SelectTrigger>
                <SelectValue placeholder={isFetching ? "Loading..." : t("calendar.selectCyclus")} />
              </SelectTrigger>
              <SelectContent>
                {cyclusList.length === 0 ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    {t("calendar.noExistingCyclus")}
                  </div>
                ) : (
                  cyclusList.map((cyclus) => (
                    <SelectItem key={cyclus.cyclus_id} value={cyclus.cyclus_id}>
                      <div className="flex items-center gap-2">
                        <Repeat className="h-3 w-3 text-muted-foreground" />
                        <span>{cyclus.cyclus_name}</span>
                        <span className="text-xs text-muted-foreground">
                          ({cyclus.slot_count} sessions)
                        </span>
                      </div>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* New Start Date */}
          <div className="space-y-2">
            <Label>{t("calendar.newStartDate")}</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !newStartDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {newStartDate ? format(newStartDate, "PPP") : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={newStartDate}
                  onSelect={setNewStartDate}
                  disabled={(date) => date < new Date()}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Number of Sessions */}
          <div className="space-y-2">
            <Label>{t("calendar.numberOfSessions")}</Label>
            <Input
              type="number"
              min={1}
              max={52}
              value={numberOfSessions}
              onChange={(e) => setNumberOfSessions(parseInt(e.target.value) || 1)}
            />
          </div>

          {/* Include Existing Players */}
          {selectedCyclus && selectedCyclus.booking_count > 0 && (
            <div className="flex items-start space-x-3 p-3 rounded-lg bg-muted/50">
              <Checkbox
                id="includeExistingPlayers"
                checked={includeExistingPlayers}
                onCheckedChange={(checked) => setIncludeExistingPlayers(checked === true)}
              />
              <div className="space-y-1">
                <Label
                  htmlFor="includeExistingPlayers"
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Users className="h-4 w-4" />
                  {t("calendar.includeExistingPlayers")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("calendar.includePlayersDescription", {
                    count: selectedCyclus.booking_count,
                  })}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button
            onClick={handleDuplicate}
            disabled={isLoading || !selectedCyclusId || !newStartDate}
          >
            {isLoading ? "Creating..." : t("calendar.duplicateCyclus")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
