import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format, addDays } from "date-fns";
import { Loader2, Calendar, Clock, MapPin, Euro, Repeat } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GuestPlayer } from "./AddPlayerDialog";

interface AvailableSlot {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  lesson: {
    id: string;
    title: string;
    price: number;
    location: string | null;
  } | null;
  spots_available: number;
}

interface QuickBookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  player: GuestPlayer;
  trainerId: string;
  onBookingCreated: () => void;
}

export function QuickBookDialog({
  open,
  onOpenChange,
  player,
  trainerId,
  onBookingCreated,
}: QuickBookDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();

  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [bookScope, setBookScope] = useState<"single" | "cyclus">("single");
  const [notes, setNotes] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [cyclusSlotCount, setCyclusSlotCount] = useState(0);

  useEffect(() => {
    if (open && trainerId) {
      fetchAvailableSlots();
      setSelectedSlotId(null);
      setNotes("");
      setBookScope("single");
    }
  }, [open, trainerId]);

  useEffect(() => {
    if (selectedSlotId) {
      const slot = slots.find((s) => s.id === selectedSlotId);
      if (slot?.cyclus_id) {
        fetchCyclusSlotCount(slot.cyclus_id);
      } else {
        setCyclusSlotCount(0);
      }
    }
  }, [selectedSlotId, slots]);

  const fetchAvailableSlots = async () => {
    setIsFetching(true);
    try {
      // Fetch slots with booking counts for next 4 weeks
      const startDate = new Date();
      const endDate = addDays(startDate, 28);

      const { data: slotsData, error } = await supabase
        .from("availability_slots")
        .select(`
          id,
          start_time,
          end_time,
          cyclus_id,
          cyclus_name,
          lessons(id, title, price, location, max_participants)
        `)
        .eq("trainer_id", trainerId)
        .gte("start_time", startDate.toISOString())
        .lte("start_time", endDate.toISOString())
        .order("start_time");

      if (error) throw error;

      // Get booking counts
      const slotIds = slotsData?.map((s) => s.id) || [];
      const { data: bookingsData } = await supabase
        .from("bookings")
        .select("slot_id")
        .in("slot_id", slotIds)
        .in("status", ["confirmed", "pending"]);

      const bookingCounts = (bookingsData || []).reduce((acc: Record<string, number>, b) => {
        acc[b.slot_id] = (acc[b.slot_id] || 0) + 1;
        return acc;
      }, {});

      // Filter to available slots
      const available = (slotsData || [])
        .map((slot) => {
          const maxParticipants = (slot.lessons as any)?.max_participants || 1;
          const booked = bookingCounts[slot.id] || 0;
          return {
            id: slot.id,
            start_time: slot.start_time,
            end_time: slot.end_time,
            cyclus_id: slot.cyclus_id,
            cyclus_name: slot.cyclus_name,
            lesson: slot.lessons as AvailableSlot["lesson"],
            spots_available: maxParticipants - booked,
          };
        })
        .filter((s) => s.spots_available > 0);

      setSlots(available);
    } catch (error) {
      console.error("Error fetching slots:", error);
    } finally {
      setIsFetching(false);
    }
  };

  const fetchCyclusSlotCount = async (cyclusId: string) => {
    const { count } = await supabase
      .from("availability_slots")
      .select("id", { count: "exact" })
      .eq("cyclus_id", cyclusId)
      .gte("start_time", new Date().toISOString());

    setCyclusSlotCount(count || 0);
  };

  const handleBook = async () => {
    if (!selectedSlotId) return;

    setIsLoading(true);
    try {
      const selectedSlot = slots.find((s) => s.id === selectedSlotId);
      if (!selectedSlot) throw new Error("Slot not found");

      let slotsToBook = [selectedSlot];

      // If booking entire cyclus
      if (bookScope === "cyclus" && selectedSlot.cyclus_id) {
        const { data: cyclusSlots, error } = await supabase
          .from("availability_slots")
          .select("id, start_time, end_time, lesson_id")
          .eq("cyclus_id", selectedSlot.cyclus_id)
          .gte("start_time", new Date().toISOString())
          .order("start_time");

        if (error) throw error;

        slotsToBook = (cyclusSlots || []).map((cs) => ({
          ...selectedSlot,
          id: cs.id,
          start_time: cs.start_time,
          end_time: cs.end_time,
        }));
      }

      // Create bookings
      const bookingsToInsert = slotsToBook.map((slot) => ({
        slot_id: slot.id,
        guest_player_id: player.id,
        lesson_id: selectedSlot.lesson?.id || null,
        status: "confirmed",
        payment_status: "pending",
        notes: notes || null,
      }));

      const { error: insertError } = await supabase
        .from("bookings")
        .insert(bookingsToInsert);

      if (insertError) throw insertError;

      toast({
        title: t("bookings.bookingCreated"),
        description: t("bookings.bookingCreatedDescription", { count: slotsToBook.length }),
      });

      onBookingCreated();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Error creating booking:", error);
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const selectedSlot = slots.find((s) => s.id === selectedSlotId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t("bookings.quickBook", "Quick Book")}</DialogTitle>
          <DialogDescription>
            {t("bookings.quickBookDescription", "Book a lesson for {{name}}", { name: player.full_name })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Slot selection */}
          <div className="space-y-2">
            <Label>{t("bookings.selectSlot", "Select a time slot")}</Label>
            {isFetching ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : slots.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>{t("bookings.noSlotsAvailable", "No available slots in the next 4 weeks")}</p>
              </div>
            ) : (
              <ScrollArea className="h-[250px] border rounded-lg">
                <RadioGroup
                  value={selectedSlotId || ""}
                  onValueChange={setSelectedSlotId}
                  className="p-2 space-y-2"
                >
                  {slots.map((slot) => (
                    <label
                      key={slot.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        selectedSlotId === slot.id
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted"
                      }`}
                    >
                      <RadioGroupItem value={slot.id} className="mt-1" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 font-medium">
                          <Calendar className="h-4 w-4 text-muted-foreground" />
                          {format(new Date(slot.start_time), "EEE, MMM d")}
                          <span className="text-muted-foreground">•</span>
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          {format(new Date(slot.start_time), "HH:mm")}
                        </div>
                        {slot.lesson && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                            <span>{slot.lesson.title}</span>
                            <Badge variant="secondary" className="text-xs">
                              €{slot.lesson.price}
                            </Badge>
                            {slot.lesson.location && (
                              <>
                                <MapPin className="h-3 w-3" />
                                <span>{slot.lesson.location}</span>
                              </>
                            )}
                          </div>
                        )}
                        {slot.cyclus_name && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                            <Repeat className="h-3 w-3" />
                            {slot.cyclus_name}
                          </div>
                        )}
                      </div>
                      <Badge variant="outline" className="text-xs">
                        {slot.spots_available} {t("calendar.spotsLeft", { count: slot.spots_available }).split(" ").slice(1).join(" ")}
                      </Badge>
                    </label>
                  ))}
                </RadioGroup>
              </ScrollArea>
            )}
          </div>

          {/* Cyclus booking option */}
          {selectedSlot?.cyclus_id && cyclusSlotCount > 1 && (
            <div className="space-y-2">
              <Label>{t("calendar.bookingScope")}</Label>
              <RadioGroup
                value={bookScope}
                onValueChange={(v) => setBookScope(v as "single" | "cyclus")}
                className="space-y-2"
              >
                <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${bookScope === "single" ? "border-primary bg-primary/5" : ""}`}>
                  <RadioGroupItem value="single" />
                  <span>{t("calendar.singleSlot")}</span>
                </label>
                <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${bookScope === "cyclus" ? "border-primary bg-primary/5" : ""}`}>
                  <RadioGroupItem value="cyclus" />
                  <div>
                    <span>{t("calendar.entireCyclus")}</span>
                    <p className="text-xs text-muted-foreground">
                      {t("calendar.entireCyclusDescription", { count: cyclusSlotCount })}
                    </p>
                  </div>
                </label>
              </RadioGroup>
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label>{t("bookings.notes")}</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("bookings.notesPlaceholder")}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleBook} disabled={isLoading || !selectedSlotId}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {bookScope === "cyclus" && cyclusSlotCount > 1
              ? t("bookings.bookCyclus", "Book {{count}} Sessions", { count: cyclusSlotCount })
              : t("bookings.confirmBooking")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
