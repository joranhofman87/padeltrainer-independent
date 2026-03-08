import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format, addDays, differenceInMinutes } from "date-fns";
import { Loader2, Calendar, Clock, MapPin, Euro, Repeat, Percent, ChevronDown } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { GuestPlayer } from "./AddPlayerDialog";
import { cn } from "@/lib/utils";
import { calculateSlotPrice, applyDiscount, formatPrice } from "@/lib/pricing";

interface AvailableSlot {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  max_participants: number;
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
  const [cyclusSlots, setCyclusSlots] = useState<{ id: string; start_time: string; end_time: string }[]>([]);
  const [hourlyRate, setHourlyRate] = useState<number>(50);
  
  // Discount state
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountType, setDiscountType] = useState<"percentage" | "fixed">("percentage");
  const [discountValue, setDiscountValue] = useState<number>(0);
  const [discountReason, setDiscountReason] = useState("");

  useEffect(() => {
    if (open && trainerId) {
      fetchAvailableSlots();
      fetchHourlyRate();
      setSelectedSlotId(null);
      setNotes("");
      setBookScope("single");
      setShowDiscount(false);
      setDiscountType("percentage");
      setDiscountValue(0);
      setDiscountReason("");
    }
  }, [open, trainerId]);

  const fetchHourlyRate = async () => {
    try {
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("hourly_rate")
        .eq("id", trainerId)
        .single();
      
      if (error) throw error;
      if (data?.hourly_rate) {
        setHourlyRate(data.hourly_rate);
      }
    } catch (error) {
      logger.error("Error fetching hourly rate", error as Error, { component: 'QuickBookDialog' });
    }
  };

  useEffect(() => {
    if (selectedSlotId) {
      const slot = slots.find((s) => s.id === selectedSlotId);
      if (slot?.cyclus_id) {
        fetchCyclusSlots(slot.cyclus_id);
      } else {
        setCyclusSlotCount(0);
        setCyclusSlots([]);
      }
    }
  }, [selectedSlotId, slots]);

  const fetchCyclusSlots = async (cyclusId: string) => {
    const { data } = await supabase
      .from("availability_slots")
      .select("id, start_time, end_time")
      .eq("cyclus_id", cyclusId)
      .gte("start_time", new Date().toISOString())
      .order("start_time");

    setCyclusSlots(data || []);
    setCyclusSlotCount(data?.length || 0);
  };

  const fetchAvailableSlots = async () => {
    setIsFetching(true);
    try {
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
          max_participants
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

      const available = (slotsData || [])
        .map((slot) => {
          const maxParticipants = (slot as any).max_participants || 4;
          const booked = bookingCounts[slot.id] || 0;
          return {
            id: slot.id,
            start_time: slot.start_time,
            end_time: slot.end_time,
            cyclus_id: slot.cyclus_id,
            cyclus_name: slot.cyclus_name,
            max_participants: maxParticipants,
            spots_available: maxParticipants - booked,
          };
        })
        .filter((s) => s.spots_available > 0);

      setSlots(available);
    } catch (error) {
      logger.error("Error fetching slots", error as Error, { component: 'QuickBookDialog' });
    } finally {
      setIsFetching(false);
    }
  };

  // Calculate pricing
  const selectedSlot = slots.find((s) => s.id === selectedSlotId);
  const slotDurationMinutes = selectedSlot 
    ? differenceInMinutes(new Date(selectedSlot.end_time), new Date(selectedSlot.start_time))
    : 60;
  const pricePerSession = calculateSlotPrice(hourlyRate, slotDurationMinutes);
  const sessionsCount = bookScope === "cyclus" && cyclusSlotCount > 1 ? cyclusSlotCount : 1;
  const subtotal = pricePerSession * sessionsCount;
  const { finalAmount, discountAmount: calculatedDiscount } = applyDiscount(subtotal, discountType, discountValue);

  const handleBook = async () => {
    if (!selectedSlotId || !selectedSlot) return;

    setIsLoading(true);
    try {
      let slotsToBook = bookScope === "cyclus" && selectedSlot.cyclus_id && cyclusSlots.length > 0
        ? cyclusSlots
        : [{ id: selectedSlot.id, start_time: selectedSlot.start_time, end_time: selectedSlot.end_time }];

      const bookingsToInsert = slotsToBook.map((slot, index) => {
        const slotDuration = differenceInMinutes(new Date(slot.end_time), new Date(slot.start_time));
        const slotPrice = calculateSlotPrice(hourlyRate, slotDuration);
        const isFirstSlot = index === 0;
        
        return {
          slot_id: slot.id,
          guest_player_id: player.id,
          status: "confirmed",
          payment_status: "pending",
          original_amount: slotPrice,
          discount_amount: isFirstSlot ? calculatedDiscount : 0,
          discount_reason: isFirstSlot && discountReason ? discountReason : null,
          payment_amount: slotPrice - (isFirstSlot ? calculatedDiscount / slotsToBook.length : 0),
          notes: notes || null,
        };
      });

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
      logger.error("Error creating booking", error as Error, { component: 'QuickBookDialog' });
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

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

          {/* Discount Section */}
          {selectedSlot && (
            <Collapsible open={showDiscount} onOpenChange={setShowDiscount}>
              <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full py-2">
                <Percent className="h-4 w-4" />
                <span>{t("bookings.addDiscount", "Add discount")}</span>
                <ChevronDown className={cn("h-4 w-4 ml-auto transition-transform", showDiscount && "rotate-180")} />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2 space-y-3">
                <div className="flex gap-2">
                  <Select value={discountType} onValueChange={(v) => setDiscountType(v as "percentage" | "fixed")}>
                    <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percentage">%</SelectItem>
                      <SelectItem value="fixed">€</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input type="number" min="0" value={discountValue || ""} onChange={(e) => setDiscountValue(Number(e.target.value))} placeholder={t("bookings.discountAmount")} className="flex-1" />
                </div>
                <Textarea placeholder={t("bookings.discountReason")} value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} rows={1} />
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Price Summary */}
          {selectedSlot && (
            <div className="rounded-lg border bg-muted/30 p-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{sessionsCount} {sessionsCount === 1 ? t("calendar.session") : t("calendar.sessions")} × {formatPrice(pricePerSession)}</span>
                <span>{formatPrice(subtotal)}</span>
              </div>
              {calculatedDiscount > 0 && (
                <div className="flex justify-between text-green-600 dark:text-green-400">
                  <span>{t("bookings.discount")}</span>
                  <span>-{formatPrice(calculatedDiscount)}</span>
                </div>
              )}
              <div className="flex justify-between font-medium border-t pt-1">
                <span>{t("bookings.total")}</span>
                <span>{formatPrice(finalAmount)}</span>
              </div>
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label>{t("bookings.notes")}</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("bookings.notesPlaceholder")} rows={2} />
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
