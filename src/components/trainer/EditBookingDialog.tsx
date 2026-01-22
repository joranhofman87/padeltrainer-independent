import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format, parseISO } from "date-fns";
import { Loader2, Calendar, Clock, User, CreditCard, RefreshCw, Trash2 } from "lucide-react";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { GuestPlayer } from "./AddPlayerDialog";

interface BookingDetails {
  id: string;
  status: string;
  notes: string | null;
  payment_status: string;
  payment_amount: number | null;
  availability_slots: {
    id: string;
    start_time: string;
    end_time: string;
  };
  lessons: {
    id: string;
    title: string;
    price: number;
    location: string | null;
  } | null;
  player: {
    id: string;
    full_name: string | null;
    email: string | null;
  } | null;
  guest_player_id: string | null;
}

interface EditBookingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  booking: BookingDetails | null;
  trainerId: string;
  onBookingUpdated: () => void;
}

export function EditBookingDialog({
  open,
  onOpenChange,
  booking,
  trainerId,
  onBookingUpdated,
}: EditBookingDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();

  const [notes, setNotes] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<string>("pending");
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [players, setPlayers] = useState<GuestPlayer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (booking && open) {
      setNotes(booking.notes || "");
      setPaymentStatus(booking.payment_status);
      setSelectedPlayerId(booking.guest_player_id);
      fetchPlayers();
    }
  }, [booking, open]);

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
    } catch (error) {
      console.error("Error fetching players:", error);
    } finally {
      setIsFetching(false);
    }
  };

  const handleSave = async () => {
    if (!booking) return;

    setIsLoading(true);
    try {
      const updates: Record<string, any> = {
        notes: notes || null,
        payment_status: paymentStatus,
      };

      // Handle payment status changes
      if (paymentStatus === "paid" && booking.payment_status !== "paid") {
        updates.paid_at = new Date().toISOString();
        updates.payment_amount = booking.lessons?.price || 0;
      } else if (paymentStatus !== "paid") {
        updates.paid_at = null;
      }

      // Handle player swap (only for guest players)
      if (selectedPlayerId && selectedPlayerId !== booking.guest_player_id) {
        updates.guest_player_id = selectedPlayerId;
      }

      const { error } = await supabase
        .from("bookings")
        .update(updates)
        .eq("id", booking.id);

      if (error) throw error;

      toast({
        title: t("bookings.bookingUpdated", "Booking updated"),
        description: t("bookings.bookingUpdatedDescription", "The booking has been updated successfully"),
      });

      onBookingUpdated();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Error updating booking:", error);
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!booking) return;

    setIsDeleting(true);
    try {
      const { error } = await supabase
        .from("bookings")
        .delete()
        .eq("id", booking.id);

      if (error) throw error;

      toast({
        title: t("bookings.bookingDeleted", "Booking deleted"),
        description: t("bookings.bookingDeletedDescription", "The player has been removed from this slot"),
      });

      onBookingUpdated();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Error deleting booking:", error);
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  if (!booking) return null;

  const isGuestBooking = !!booking.guest_player_id;
  const playerName = booking.player?.full_name || 
    players.find(p => p.id === booking.guest_player_id)?.full_name || 
    "Unknown Player";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t("bookings.editBooking", "Edit Booking")}</DialogTitle>
          <DialogDescription>
            {t("bookings.editBookingDescription", "Update booking details")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Booking info */}
          <div className="p-3 bg-muted rounded-lg space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span>{format(parseISO(booking.availability_slots.start_time), "EEEE, MMMM d, yyyy")}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span>
                {format(parseISO(booking.availability_slots.start_time), "HH:mm")} -{" "}
                {format(parseISO(booking.availability_slots.end_time), "HH:mm")}
              </span>
            </div>
            {booking.lessons && (
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{booking.lessons.title}</span>
                <Badge variant="secondary">€{booking.lessons.price}</Badge>
              </div>
            )}
          </div>

          {/* Player (can swap for guest bookings) */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <User className="h-4 w-4" />
              {t("bookings.player")}
            </Label>
            {isGuestBooking ? (
              <Select
                value={selectedPlayerId || ""}
                onValueChange={setSelectedPlayerId}
                disabled={isFetching}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("bookings.selectPlayer")} />
                </SelectTrigger>
                <SelectContent>
                  {players.map((player) => (
                    <SelectItem key={player.id} value={player.id}>
                      {player.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="p-2 bg-muted rounded text-sm">
                {playerName}
                <span className="text-xs text-muted-foreground ml-2">(registered user)</span>
              </div>
            )}
            {isGuestBooking && selectedPlayerId !== booking.guest_player_id && (
              <p className="text-xs text-orange-600 flex items-center gap-1">
                <RefreshCw className="h-3 w-3" />
                {t("bookings.playerWillBeSwapped", "Player will be changed to the selected one")}
              </p>
            )}
          </div>

          {/* Payment Status */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              {t("bookings.paymentStatus", "Payment Status")}
            </Label>
            <Select value={paymentStatus} onValueChange={setPaymentStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">{t("bookings.paymentPending", "Pending")}</SelectItem>
                <SelectItem value="paid">{t("bookings.paymentPaid", "Paid")}</SelectItem>
                <SelectItem value="waived">{t("bookings.paymentWaived", "Waived")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label>{t("bookings.notes")}</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("bookings.notesPlaceholder")}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button 
                variant="destructive" 
                className="w-full sm:w-auto sm:mr-auto"
                disabled={isLoading || isDeleting}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("bookings.removePlayer", "Remove Player")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("bookings.deleteBookingConfirm", "Remove player from booking?")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("bookings.deleteBookingWarning", "This action cannot be undone. The slot will become available again.")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
                <AlertDialogAction 
                  onClick={handleDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t("bookings.removePlayer", "Remove Player")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <div className="flex gap-2 w-full sm:w-auto">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading || isDeleting} className="flex-1 sm:flex-none">
              {t("common:cancel")}
            </Button>
            <Button onClick={handleSave} disabled={isLoading || isDeleting} className="flex-1 sm:flex-none">
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("common:save", "Save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
