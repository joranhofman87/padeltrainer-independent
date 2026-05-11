import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format, differenceInMinutes } from "date-fns";
import { Loader2, UserPlus, X, Users, Percent, ChevronDown, Euro, Repeat } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import { syncSplitCountForCycle } from "@/lib/invoiceSync";
import { calculateSlotPrice, applyDiscount, formatPrice } from "@/lib/pricing";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { AddPlayerDialog, GuestPlayer } from "./AddPlayerDialog";
import { BookedPlayer } from "./CalendarSlotCard";
import { Check, Clock } from "lucide-react";

interface Slot {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id?: string | null;
  cyclus_name?: string | null;
  booked_players?: BookedPlayer[];
}

interface InlineBookPlayerProps {
  trainerId: string;
  slot: Slot;
  onBookingCreated: () => void;
  onClose: () => void;
}

const EMPTY_PLAYER_SLOTS = ["", "", "", ""];

export function InlineBookPlayer({ trainerId, slot, onBookingCreated, onClose }: InlineBookPlayerProps) {
  const { t } = useTranslation("trainer");
  const { t: tCommon } = useTranslation("common");
  const { toast } = useToast();

  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [players, setPlayers] = useState<GuestPlayer[]>([]);
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<string[]>(EMPTY_PLAYER_SLOTS);
  const [notes, setNotes] = useState("");
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [bookingScope, setBookingScope] = useState<"single" | "cyclus">("single");
  const [cyclusSlotsCount, setCyclusSlotsCount] = useState(0);
  const [cyclusSlots, setCyclusSlots] = useState<{ id: string; start_time: string; end_time: string }[]>([]);
  const [hourlyRate, setHourlyRate] = useState<number>(50);
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountType, setDiscountType] = useState<"percentage" | "fixed">("percentage");
  const [discountValue, setDiscountValue] = useState<number>(0);
  const [discountReason, setDiscountReason] = useState("");

  useEffect(() => {
    fetchPlayers();
    fetchHourlyRate();
    if (slot.cyclus_id) fetchCyclusSlots(slot.cyclus_id);
  }, [trainerId, slot.cyclus_id]);

  const fetchHourlyRate = async () => {
    try {
      const { data } = await supabase.from("trainer_profiles").select("hourly_rate").eq("id", trainerId).single();
      if (data?.hourly_rate) setHourlyRate(data.hourly_rate);
    } catch (error) {
      logger.error("Error fetching hourly rate", error as Error, { component: "InlineBookPlayer" });
    }
  };

  const fetchPlayers = async () => {
    setIsFetching(true);
    try {
      const { data, error } = await supabase.from("guest_players").select("*").eq("trainer_id", trainerId).order("full_name");
      if (error) throw error;
      setPlayers(data as GuestPlayer[]);
    } catch (error) {
      logger.error("Error fetching players", error as Error, { component: "InlineBookPlayer" });
    } finally {
      setIsFetching(false);
    }
  };

  const fetchCyclusSlots = async (cyclusId: string) => {
    try {
      const { data, error } = await supabase.from("availability_slots").select("id, start_time, end_time")
        .eq("cyclus_id", cyclusId).gte("start_time", new Date().toISOString()).order("start_time");
      if (error) throw error;
      setCyclusSlots(data || []);
      setCyclusSlotsCount(data?.length || 0);
    } catch (error) {
      logger.error("Error fetching cyclus slots", error as Error, { component: "InlineBookPlayer" });
    }
  };

  const handlePlayerCreated = (player: GuestPlayer) => {
    setPlayers(prev => [...prev, player].sort((a, b) => a.full_name.localeCompare(b.full_name)));
    const firstEmptyIndex = selectedPlayerIds.findIndex(id => !id);
    if (firstEmptyIndex !== -1) {
      const newIds = [...selectedPlayerIds];
      newIds[firstEmptyIndex] = player.id;
      setSelectedPlayerIds(newIds);
    }
    setShowAddPlayer(false);
  };

  const handlePlayerSelect = (index: number, playerId: string) => {
    const newIds = [...selectedPlayerIds];
    newIds[index] = playerId;
    setSelectedPlayerIds(newIds);
  };

  const clearPlayerSlot = (index: number) => {
    const newIds = [...selectedPlayerIds];
    newIds[index] = "";
    setSelectedPlayerIds(newIds);
  };

  const getAvailablePlayersForSlot = (slotIndex: number) => {
    const selectedInOtherSlots = selectedPlayerIds.filter((id, idx) => id && idx !== slotIndex);
    return players.filter(player => !selectedInOtherSlots.includes(player.id));
  };

  const selectedCount = selectedPlayerIds.filter(id => id).length;
  const hasAtLeastOnePlayer = selectedCount > 0;
  const slotDurationMinutes = differenceInMinutes(new Date(slot.end_time), new Date(slot.start_time));
  const pricePerSession = calculateSlotPrice(hourlyRate, slotDurationMinutes);
  const sessionsCount = bookingScope === "cyclus" && cyclusSlotsCount > 1 ? cyclusSlotsCount : 1;
  const subtotal = pricePerSession * sessionsCount * selectedCount;
  const { finalAmount, discountAmount: calculatedDiscount } = applyDiscount(subtotal, discountType, discountValue);
  const totalDiscountPerPlayer = selectedCount > 0 ? calculatedDiscount / selectedCount : 0;
  const finalPricePerPlayer = selectedCount > 0 ? finalAmount / selectedCount : 0;
  const hasCyclus = !!slot.cyclus_id && cyclusSlotsCount > 1;
  const existingBookedCount = slot.booked_players?.length || 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasAtLeastOnePlayer) return;
    setIsLoading(true);
    try {
      const selectedPlayers = selectedPlayerIds.filter(id => id).map(id => players.find(p => p.id === id)!).filter(Boolean);

      if (bookingScope === "cyclus" && slot.cyclus_id && cyclusSlots.length > 0) {
        const bookingsToInsert = cyclusSlots.flatMap((s, slotIndex) => {
          const slotDuration = differenceInMinutes(new Date(s.end_time), new Date(s.start_time));
          const slotPrice = calculateSlotPrice(hourlyRate, slotDuration);
          return selectedPlayers.map((player) => {
            const isFirst = slotIndex === 0;
            return {
              slot_id: s.id, guest_player_id: player.id, status: "confirmed", payment_status: "pending",
              original_amount: slotPrice,
              discount_amount: isFirst ? totalDiscountPerPlayer : 0,
              discount_reason: isFirst && discountReason ? discountReason : null,
              payment_amount: slotPrice - (isFirst ? totalDiscountPerPlayer / cyclusSlots.length : 0),
              notes: notes.trim() || null,
            };
          });
        });
        const { error } = await supabase.from("bookings").insert(bookingsToInsert);
        if (error) throw error;
        const guestIds = selectedPlayers.map(p => p.id);
        if (guestIds.length > 0) await supabase.from("guest_players").update({ has_trained: true }).in("id", guestIds);
        toast({ title: t("bookings.bookingCreated"), description: t("bookings.multiBookingCreated", { players: selectedPlayers.length, sessions: cyclusSlots.length, total: selectedPlayers.length * cyclusSlots.length }) });
      } else {
        const bookingsToInsert = selectedPlayers.map((player, index) => ({
          slot_id: slot.id, guest_player_id: player.id, status: "confirmed", payment_status: "pending",
          original_amount: pricePerSession,
          discount_amount: index === 0 ? calculatedDiscount : 0,
          discount_reason: index === 0 && discountReason ? discountReason : null,
          payment_amount: pricePerSession - ((index === 0 ? calculatedDiscount : 0) / selectedPlayers.length),
          notes: notes.trim() || null,
        }));
        const { error } = await supabase.from("bookings").insert(bookingsToInsert);
        if (error) throw error;
        const guestIds = selectedPlayers.map(p => p.id);
        if (guestIds.length > 0) await supabase.from("guest_players").update({ has_trained: true }).in("id", guestIds);
        toast({ title: t("bookings.bookingCreated"), description: selectedPlayers.length > 1 ? t("bookings.multiPlayersBooked", { count: selectedPlayers.length }) : t("bookings.bookingCreatedDescription") });
      }

      if (slot.cyclus_id) {
        try { await syncSplitCountForCycle(slot.cyclus_id); } catch (err) { logger.warn("Split count sync failed", { error: (err as Error)?.message }); }
      }

      onBookingCreated();
      onClose();
    } catch (error: any) {
      logger.error("Error creating booking", error as Error, { component: "InlineBookPlayer" });
      toast({ title: tCommon("error"), description: error.message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="border rounded-lg p-4 space-y-4 bg-muted/30 mt-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium flex items-center gap-1.5">
            <UserPlus className="h-4 w-4" />
            {t("bookings.bookForPlayer")}
          </h4>
          <Button variant="ghost" size="icon" aria-label="Close" className="h-7 w-7" type="button" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Player slots */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs flex items-center gap-1.5"><Users className="h-3.5 w-3.5" />{t("bookings.players")}</Label>
            <span className="text-xs text-muted-foreground">{existingBookedCount + selectedCount}/4 {t("bookings.booked")}</span>
          </div>

          {isFetching ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />{tCommon("loading")}</div>
          ) : (
            <div className="space-y-2">
              {[0, 1, 2, 3].map(index => {
                const existingPlayer = slot.booked_players?.[index];
                if (existingPlayer) {
                  return (
                    <div key={index} className={cn("flex items-center gap-2 text-sm px-3 py-2 rounded-md",
                      existingPlayer.status === "confirmed" ? "bg-emerald-100 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800" : "bg-amber-100 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800"
                    )}>
                      <span className="text-muted-foreground w-16 shrink-0 text-xs">{t("bookings.player")} {index + 1}</span>
                      <div className="flex items-center gap-1.5 flex-1">
                        {existingPlayer.status === "confirmed" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Clock className="h-3.5 w-3.5 text-amber-600" />}
                        <span className="font-medium text-xs">{existingPlayer.name}</span>
                      </div>
                    </div>
                  );
                }
                const selectionIndex = index - existingBookedCount;
                if (selectionIndex < 0) return null;
                const availablePlayers = getAvailablePlayersForSlot(selectionIndex);
                const isFirst = index === existingBookedCount;
                const currentPlayerId = selectedPlayerIds[selectionIndex];

                return (
                  <div key={index} className="flex gap-2 items-center">
                    <span className="text-xs text-muted-foreground w-16 shrink-0">{t("bookings.player")} {index + 1}{isFirst && " *"}</span>
                    <Select value={currentPlayerId} onValueChange={v => handlePlayerSelect(selectionIndex, v)}>
                      <SelectTrigger className="flex-1 h-9"><SelectValue placeholder={isFirst ? t("bookings.selectPlayerPlaceholder") : t("bookings.optionalPlayer")} /></SelectTrigger>
                      <SelectContent>
                        {availablePlayers.length === 0 ? (
                          <div className="p-2 text-sm text-muted-foreground text-center">{players.length === 0 ? t("players.noPlayers") : t("bookings.allPlayersSelected")}</div>
                        ) : availablePlayers.map(p => (
                          <SelectItem key={p.id} value={p.id}><span>{p.full_name}</span> <span className="text-xs text-muted-foreground ml-1">{p.email}</span></SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {currentPlayerId && <Button type="button" variant="ghost" size="icon" aria-label="Close" className="h-8 w-8 shrink-0" onClick={() => clearPlayerSlot(selectionIndex)}><X className="h-4 w-4" /></Button>}
                    {!currentPlayerId && isFirst && <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => setShowAddPlayer(true)}><UserPlus className="h-4 w-4" /></Button>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Booking scope */}
        {hasCyclus && (
          <div className="space-y-2">
            <Label className="text-xs">{t("calendar.bookingScope")}</Label>
            <RadioGroup value={bookingScope} onValueChange={v => setBookingScope(v as "single" | "cyclus")} className="space-y-1.5">
              <div className="flex items-center space-x-3 rounded-md border p-2.5">
                <RadioGroupItem value="single" id="inline-single" />
                <Label htmlFor="inline-single" className="text-xs cursor-pointer">{t("calendar.singleSlot")}</Label>
              </div>
              <div className="flex items-center space-x-3 rounded-md border p-2.5 bg-primary/5 border-primary/30">
                <RadioGroupItem value="cyclus" id="inline-cyclus" />
                <Label htmlFor="inline-cyclus" className="text-xs cursor-pointer flex items-center gap-1.5">
                  <Repeat className="h-3.5 w-3.5" />
                  {t("calendar.entireCyclus")} ({cyclusSlotsCount} {t("calendar.sessions")})
                </Label>
              </div>
            </RadioGroup>
          </div>
        )}

        {/* Discount */}
        {hasAtLeastOnePlayer && (
          <Collapsible open={showDiscount} onOpenChange={setShowDiscount}>
            <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors w-full py-1">
              <Percent className="h-3.5 w-3.5" />
              <span>{t("bookings.addDiscount", "Add discount")}</span>
              <ChevronDown className={cn("h-3.5 w-3.5 ml-auto transition-transform", showDiscount && "rotate-180")} />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 space-y-2">
              <div className="flex gap-2">
                <Select value={discountType} onValueChange={v => setDiscountType(v as "percentage" | "fixed")}>
                  <SelectTrigger className="w-16 h-9"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="percentage">%</SelectItem><SelectItem value="fixed">€</SelectItem></SelectContent>
                </Select>
                <Input type="number" min="0" step={discountType === "percentage" ? "1" : "0.01"} value={discountValue || ""} onChange={e => setDiscountValue(Number(e.target.value))} placeholder={t("bookings.discountAmount", "Amount")} className="flex-1 h-9" />
              </div>
              <Textarea placeholder={t("bookings.discountReason", "Reason (optional)")} value={discountReason} onChange={e => setDiscountReason(e.target.value)} rows={1} />
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Price summary */}
        {hasAtLeastOnePlayer && (
          <div className="rounded-md border bg-background p-3 space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{selectedCount} {selectedCount === 1 ? t("bookings.player") : t("bookings.players")} × {sessionsCount} × {formatPrice(pricePerSession)}</span>
              <span>{formatPrice(subtotal)}</span>
            </div>
            {calculatedDiscount > 0 && (
              <div className="flex justify-between text-emerald-600">
                <span>{t("bookings.discount", "Discount")}</span>
                <span>-{formatPrice(calculatedDiscount)}</span>
              </div>
            )}
            <div className="flex justify-between font-medium border-t pt-1.5">
              <span>{t("bookings.total", "Total")}</span>
              <span>{formatPrice(finalAmount)}</span>
            </div>
          </div>
        )}

        {/* Notes */}
        <div className="space-y-1.5">
          <Label className="text-xs">{t("bookings.notes")}</Label>
          <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder={t("bookings.notesPlaceholder")} rows={2} />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isLoading}>{tCommon("cancel")}</Button>
          <Button type="submit" size="sm" disabled={isLoading || !hasAtLeastOnePlayer}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("bookings.confirmBooking")}
          </Button>
        </div>
      </form>

      <AddPlayerDialog open={showAddPlayer} onOpenChange={setShowAddPlayer} trainerId={trainerId} onPlayerCreated={handlePlayerCreated} />
    </>
  );
}
