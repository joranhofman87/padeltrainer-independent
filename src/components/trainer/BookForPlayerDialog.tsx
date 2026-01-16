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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, UserPlus, Clock, MapPin, Calendar } from "lucide-react";
import { AddPlayerDialog, GuestPlayer } from "./AddPlayerDialog";

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
}

interface BookForPlayerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string;
  slot: Slot | null;
  lesson: Lesson | null;
  onBookingCreated?: () => void;
}

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
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [showAddPlayer, setShowAddPlayer] = useState(false);

  useEffect(() => {
    if (open && trainerId) {
      fetchPlayers();
    }
  }, [open, trainerId]);

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

  const handlePlayerCreated = (player: GuestPlayer) => {
    setPlayers([...players, player].sort((a, b) =>
      a.full_name.localeCompare(b.full_name)
    ));
    setSelectedPlayerId(player.id);
    setShowAddPlayer(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slot || !selectedPlayerId) return;

    setIsLoading(true);

    try {
      // Create booking for guest player
      const { data: booking, error: bookingError } = await supabase
        .from("bookings")
        .insert({
          slot_id: slot.id,
          guest_player_id: selectedPlayerId,
          lesson_id: lesson?.id || null,
          status: "confirmed",
          payment_status: "pending",
          payment_amount: lesson?.price || null,
          notes: notes.trim() || null,
        })
        .select()
        .single();

      if (bookingError) throw bookingError;

      // Get guest player details for email
      const player = players.find((p) => p.id === selectedPlayerId);
      if (player) {
        // Send email notification to guest player
        try {
          await supabase.functions.invoke("send-email", {
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
          });
        } catch (emailError) {
          console.log("Email notification failed:", emailError);
        }
      }

      toast({
        title: t("bookings.bookingCreated"),
        description: t("bookings.bookingCreatedDescription"),
      });

      setSelectedPlayerId("");
      setNotes("");
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

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
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
            <div className="space-y-2">
              <Label htmlFor="player">{t("bookings.selectPlayer")} *</Label>
              {isFetching ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t("common:loading")}</span>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Select
                    value={selectedPlayerId}
                    onValueChange={setSelectedPlayerId}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder={t("bookings.selectPlayerPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {players.length === 0 ? (
                        <div className="p-2 text-sm text-muted-foreground text-center">
                          {t("players.noPlayers")}
                        </div>
                      ) : (
                        players.map((player) => (
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
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setShowAddPlayer(true)}
                  >
                    <UserPlus className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>

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
                disabled={isLoading || !selectedPlayerId}
              >
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("bookings.confirmBooking")}
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
