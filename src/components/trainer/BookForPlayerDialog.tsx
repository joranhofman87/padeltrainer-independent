import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, UserPlus, Clock, MapPin, Calendar, Repeat, X, Check, Users } from "lucide-react";
import { AddPlayerDialog, GuestPlayer } from "./AddPlayerDialog";
import { Badge } from "@/components/ui/badge";
import { BookedPlayer } from "./CalendarSlotCard";
import { cn } from "@/lib/utils";

interface Lesson {
  id: string;
  title: string;
  price: number;
  location: string | null;
}

interface Slot {
  id: string;
  start_time: string;
  end_time: string;
  lesson_id: string | null;
  cyclus_id?: string | null;
  cyclus_name?: string | null;
  booked_players?: BookedPlayer[];
}

interface BookForPlayerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string;
  slot: Slot | null;
  lesson: Lesson | null;
  onBookingCreated?: () => void;
}

const EMPTY_PLAYER_SLOTS = ["", "", "", ""];

export function BookForPlayerDialog({
  open,
  onOpenChange,
  trainerId,
  slot,
  lesson,
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

  useEffect(() => {
    if (open && trainerId) {
      fetchPlayers();
      if (slot?.cyclus_id) {
        fetchCyclusSlotsCount(slot.cyclus_id);
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
    }
  }, [open]);

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
      console.error("Error fetching players:", error);
    } finally {
      setIsFetching(false);
    }
  };

  const fetchCyclusSlotsCount = async (cyclusId: string) => {
    try {
      const { count, error } = await supabase
        .from("availability_slots")
        .select("*", { count: "exact", head: true })
        .eq("cyclus_id", cyclusId)
        .gte("start_time", new Date().toISOString());

      if (error) throw error;
      setCyclusSlotsCount(count || 0);
    } catch (error) {
      console.error("Error fetching cyclus slots count:", error);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slot || !hasAtLeastOnePlayer) return;

    setIsLoading(true);

    try {
      const selectedPlayers = selectedPlayerIds
        .filter(id => id)
        .map(id => players.find(p => p.id === id)!)
        .filter(Boolean);

      if (bookingScope === "cyclus" && slot.cyclus_id) {
        // Get all future slots in this cyclus
        const { data: cyclusSlots, error: cyclusError } = await supabase
          .from("availability_slots")
          .select("id, start_time, end_time")
          .eq("cyclus_id", slot.cyclus_id)
          .gte("start_time", new Date().toISOString())
          .order("start_time");

        if (cyclusError) throw cyclusError;

        if (!cyclusSlots || cyclusSlots.length === 0) {
          throw new Error("No future slots found in this cyclus");
        }

        // Create bookings for all cyclus slots for ALL selected players
        const bookingsToInsert = cyclusSlots.flatMap(s =>
          selectedPlayers.map(player => ({
            slot_id: s.id,
            guest_player_id: player.id,
            lesson_id: lesson?.id || null,
            status: "confirmed",
            payment_status: "pending",
            payment_amount: lesson?.price || null,
            notes: notes.trim() || null,
          }))
        );

        const { error: bookingError } = await supabase
          .from("bookings")
          .insert(bookingsToInsert);

        if (bookingError) throw bookingError;

        // Send email notifications to all players with authentication
        const firstSlot = cyclusSlots[0];
        const lastSlot = cyclusSlots[cyclusSlots.length - 1];
        
        const { data: { session } } = await supabase.auth.getSession();
        await Promise.all(
          selectedPlayers.map(player =>
            supabase.functions.invoke("send-email", {
              body: {
                type: "manual_booking_confirmation",
                to: player.email,
                data: {
                  playerName: player.full_name,
                  lessonTitle: `${slot.cyclus_name || lesson?.title || t("bookings.lesson")} (${cyclusSlots.length} ${t("calendar.sessions")})`,
                  lessonDate: `${format(new Date(firstSlot.start_time), "MMM d")} - ${format(new Date(lastSlot.start_time), "MMM d, yyyy")}`,
                  lessonTime: `${format(new Date(firstSlot.start_time), "HH:mm")} - ${format(new Date(firstSlot.end_time), "HH:mm")}`,
                  location: lesson?.location,
                  price: lesson?.price ? lesson.price * cyclusSlots.length : null,
                },
              },
              headers: {
                Authorization: `Bearer ${session?.access_token}`,
              },
            }).catch(err => console.log("Email notification failed:", err))
          )
        );

        const totalBookings = selectedPlayers.length * cyclusSlots.length;
        toast({
          title: t("bookings.bookingCreated"),
          description: t("bookings.multiBookingCreated", { 
            players: selectedPlayers.length, 
            sessions: cyclusSlots.length,
            total: totalBookings
          }),
        });
      } else {
        // Single slot booking for all selected players
        const bookingsToInsert = selectedPlayers.map(player => ({
          slot_id: slot.id,
          guest_player_id: player.id,
          lesson_id: lesson?.id || null,
          status: "confirmed",
          payment_status: "pending",
          payment_amount: lesson?.price || null,
          notes: notes.trim() || null,
        }));

        const { error: bookingError } = await supabase
          .from("bookings")
          .insert(bookingsToInsert);

        if (bookingError) throw bookingError;

        // Send email notifications to all players with authentication
        const { data: { session: emailSession } } = await supabase.auth.getSession();
        await Promise.all(
          selectedPlayers.map(player =>
            supabase.functions.invoke("send-email", {
              body: {
                type: "manual_booking_confirmation",
                to: player.email,
                data: {
                  playerName: player.full_name,
                  lessonTitle: lesson?.title || t("bookings.lesson"),
                  lessonDate: format(new Date(slot.start_time), "EEEE, MMMM d, yyyy"),
                  lessonTime: `${format(new Date(slot.start_time), "HH:mm")} - ${format(new Date(slot.end_time), "HH:mm")}`,
                  location: lesson?.location,
                  price: lesson?.price,
                },
              },
              headers: {
                Authorization: `Bearer ${emailSession?.access_token}`,
              },
            }).catch(err => console.log("Email notification failed:", err))
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
            {lesson && (
              <>
                <div className="font-medium">{lesson.title}</div>
                {lesson.location && (
                  <div className="flex items-center gap-2 text-sm">
                    <MapPin className="h-4 w-4 text-muted-foreground" />
                    <span>{lesson.location}</span>
                  </div>
                )}
                <div className="text-sm text-muted-foreground">
                  €{lesson.price}
                </div>
              </>
            )}
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