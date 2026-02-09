import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format, differenceInMinutes } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabaseClient";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import { Loader2, UserPlus, Clock, MapPin, Calendar, Repeat, X, Check, Users, Percent, ChevronDown, Euro } from "lucide-react";
import { AddPlayerDialog, GuestPlayer } from "./AddPlayerDialog";
import { Badge } from "@/components/ui/badge";
import { BookedPlayer } from "./CalendarSlotCard";
import { cn } from "@/lib/utils";
import { calculateSlotPrice, applyDiscount, formatPrice } from "@/lib/pricing";
import { logger } from "@/lib/logger";

// Lesson interface removed - pricing now on slots

interface Slot {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id?: string | null;
  cyclus_name?: string | null;
  booked_players?: BookedPlayer[];
}

interface BookForPlayerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string;
  slot: Slot | null;
  onBookingCreated?: () => void;
}

const EMPTY_PLAYER_SLOTS = ["", "", "", ""];

export function BookForPlayerDialog({
  open,
  onOpenChange,
  trainerId,
  slot,
  onBookingCreated,
}: BookForPlayerDialogProps) {
  const { t } = useTranslation("trainer");
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
  
  // Discount state
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountType, setDiscountType] = useState<"percentage" | "fixed">("percentage");
  const [discountValue, setDiscountValue] = useState<number>(0);
  const [discountReason, setDiscountReason] = useState("");

  useEffect(() => {
    if (open && trainerId) {
      fetchPlayers();
      fetchHourlyRate();
      if (slot?.cyclus_id) {
        fetchCyclusSlots(slot.cyclus_id);
      }
    }
  }, [open, trainerId, slot?.cyclus_id]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedPlayerIds(EMPTY_PLAYER_SLOTS);
      setNotes("");
      setBookingScope("single");
      setCyclusSlotsCount(0);
      setCyclusSlots([]);
      setShowDiscount(false);
      setDiscountType("percentage");
      setDiscountValue(0);
      setDiscountReason("");
    }
  }, [open]);

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
      logger.error("Error fetching hourly rate", error as Error, { component: "BookForPlayerDialog" });
    }
  };

  const fetchPlayers = async () => {
    setIsFetching(true);
    try {
      const { data, error } = await supabase
        .from("guest_players")
        .select("*")
        .eq("trainer_id", trainerId)
        .order("full_name");

      if (error) throw error;
      setPlayers(data as GuestPlayer[]);
    } catch (error: any) {
      logger.error("Error fetching players", error as Error, { component: "BookForPlayerDialog" });
    } finally {
      setIsFetching(false);
    }
  };

  const fetchCyclusSlots = async (cyclusId: string) => {
    try {
      const { data, error } = await supabase
        .from("availability_slots")
        .select("id, start_time, end_time")
        .eq("cyclus_id", cyclusId)
        .gte("start_time", new Date().toISOString())
        .order("start_time");

      if (error) throw error;
      setCyclusSlots(data || []);
      setCyclusSlotsCount(data?.length || 0);
    } catch (error) {
      logger.error("Error fetching cyclus slots", error as Error, { component: "BookForPlayerDialog" });
    }
  };

  const handlePlayerCreated = (player: GuestPlayer) => {
    setPlayers([...players, player].sort((a, b) =>
      a.full_name.localeCompare(b.full_name)
    ));
    // Add to first empty slot
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
    // Filter out players already selected in other slots
    const selectedInOtherSlots = selectedPlayerIds.filter((id, idx) => id && idx !== slotIndex);
    return players.filter(player => !selectedInOtherSlots.includes(player.id));
  };

  const selectedCount = selectedPlayerIds.filter(id => id).length;
  const hasAtLeastOnePlayer = selectedCount > 0;

  // Calculate price based on slot duration and hourly rate
  const slotDurationMinutes = slot 
    ? differenceInMinutes(new Date(slot.end_time), new Date(slot.start_time))
    : 60;
  const pricePerSession = calculateSlotPrice(hourlyRate, slotDurationMinutes);
  
  // Calculate total based on scope and number of players
  const sessionsCount = bookingScope === "cyclus" && cyclusSlotsCount > 1 ? cyclusSlotsCount : 1;
  const subtotal = pricePerSession * sessionsCount * selectedCount;
  
  // Apply discount
  const { finalAmount, discountAmount: calculatedDiscount } = applyDiscount(
    subtotal,
    discountType,
    discountValue
  );
  
  // Price per player for bookings
  const totalDiscountPerPlayer = selectedCount > 0 ? calculatedDiscount / selectedCount : 0;
  const finalPricePerPlayer = selectedCount > 0 ? finalAmount / selectedCount : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slot || !hasAtLeastOnePlayer) return;

    setIsLoading(true);

    try {
      const selectedPlayers = selectedPlayerIds
        .filter(id => id)
        .map(id => players.find(p => p.id === id)!)
        .filter(Boolean);

      if (bookingScope === "cyclus" && slot.cyclus_id && cyclusSlots.length > 0) {
        // Use already fetched cyclus slots
        const slotsToBook = cyclusSlots;

        if (slotsToBook.length === 0) {
          throw new Error("No future slots found in this cyclus");
        }

        // Calculate price per session for each slot
        const bookingsToInsert = slotsToBook.flatMap((s, slotIndex) => {
          const slotDuration = differenceInMinutes(new Date(s.end_time), new Date(s.start_time));
          const slotPrice = calculateSlotPrice(hourlyRate, slotDuration);
          
          return selectedPlayers.map((player, playerIndex) => {
            // Apply discount proportionally across all bookings (to first booking per player)
            const isFirstSlotForPlayer = slotIndex === 0;
            const playerDiscountAmount = isFirstSlotForPlayer ? totalDiscountPerPlayer : 0;
            
            return {
              slot_id: s.id,
              guest_player_id: player.id,
              status: "confirmed",
              payment_status: "pending",
              original_amount: slotPrice,
              discount_amount: playerDiscountAmount,
              discount_reason: isFirstSlotForPlayer && discountReason ? discountReason : null,
              payment_amount: slotPrice - (isFirstSlotForPlayer ? playerDiscountAmount / slotsToBook.length : 0),
              notes: notes.trim() || null,
            };
          });
        });

        const { error: bookingError } = await supabase
          .from("bookings")
          .insert(bookingsToInsert);

        if (bookingError) throw bookingError;

        // Send email notifications
        const firstSlot = slotsToBook[0];
        const lastSlot = slotsToBook[slotsToBook.length - 1];
        
        const { data: { session } } = await supabase.auth.getSession();
        await Promise.all(
          selectedPlayers.map(player =>
            supabase.functions.invoke("send-email", {
              body: {
                type: "manual_booking_confirmation",
                to: player.email,
                data: {
                  playerName: player.full_name,
                  lessonTitle: `${slot.cyclus_name || t("bookings.lesson")} (${slotsToBook.length} ${t("calendar.sessions")})`,
                  lessonDate: `${format(new Date(firstSlot.start_time), "MMM d")} - ${format(new Date(lastSlot.start_time), "MMM d, yyyy")}`,
                  lessonTime: `${format(new Date(firstSlot.start_time), "HH:mm")} - ${format(new Date(firstSlot.end_time), "HH:mm")}`,
                  location: null,
                  price: finalPricePerPlayer,
                },
              },
              headers: {
                Authorization: `Bearer ${session?.access_token}`,
              },
            }).catch(err => logger.warn("Email notification failed", { error: err?.message }))
          )
        );

        const totalBookings = selectedPlayers.length * slotsToBook.length;
        toast({
          title: t("bookings.bookingCreated"),
          description: t("bookings.multiBookingCreated", { 
            players: selectedPlayers.length, 
            sessions: slotsToBook.length,
            total: totalBookings
          }),
        });
      } else {
        // Single slot booking for all selected players
        const bookingsToInsert = selectedPlayers.map((player, index) => {
          const playerDiscountAmount = index === 0 ? calculatedDiscount : 0;
          
          return {
            slot_id: slot.id,
            guest_player_id: player.id,
            status: "confirmed",
            payment_status: "pending",
            original_amount: pricePerSession,
            discount_amount: playerDiscountAmount,
            discount_reason: index === 0 && discountReason ? discountReason : null,
            payment_amount: pricePerSession - (playerDiscountAmount / selectedPlayers.length),
            notes: notes.trim() || null,
          };
        });

        const { error: bookingError } = await supabase
          .from("bookings")
          .insert(bookingsToInsert);

        if (bookingError) throw bookingError;

        // Send email notifications
        const { data: { session: emailSession } } = await supabase.auth.getSession();
        await Promise.all(
          selectedPlayers.map(player =>
            supabase.functions.invoke("send-email", {
              body: {
                type: "manual_booking_confirmation",
                to: player.email,
                data: {
                  playerName: player.full_name,
                  lessonTitle: slot.cyclus_name || t("bookings.lesson"),
                  lessonDate: format(new Date(slot.start_time), "EEEE, MMMM d, yyyy"),
                  lessonTime: `${format(new Date(slot.start_time), "HH:mm")} - ${format(new Date(slot.end_time), "HH:mm")}`,
                  location: null,
                  price: finalPricePerPlayer / selectedPlayers.length,
                },
              },
              headers: {
                Authorization: `Bearer ${emailSession?.access_token}`,
              },
            }).catch(err => logger.warn("Email notification failed", { error: err?.message }))
          )
        );

        toast({
          title: t("bookings.bookingCreated"),
          description: selectedPlayers.length > 1 
            ? t("bookings.multiPlayersBooked", { count: selectedPlayers.length })
            : t("bookings.bookingCreatedDescription"),
        });
      }

      setSelectedPlayerIds(EMPTY_PLAYER_SLOTS);
      setNotes("");
      setBookingScope("single");
      onOpenChange(false);
      onBookingCreated?.();
    } catch (error: any) {
      logger.error("Error creating booking", error as Error, { component: "BookForPlayerDialog" });
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

  const hasCyclus = !!slot.cyclus_id && cyclusSlotsCount > 1;

  const getConfirmButtonText = () => {
    if (bookingScope === "cyclus" && hasCyclus) {
      if (selectedCount > 1) {
        return t("bookings.confirmBookingPlayersSessions", { 
          players: selectedCount, 
          sessions: cyclusSlotsCount 
        });
      }
      return `${t("bookings.confirmBooking")} (${cyclusSlotsCount} ${t("calendar.sessions")})`;
    }
    if (selectedCount > 1) {
      return t("bookings.confirmBookingPlayers", { players: selectedCount });
    }
    return t("bookings.confirmBooking");
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("bookings.bookForPlayer")}</DialogTitle>
            <DialogDescription>
              {t("bookings.bookForPlayerDescription")}
            </DialogDescription>
          </DialogHeader>

          {/* Slot Details */}
          <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span>
                {format(new Date(slot.start_time), "EEEE, MMMM d, yyyy")}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span>
                {format(new Date(slot.start_time), "HH:mm")} -{" "}
                {format(new Date(slot.end_time), "HH:mm")}
              </span>
            </div>
            {slot.cyclus_name && (
              <Badge variant="secondary" className="gap-1">
                <Repeat className="h-3 w-3" />
                {slot.cyclus_name}
              </Badge>
            )}
            <div className="flex items-center gap-2 text-sm">
              <Euro className="h-4 w-4 text-muted-foreground" />
              <span>
                {formatPrice(pricePerSession)} / {slotDurationMinutes} min
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Unified 4-row player view */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <Label>{t("bookings.players")}</Label>
                </div>
                <span className="text-xs text-muted-foreground">
                  {(slot.booked_players?.length || 0) + selectedCount}/4 {t("bookings.booked")}
                </span>
              </div>
              
              {isFetching ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t("common:loading")}</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {[0, 1, 2, 3].map((index) => {
                    const existingBookedPlayer = slot.booked_players?.[index];
                    const existingBookedCount = slot.booked_players?.length || 0;
                    
                    // If this slot has an existing booked player, show it as read-only
                    if (existingBookedPlayer) {
                      return (
                        <div
                          key={index}
                          className={cn(
                            "flex items-center gap-2 text-sm px-3 py-2 rounded-md",
                            existingBookedPlayer.status === "confirmed"
                              ? "bg-green-100 dark:bg-green-900/30 border border-green-200 dark:border-green-800"
                              : "bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800"
                          )}
                        >
                          <span className="text-muted-foreground w-20 shrink-0">
                            {t("bookings.player")} {index + 1}
                          </span>
                          <div className="flex items-center gap-2 flex-1">
                            {existingBookedPlayer.status === "confirmed" ? (
                              <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                            ) : (
                              <Clock className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                            )}
                            <span className={cn(
                              "font-medium",
                              existingBookedPlayer.status === "confirmed"
                                ? "text-green-700 dark:text-green-300"
                                : "text-yellow-700 dark:text-yellow-300"
                            )}>
                              {existingBookedPlayer.name}
                            </span>
                            {existingBookedPlayer.isGuest && (
                              <span className="text-xs text-muted-foreground">
                                ({t("calendar.guest")})
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    }
                    
                    // For empty slots, show player selection
                    const selectionIndex = index - existingBookedCount;
                    const availablePlayers = getAvailablePlayersForSlot(selectionIndex);
                    const isFirstEmptySlot = index === existingBookedCount;
                    const currentPlayerId = selectedPlayerIds[selectionIndex];
                    const currentPlayer = players.find(p => p.id === currentPlayerId);

                    return (
                      <div key={index} className="flex gap-2 items-center">
                        <span className="text-sm text-muted-foreground w-20 shrink-0">
                          {t("bookings.player")} {index + 1}
                          {isFirstEmptySlot && " *"}
                        </span>
                        <Select
                          value={currentPlayerId}
                          onValueChange={(value) => handlePlayerSelect(selectionIndex, value)}
                        >
                          <SelectTrigger className="flex-1">
                            <SelectValue placeholder={
                              isFirstEmptySlot 
                                ? t("bookings.selectPlayerPlaceholder")
                                : t("bookings.optionalPlayer")
                            } />
                          </SelectTrigger>
                          <SelectContent>
                            {availablePlayers.length === 0 ? (
                              <div className="p-2 text-sm text-muted-foreground text-center">
                                {players.length === 0 
                                  ? t("players.noPlayers")
                                  : t("bookings.allPlayersSelected")
                                }
                              </div>
                            ) : (
                              availablePlayers.map((player) => (
                                <SelectItem key={player.id} value={player.id}>
                                  <div className="flex flex-col">
                                    <span>{player.full_name}</span>
                                    <span className="text-xs text-muted-foreground">
                                      {player.email}
                                    </span>
                                  </div>
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        {currentPlayerId && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => clearPlayerSlot(selectionIndex)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                        {!currentPlayerId && isFirstEmptySlot && (
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => setShowAddPlayer(true)}
                          >
                            <UserPlus className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  
                  {/* Add player button when at least one slot is filled but not all 4 */}
                  {((slot.booked_players?.length || 0) + selectedCount) > 0 && 
                   ((slot.booked_players?.length || 0) + selectedCount) < 4 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full mt-2"
                      onClick={() => setShowAddPlayer(true)}
                    >
                      <UserPlus className="h-4 w-4 mr-2" />
                      {t("players.addPlayer")}
                    </Button>
                  )}
                </div>
              )}
            </div>

            {/* Booking Scope - only show if slot is part of a cyclus */}
            {hasCyclus && (
              <div className="space-y-3">
                <Label>{t("calendar.bookingScope")}</Label>
                <RadioGroup
                  value={bookingScope}
                  onValueChange={(v) => setBookingScope(v as "single" | "cyclus")}
                  className="space-y-2"
                >
                  <div className="flex items-center space-x-3 rounded-lg border p-3">
                    <RadioGroupItem value="single" id="single" />
                    <Label htmlFor="single" className="flex-1 cursor-pointer">
                      <div className="font-medium">{t("calendar.singleSlot")}</div>
                    </Label>
                  </div>
                  <div className="flex items-center space-x-3 rounded-lg border p-3 bg-primary/5 border-primary/30">
                    <RadioGroupItem value="cyclus" id="cyclus" />
                    <Label htmlFor="cyclus" className="flex-1 cursor-pointer">
                      <div className="font-medium flex items-center gap-2">
                        <Repeat className="h-4 w-4" />
                        {t("calendar.entireCyclus")}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {t("calendar.entireCyclusDescription", { count: cyclusSlotsCount })}
                      </div>
                    </Label>
                  </div>
                </RadioGroup>
              </div>
            )}

            {/* Discount Section - Collapsible */}
            {hasAtLeastOnePlayer && (
              <Collapsible open={showDiscount} onOpenChange={setShowDiscount}>
                <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full py-2">
                  <Percent className="h-4 w-4" />
                  <span>{t("bookings.addDiscount", "Add discount")}</span>
                  <ChevronDown className={cn(
                    "h-4 w-4 ml-auto transition-transform",
                    showDiscount && "rotate-180"
                  )} />
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2 space-y-3">
                  <div className="flex gap-2">
                    <Select
                      value={discountType}
                      onValueChange={(v) => setDiscountType(v as "percentage" | "fixed")}
                    >
                      <SelectTrigger className="w-20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">%</SelectItem>
                        <SelectItem value="fixed">€</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min="0"
                      step={discountType === "percentage" ? "1" : "0.01"}
                      max={discountType === "percentage" ? "100" : undefined}
                      value={discountValue || ""}
                      onChange={(e) => setDiscountValue(Number(e.target.value))}
                      placeholder={t("bookings.discountAmount", "Amount")}
                      className="flex-1"
                    />
                  </div>
                  <Textarea
                    placeholder={t("bookings.discountReason", "Reason (optional)")}
                    value={discountReason}
                    onChange={(e) => setDiscountReason(e.target.value)}
                    rows={1}
                  />
                </CollapsibleContent>
              </Collapsible>
            )}

            {/* Price Summary */}
            {hasAtLeastOnePlayer && (
              <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {selectedCount} {selectedCount === 1 ? t("bookings.player") : t("bookings.players")} × {sessionsCount} {sessionsCount === 1 ? t("calendar.session", "session") : t("calendar.sessions")} × {formatPrice(pricePerSession)}
                  </span>
                  <span>{formatPrice(subtotal)}</span>
                </div>
                {calculatedDiscount > 0 && (
                  <div className="flex justify-between text-sm text-green-600 dark:text-green-400">
                    <span>{t("bookings.discount", "Discount")}</span>
                    <span>-{formatPrice(calculatedDiscount)}</span>
                  </div>
                )}
                <div className="flex justify-between font-medium border-t pt-2">
                  <span>{t("bookings.total", "Total")}</span>
                  <span>{formatPrice(finalAmount)}</span>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="notes">{t("bookings.notes")}</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("bookings.notesPlaceholder")}
                rows={2}
              />
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isLoading}
              >
                {t("common:cancel")}
              </Button>
              <Button
                type="submit"
                disabled={isLoading || !hasAtLeastOnePlayer}
              >
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {getConfirmButtonText()}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AddPlayerDialog
        open={showAddPlayer}
        onOpenChange={setShowAddPlayer}
        trainerId={trainerId}
        onPlayerCreated={handlePlayerCreated}
      />
    </>
  );
}