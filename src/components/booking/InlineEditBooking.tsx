import { useState, useEffect } from "react";
import { GuestPlayerSlotCombobox } from '@/components/players/GuestPlayerSlotCombobox';
import { useTranslation } from "react-i18next";
import { Loader2, CreditCard, RefreshCw, Trash2, Info, X, Receipt } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import { cancelBookingsAndSync, reconcileBookingInvoices } from "@/lib/bookings";
import { SkipInvoiceUpdatesCheckbox } from "@/components/booking/SkipInvoiceUpdatesCheckbox";
import { getFriendlyErrorMessage } from "@/lib/friendlyError";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { GuestPlayer } from "@/components/players/AddPlayerDialog";
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

interface AffectedInvoiceInfo {
  invoice_number: string;
  status: string;
}

interface InlineEditBookingProps {
  booking: BookingDetails;
  trainerId: string;
  /** Academy context: widens the player picker to the academy's full membership. */
  academyProfileId?: string;
  onBookingUpdated: () => void;
  onClose: () => void;
  /**
   * When `onSkipInvoiceUpdatesChange` is provided, the remove confirm shows a
   * "Don't update invoices" checkbox (controlled by `skipInvoiceUpdates`). While
   * checked, removing the player skips ALL invoice writes. Omit both to keep the
   * current behaviour (no checkbox; invoices always reconciled).
   */
  skipInvoiceUpdates?: boolean;
  onSkipInvoiceUpdatesChange?: (value: boolean) => void;
}

export function InlineEditBooking({ booking, trainerId, academyProfileId, onBookingUpdated, onClose, skipInvoiceUpdates = false, onSkipInvoiceUpdatesChange }: InlineEditBookingProps) {
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
  const [affectedInvoices, setAffectedInvoices] = useState<AffectedInvoiceInfo[]>([]);
  const [isCheckingInvoices, setIsCheckingInvoices] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);

  useEffect(() => {
    (async () => {
      setIsCheckingInvoices(true);
      setAffectedInvoices([]);
      try {
        const { data, error } = await supabase
          .from("invoices")
          .select("invoice_number, status")
          .in("status", ["draft", "sent", "pending", "paid"])
          .overlaps("booking_ids", [booking.id]);
        if (error) throw error;
        setAffectedInvoices(data || []);
      } catch (error) {
        logger.error("Error checking invoices for booking", error as Error, { component: "InlineEditBooking" });
      } finally {
        setIsCheckingInvoices(false);
      }
    })();
  }, [booking.id]);

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
      // Reconcile any invoice that bills this booking to its bookings' real paid state
      // (flips to paid only when fully covered) — the booking write alone left it stale.
      // Honour the page-level "Don't update invoices" toggle: when on, the owner is
      // deliberately freezing billing for this cycle, so a payment/player edit here must
      // NOT touch the linked invoice either (consistent with the remove path).
      if (!skipInvoiceUpdates) {
        try {
          await reconcileBookingInvoices([booking.id]);
        } catch (syncErr) {
          logger.error("Invoice reconcile after booking edit failed", syncErr as Error, { component: "InlineEditBooking" });
          toast({ title: tCommon("error"), description: t("bookings.invoiceSyncFailed", "The booking was saved, but a linked invoice could not be updated. Please check the invoice."), variant: "destructive" });
        }
      }
      toast({ title: t("bookings.bookingUpdated", "Booking updated") });
      onBookingUpdated();
      onClose();
    } catch (error: any) {
      logger.error("Error updating booking", error as Error, { component: "InlineEditBooking" });
      toast({ title: tCommon("error"), description: getFriendlyErrorMessage(error, t("bookings.updateBookingError", "Could not update the booking. Please try again.")), variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      // Soft-cancel (status='cancelled') + reconcile invoices via the canonical
      // facade instead of a hard delete. A hard delete lost history and, via
      // bookings.slot_id ON DELETE CASCADE, was unsafe; it also reconciled AFTER
      // deleting, so a sync failure orphaned the booking_id on the invoice with no
      // row left to recover. The facade cancels FIRST (the row survives as
      // 'cancelled') then syncs, surfacing the two failure modes separately.
      const { cancelError, syncError } = await cancelBookingsAndSync([booking.id], supabase, {
        skipInvoiceSync: skipInvoiceUpdates,
      });
      if (cancelError) throw cancelError;
      if (syncError) {
        logger.error("Error recalculating invoices after booking removal", syncError, { component: "InlineEditBooking" });
        toast({
          title: tCommon("error"),
          description: t("bookings.invoiceSyncFailed", "The player was removed, but a linked invoice could not be updated. Please check the invoice."),
          variant: "destructive",
        });
      }
      toast({ title: t("bookings.bookingDeleted", "Booking deleted") });
      onBookingUpdated();
      onClose();
    } catch (error) {
      logger.error("Error deleting booking", error as Error, { component: "InlineEditBooking" });
      toast({
        title: tCommon("error"),
        description: getFriendlyErrorMessage(error, t("bookings.deleteBookingError", "Could not remove the player. Please try again.")),
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
      setRemoveConfirmOpen(false);
    }
  };

  const isGuestBooking = !!booking.guest_player_id;
  const playerName = booking.player?.full_name ||
    players.find(p => p.id === booking.guest_player_id)?.full_name ||
    "Unknown Player";
  const paidInvoices = affectedInvoices.filter(i => i.status === "paid");
  const unpaidInvoices = affectedInvoices.filter(i => i.status !== "paid");

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
          <GuestPlayerSlotCombobox
            players={players}
            value={selectedPlayerId || ""}
            onValueChange={setSelectedPlayerId}
            disabled={isFetching}
            showEmail
            placeholder={t("bookings.selectPlayer")}
          />
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
        <Button variant="destructive" size="sm" disabled={isLoading || isDeleting} className="gap-1.5" onClick={() => setRemoveConfirmOpen(true)}>
          <Trash2 className="h-3.5 w-3.5" />
          {t("bookings.removePlayer", "Remove")}
        </Button>
        <ConfirmDialog
          open={removeConfirmOpen}
          onOpenChange={setRemoveConfirmOpen}
          title={t("bookings.deleteBookingConfirm", "Remove player?")}
          description={t("bookings.deleteBookingWarning", "This cannot be undone.")}
          confirmLabel={t("bookings.removePlayer", "Remove")}
          cancelLabel={tCommon("cancel")}
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
          {unpaidInvoices.length > 0 && !skipInvoiceUpdates && (
            <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <Receipt className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
              <p className="text-sm text-blue-800 dark:text-blue-200">
                {t("bookings.deleteUnpaidInvoiceWarning", "Invoice {{number}} will be recalculated automatically after removal.", {
                  number: unpaidInvoices.map(i => i.invoice_number).join(", "),
                })}
              </p>
            </div>
          )}
          {onSkipInvoiceUpdatesChange && (
            <SkipInvoiceUpdatesCheckbox
              checked={skipInvoiceUpdates}
              onCheckedChange={onSkipInvoiceUpdatesChange}
              disabled={isDeleting}
            />
          )}
        </ConfirmDialog>

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
