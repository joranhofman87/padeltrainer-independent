import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format, parseISO } from "date-fns";
import { Loader2, Calendar, Clock, User, CreditCard, RefreshCw, Trash2, Info, Receipt } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { logger } from '@/lib/logger';
import { loadActiveGuestPlayersForBooking } from "@/lib/guestPlayers";
import { cancelBookingsAndSync, markPaidPaymentAmount } from "@/lib/bookings";
import { getFriendlyErrorMessage } from "@/lib/friendlyError";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { GuestPlayer } from "@/components/players/AddPlayerDialog";

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

interface EditBookingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  booking: BookingDetails | null;
  trainerId: string;
  onBookingUpdated: () => void;
}

interface AffectedInvoiceInfo {
  invoice_number: string;
  status: string;
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
  const [affectedInvoices, setAffectedInvoices] = useState<AffectedInvoiceInfo[]>([]);
  const [isCheckingInvoices, setIsCheckingInvoices] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);

  useEffect(() => {
    if (booking && open) {
      setNotes(booking.notes || "");
      setPaymentStatus(booking.payment_status);
      setSelectedPlayerId(booking.guest_player_id);
      fetchPlayers();
      checkAffectedInvoices(booking.id);
    }
  }, [booking, open]);

  const checkAffectedInvoices = async (bookingId: string) => {
    setIsCheckingInvoices(true);
    setAffectedInvoices([]);
    try {
      const { data, error } = await supabase
        .from("invoices")
        .select("invoice_number, status")
        .in("status", ["draft", "sent", "pending", "paid"])
        .overlaps("booking_ids", [bookingId]);
      if (error) throw error;
      setAffectedInvoices(data || []);
    } catch (error) {
      logger.error("Error checking invoices for booking", error as Error, { component: 'EditBookingDialog' });
    } finally {
      setIsCheckingInvoices(false);
    }
  };

  const fetchPlayers = async () => {
    setIsFetching(true);
    try {
      const { data, error } = await loadActiveGuestPlayersForBooking(trainerId);
      if (error) throw error;
      setPlayers(data as GuestPlayer[]);
    } catch (error) {
      logger.error("Error fetching players", error as Error, { component: 'EditBookingDialog' });
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
        // Keep an existing per-player charge (split share / discount is authoritative); only fall back
        // to the full slot price when the booking has no amount yet (audit Batch 2 e).
        updates.payment_amount = markPaidPaymentAmount(booking.payment_amount, booking.availability_slots.price_per_session);
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
      logger.error("Error updating booking", error as Error, { component: 'EditBookingDialog' });
      toast({
        title: t("common:error"),
        description: getFriendlyErrorMessage(error, t("bookings.updateBookingError", "Could not update the booking. Please try again.")),
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
      // Soft-cancel (status='cancelled') + reconcile invoices via the canonical
      // facade instead of a hard delete. A hard delete lost history and, via
      // bookings.slot_id ON DELETE CASCADE, was unsafe; it also reconciled AFTER
      // deleting, so a sync failure orphaned the booking_id on the invoice with no
      // row left to recover. The facade cancels FIRST (the row survives as
      // 'cancelled') then syncs, surfacing the two failure modes separately.
      const { cancelError, syncError } = await cancelBookingsAndSync([booking.id], undefined, { declineClaims: true });
      if (cancelError) throw cancelError;
      if (syncError) {
        logger.error("Error recalculating invoices after booking removal", syncError, { component: 'EditBookingDialog' });
        toast({
          title: t("common:error"),
          description: t("bookings.invoiceSyncFailed", "The player was removed, but a linked invoice could not be updated. Please check the invoice."),
          variant: "destructive",
        });
      }

      toast({
        title: t("bookings.bookingDeleted", "Booking deleted"),
        description: t("bookings.bookingDeletedDescription", "The player has been removed from this slot"),
      });

      onBookingUpdated();
      onOpenChange(false);
    } catch (error) {
      logger.error("Error deleting booking", error as Error, { component: 'EditBookingDialog' });
      toast({
        title: t("common:error"),
        description: getFriendlyErrorMessage(error, t("bookings.deleteBookingError", "Could not remove the player. Please try again.")),
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
      setRemoveConfirmOpen(false);
    }
  };

  if (!booking) return null;

  const isGuestBooking = !!booking.guest_player_id;
  const playerName = booking.player?.full_name ||
    players.find(p => p.id === booking.guest_player_id)?.full_name ||
    "Unknown Player";
  const paidInvoices = affectedInvoices.filter(i => i.status === "paid");
  const unpaidInvoices = affectedInvoices.filter(i => i.status !== "paid");

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
            {booking.availability_slots.cyclus_name && (
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{booking.availability_slots.cyclus_name}</span>
                {booking.availability_slots.price_per_session != null && (
                  <Badge variant="secondary">€{booking.availability_slots.price_per_session}</Badge>
                )}
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
            {booking.paid_externally && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Info className="h-3 w-3" />
                {t("bookings.paidExternally", "Paid (external)")}
              </p>
            )}
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
          <Button
            variant="destructive"
            className="w-full sm:w-auto sm:mr-auto"
            disabled={isLoading || isDeleting}
            onClick={() => setRemoveConfirmOpen(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t("bookings.removePlayer", "Remove Player")}
          </Button>
          <ConfirmDialog
            open={removeConfirmOpen}
            onOpenChange={setRemoveConfirmOpen}
            title={t("bookings.deleteBookingConfirm", "Remove player from booking?")}
            description={t("bookings.deleteBookingWarning", "This action cannot be undone. The slot will become available again.")}
            confirmLabel={t("bookings.removePlayer", "Remove Player")}
            cancelLabel={t("common:cancel")}
            loading={isDeleting}
            confirmDisabled={isCheckingInvoices}
            onConfirm={handleDelete}
          >
            {paidInvoices.length > 0 && (
              <div className="flex items-start gap-2 p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
                <CreditCard className="h-4 w-4 text-orange-600 mt-0.5 shrink-0" />
                <p className="text-sm text-orange-800 dark:text-orange-200">
                  {t("bookings.deletePaidInvoiceWarning", "This booking is on paid invoice {{number}}. Removing the player will not change the amount already paid — arrange compensation with the player separately.", {
                    number: paidInvoices.map(i => i.invoice_number).join(", "),
                  })}
                </p>
              </div>
            )}
            {unpaidInvoices.length > 0 && (
              <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                <Receipt className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  {t("bookings.deleteUnpaidInvoiceWarning", "Invoice {{number}} will be recalculated automatically after removal.", {
                    number: unpaidInvoices.map(i => i.invoice_number).join(", "),
                  })}
                </p>
              </div>
            )}
          </ConfirmDialog>
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
