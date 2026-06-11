import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, CreditCard, RefreshCw, Trash2, Info, X } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { GuestPlayer } from "./AddPlayerDialog";
import { fetchBookableGuestPlayers } from '@/lib/playersOverview';

interface BookingDetails {
  id: string;
  status: string;
  notes: string | null;
  payment_status: string;
  payment_amount: number | null;
  paid_externally: boolean | null;
  availability_slots: {
    id: string;
    start_time: string;
    end_time: string;
    price_per_session: number | null;
    cyclus_name: string | null;
  };
  player: {
    id: string;
    full_name: string | null;
    email: string | null;
  } | null;
  guest_player_id: string | null;
}

interface InlineEditBookingProps {
  booking: BookingDetails;
  trainerId: string;
  /** Academy context: widens the player picker to the academy's full membership. */
  academyProfileId?: string;
  onBookingUpdated: () => void;
  onClose: () => void;
}

export function InlineEditBooking({ booking, trainerId, academyProfileId, onBookingUpdated, onClose }: InlineEditBookingProps) {
  const { t } = useTranslation("trainer");
  const { t: tCommon } = useTranslation("common");
  const { toast } = useToast();

  const [notes, setNotes] = useState(booking.notes || "");
  const [paymentStatus, setPaymentStatus] = useState(booking.payment_status);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(booking.guest_player_id);
  const [players, setPlayers] = useState<GuestPlayer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    (async () => {
      setIsFetching(true);
      try {
        const data = await fetchBookableGuestPlayers(
          academyProfileId
            ? { kind: 'academy', id: academyProfileId }
            : { kind: 'trainer', id: trainerId },
        );
        setPlayers(data as GuestPlayer[]);
      } catch (error) {
        logger.error("Error fetching players", error as Error, { component: "InlineEditBooking" });
      } finally {
        setIsFetching(false);
      }
    })();
  }, [trainerId, academyProfileId]);

  const handleSave = async () => {
    setIsLoading(true);
    try {
      const updates: Record<string, any> = {
        notes: notes || null,
        payment_status: paymentStatus,
      };
      if (paymentStatus === "paid" && booking.payment_status !== "paid") {
        updates.paid_at = new Date().toISOString();
        updates.payment_amount = booking.availability_slots.price_per_session || 0;
      } else if (paymentStatus !== "paid") {
        updates.paid_at = null;
      }
      if (selectedPlayerId && selectedPlayerId !== booking.guest_player_id) {
        updates.guest_player_id = selectedPlayerId;
      }
      const { error } = await supabase.from("bookings").update(updates).eq("id", booking.id);
      if (error) throw error;
      toast({ title: t("bookings.bookingUpdated", "Booking updated") });
      onBookingUpdated();
      onClose();
    } catch (error: any) {
      logger.error("Error updating booking", error as Error, { component: "InlineEditBooking" });
      toast({ title: tCommon("error"), description: error.message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const { error } = await supabase.from("bookings").delete().eq("id", booking.id);
      if (error) throw error;
      toast({ title: t("bookings.bookingDeleted", "Booking deleted") });
      onBookingUpdated();
      onClose();
    } catch (error: any) {
      logger.error("Error deleting booking", error as Error, { component: "InlineEditBooking" });
      toast({ title: tCommon("error"), description: error.message, variant: "destructive" });
    } finally {
      setIsDeleting(false);
    }
  };

  const isGuestBooking = !!booking.guest_player_id;
  const playerName = booking.player?.full_name ||
    players.find(p => p.id === booking.guest_player_id)?.full_name ||
    "Unknown Player";

  return (
    <div className="border rounded-lg p-4 space-y-4 bg-muted/30 mt-1">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">{t("bookings.editBooking", "Edit Booking")}</h4>
        <Button variant="ghost" size="icon" aria-label="Close" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Player swap for guest bookings */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("bookings.player")}</Label>
        {isGuestBooking ? (
          <Select value={selectedPlayerId || ""} onValueChange={setSelectedPlayerId} disabled={isFetching}>
            <SelectTrigger className="h-9"><SelectValue placeholder={t("bookings.selectPlayer")} /></SelectTrigger>
            <SelectContent>
              {players.map(p => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-sm text-muted-foreground">{playerName} <span className="text-xs">(registered)</span></p>
        )}
        {isGuestBooking && selectedPlayerId !== booking.guest_player_id && (
          <p className="text-xs text-orange-600 flex items-center gap-1">
            <RefreshCw className="h-3 w-3" />
            {t("bookings.playerWillBeSwapped", "Player will be changed")}
          </p>
        )}
      </div>

      {/* Payment status */}
      <div className="space-y-1.5">
        <Label className="text-xs flex items-center gap-1.5">
          <CreditCard className="h-3.5 w-3.5" />
          {t("bookings.paymentStatus", "Payment Status")}
        </Label>
        <Select value={paymentStatus} onValueChange={setPaymentStatus}>
          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">{t("bookings.paymentPending", "Pending")}</SelectItem>
            <SelectItem value="paid">{t("bookings.paymentPaid", "Paid")}</SelectItem>
            <SelectItem value="waived">{t("bookings.paymentWaived", "Waived")}</SelectItem>
          </SelectContent>
        </Select>
        {booking.paid_externally && (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Info className="h-3 w-3" />
            {t("bookings.paidExternally", "Paid (external)")}
          </p>
        )}
      </div>

      {/* Notes */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("bookings.notes")}</Label>
        <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder={t("bookings.notesPlaceholder")} rows={2} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" disabled={isLoading || isDeleting} className="gap-1.5">
              <Trash2 className="h-3.5 w-3.5" />
              {t("bookings.removePlayer", "Remove")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("bookings.deleteBookingConfirm", "Remove player?")}</AlertDialogTitle>
              <AlertDialogDescription>{t("bookings.deleteBookingWarning", "This cannot be undone.")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("bookings.removePlayer", "Remove")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={onClose} disabled={isLoading || isDeleting}>{tCommon("cancel")}</Button>
        <Button size="sm" onClick={handleSave} disabled={isLoading || isDeleting}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {tCommon("save", "Save")}
        </Button>
      </div>
    </div>
  );
}
