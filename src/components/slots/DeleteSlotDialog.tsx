import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Trash2, AlertTriangle, Loader2, Bell, Calendar, Receipt, CreditCard } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { getFriendlyErrorMessage } from "@/lib/friendlyError";
import { enqueueBookingNotification } from '@/lib/bookingNotifications';
import { logger } from "@/lib/logger";
import { recalculateInvoiceAfterRemoval, syncSplitCountForCycle } from "@/lib/invoiceSync";
import { applySlotDeleteToCycle } from "@/lib/slotDeleteGuard";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { SlotWithBookings } from "@/lib/slotTypes";

interface DeleteSlotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slot: SlotWithBookings | null;
  /**
   * Owner role of the surface opening the dialog. Currently unused by the body (the cascade is
   * identical for both calendars today); accepted so the now-neutral component has a role-aware
   * prop for the Slice-6 per-role cascade work instead of the old trainer-only `trainerId`.
   */
  ownerType?: 'trainer' | 'academy' | 'club';
  onSlotDeleted: () => void;
}

interface InvoiceLineItem {
  unit_price?: number;
}

interface InvoiceInfo {
  id: string;
  invoice_number: string;
  status: string;
  booking_ids: string[];
  total: number;
  vat_rate: number;
  line_items: InvoiceLineItem[];
}

// Minimal shapes for the supabase nested-join reads below — keeps this now-neutral component free of
// `any` (the joins are only read for a display name / email).

export function DeleteSlotDialog({
  open,
  onOpenChange,
  slot,
  onSlotDeleted,
}: DeleteSlotDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();

  const [deleteMode, setDeleteMode] = useState<"single" | "cyclus">("single");
  const [deleteScope, setDeleteScope] = useState<"future" | "all">("future");
  const [notifyPlayers, setNotifyPlayers] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [cyclusSlotCount, setCyclusSlotCount] = useState(0);
  const [totalCyclusSlotCount, setTotalCyclusSlotCount] = useState(0);

  // Invoice-related state
  const [affectedInvoices, setAffectedInvoices] = useState<InvoiceInfo[]>([]);
  const [paidInvoiceAction, setPaidInvoiceAction] = useState<"credit" | "proceed">("credit");
  const [isCheckingInvoices, setIsCheckingInvoices] = useState(false);

  // Reset state and fetch cyclus info when dialog opens
  useEffect(() => {
    if (open) {
      setDeleteMode("single");
      setDeleteScope("future");
      setNotifyPlayers(true);
      setIsDeleting(false);
      setAffectedInvoices([]);
      setPaidInvoiceAction("credit");
      setIsCheckingInvoices(false);
      
      if (slot?.cyclus_id) {
        const futureQuery = supabase
          .from("availability_slots")
          .select("id", { count: "exact" })
          .eq("cyclus_id", slot.cyclus_id)
          .gte("start_time", new Date().toISOString());

        const allQuery = supabase
          .from("availability_slots")
          .select("id", { count: "exact" })
          .eq("cyclus_id", slot.cyclus_id);

        Promise.all([futureQuery, allQuery]).then(([future, all]) => {
          setCyclusSlotCount(future.count || 0);
          setTotalCyclusSlotCount(all.count || 0);
        });
      } else {
        setCyclusSlotCount(0);
        setTotalCyclusSlotCount(0);
      }

      // Check for affected invoices
      if (slot) {
        checkAffectedInvoices(slot);
      }
    }
    // Intentionally keyed on the stable slot PRIMITIVES (id + cyclus_id), not the `slot` object —
    // re-running on every new object identity would re-fire the invoice/cyclus-count fetches on each
    // render. checkAffectedInvoices is a stable closure. (Pre-existing behavior, preserved on lift.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slot?.cyclus_id, slot?.id]);

  const checkAffectedInvoices = async (slotData: SlotWithBookings) => {
    setIsCheckingInvoices(true);
    try {
      // Get booking IDs for this slot
      const { data: bookings } = await supabase
        .from("bookings")
        .select("id")
        .eq("slot_id", slotData.id)
        .in("status", ["pending", "confirmed"]);

      if (!bookings || bookings.length === 0) {
        setAffectedInvoices([]);
        setIsCheckingInvoices(false);
        return;
      }

      const bookingIds = bookings.map(b => b.id);

      // Find invoices that contain any of these booking IDs
      const { data: invoices } = await supabase
        .from("invoices")
        .select("id, invoice_number, status, booking_ids, total, vat_rate, line_items")
        .in("status", ["draft", "sent", "paid", "pending"])
        .overlaps("booking_ids", bookingIds);

      setAffectedInvoices((invoices || []).map(inv => ({
        ...inv,
        booking_ids: inv.booking_ids || [],
        line_items: (inv.line_items as unknown as InvoiceLineItem[]) || [],
      })));
    } catch (err) {
      logger.error("Error checking invoices", err instanceof Error ? err : new Error(String(err)), { component: 'DeleteSlotDialog' });
    } finally {
      setIsCheckingInvoices(false);
    }
  };

  const recalculateInvoice = async (invoice: InvoiceInfo, removedBookingIds: string[]) => {
    await recalculateInvoiceAfterRemoval(invoice, removedBookingIds);
  };

  const handleInvoiceUpdates = async (cancelledBookingIds: string[]) => {
    if (cancelledBookingIds.length === 0) return;

    // Fetch EVERY invoice overlapping the bookings actually being cancelled — not
    // the dialog-open-time `affectedInvoices`, which only covered the single slot
    // the dialog was opened from. On a full-cyclus delete the bookings are cancelled
    // across all cycle slots, so a player who joined mid-cycle (invoice on other
    // slots) would otherwise keep a payable invoice for sessions that no longer
    // exist — and the cascade then destroys the data needed to fix it.
    const { data: invoiceRows } = await supabase
      .from("invoices")
      .select("id, invoice_number, status, booking_ids, total, vat_rate, line_items")
      .in("status", ["draft", "sent", "paid", "pending"])
      .overlaps("booking_ids", cancelledBookingIds);

    const invoicesToFix: InvoiceInfo[] = (invoiceRows || []).map(inv => ({
      ...inv,
      booking_ids: inv.booking_ids || [],
      line_items: (inv.line_items as InvoiceInfo["line_items"]) || [],
    }));

    for (const invoice of invoicesToFix) {
      const overlappingIds = invoice.booking_ids.filter(id => cancelledBookingIds.includes(id));
      if (overlappingIds.length === 0) continue;

      if (invoice.status === "paid") {
        if (paidInvoiceAction === "credit") {
          // Add a credit note to the invoice
          const removedCount = overlappingIds.length;
          const firstLineItem = invoice.line_items[0];
          const unitPrice = firstLineItem?.unit_price || 0;
          const creditAmount = removedCount * unitPrice;

          await supabase
            .from("invoices")
            .update({
              notes: t("calendar.invoiceCreditNote", "Credit: {{count}} session(s) cancelled (€{{amount}}). Trainer will arrange compensation.", {
                count: removedCount,
                amount: creditAmount.toFixed(2),
              }),
            })
            .eq("id", invoice.id);
        }
        // "proceed" = do nothing with paid invoice, trainer handles externally
      } else {
        // Unpaid invoice — recalculate
        await recalculateInvoice(invoice, overlappingIds);
      }
    }
  };

  const handleDelete = async () => {
    if (!slot) return;

    setIsDeleting(true);
    try {
      const hasBookings = slot.active_bookings > 0 || slot.pending_bookings > 0;
      const cancelledBookingIds: string[] = [];

      if (deleteMode === "cyclus" && slot.cyclus_id) {
        let query = supabase
          .from("availability_slots")
          .select("id")
          .eq("cyclus_id", slot.cyclus_id);
        
        if (deleteScope === "future") {
          query = query.gte("start_time", new Date().toISOString());
        }

        const { data: cyclusSlots, error: fetchError } = await query;
        if (fetchError) throw fetchError;

        const slotIds = cyclusSlots?.map((s) => s.id) || [];

        if (slotIds.length > 0) {
          const { data: bookingsToCancel } = await supabase
            .from("bookings")
            .select(`
              id, slot_id, guest_player_id, player_id,
              guest_players(full_name, email),
              profiles:player_id(full_name, email, user_id)
            `)
            .in("slot_id", slotIds)
            .in("status", ["pending", "confirmed"]);

          if (bookingsToCancel && bookingsToCancel.length > 0) {
            cancelledBookingIds.push(...bookingsToCancel.map(b => b.id));

            await supabase
              .from("bookings")
              .update({ status: "cancelled" })
              .in("id", cancelledBookingIds);

            if (notifyPlayers) {
              // v2: ONE call with the COMPLETE set just cancelled. The RPC groups per
              // recipient and gives each only their own sessions — the old per-booking loop
              // sent one mail PER BOOKING, so a player losing a whole cycle got N of them.
              // Called AFTER the cancel update, because the RPC requires cancelled status.
              await enqueueBookingNotification(
                bookingsToCancel.map((bk) => bk.id),
                'cancelled_player',
                'DeleteSlotDialog',
              );
            }
          }

          // Handle invoice updates before deleting slots. Gate only on the bookings
          // ACTUALLY cancelled (across all cycle slots) — not the single-slot
          // affectedInvoices preview, which misses invoices on the cycle's other
          // slots. handleInvoiceUpdates re-resolves the affected invoices itself.
          if (cancelledBookingIds.length > 0) {
            await handleInvoiceUpdates(cancelledBookingIds);
          }

          // Atomic delete via the canonical RPC (same one the cycle-detail view + slot detail use):
          // it locks each candidate slot + its bookings FOR UPDATE, deletes only the empty ones, and
          // KEEPS any that still hold an occupying booking (incl. pending_approval, or one that raced
          // in after the cancel above) — closing the check-then-delete TOCTOU vs the slot_id ON DELETE
          // CASCADE that would otherwise destroy that booking.
          const res = await applySlotDeleteToCycle(slot.cyclus_id, slotIds);
          // The RPC stamps split_count but not invoice line items — rebuild them for the new divisor.
          if (res.deletedCount > 0) {
            try {
              await syncSplitCountForCycle(slot.cyclus_id);
            } catch (e) {
              logger.error("Failed to sync split count after cyclus delete", e instanceof Error ? e : new Error(String(e)), { component: 'DeleteSlotDialog' });
            }
          }

          toast({
            title: t("calendar.cyclusDeleted", "Cyclus deleted"),
            description: t("calendar.cyclusDeletedDescription", "Deleted {{count}} slots and cancelled associated bookings", { count: res.deletedCount }),
          });
        }
      } else {
        // Delete single slot
        if (hasBookings) {
          // Get bookings with player info
          const { data: bookingsToCancel } = await supabase
            .from("bookings")
            .select(`
              id, guest_player_id, player_id,
              guest_players(full_name, email),
              profiles:player_id(full_name, email, user_id)
            `)
            .eq("slot_id", slot.id)
            .in("status", ["pending", "confirmed"]);

          if (bookingsToCancel && bookingsToCancel.length > 0) {
            cancelledBookingIds.push(...bookingsToCancel.map(b => b.id));

            await supabase
              .from("bookings")
              .update({ status: "cancelled" })
              .eq("slot_id", slot.id)
              .in("status", ["pending", "confirmed"]);

            if (notifyPlayers) {
              // Same single call. The slot/trainer lookup that fed the old email is gone:
              // the server derives all of it, so the browser no longer decides who a
              // cancellation is addressed to.
              await enqueueBookingNotification(
                bookingsToCancel.map((bk) => bk.id),
                'cancelled_player',
                'DeleteSlotDialog',
              );
            }
          }
        }

        // Handle invoice updates before deleting the slot.
        if (cancelledBookingIds.length > 0) {
          await handleInvoiceUpdates(cancelledBookingIds);
        }

        // Atomic delete via the canonical RPC (locks the slot + its bookings FOR UPDATE). A slot that
        // still holds an active booking (e.g. a pending_approval one the cancel above doesn't cover,
        // or one that raced in) is KEPT, not cascade-deleted — surfaced as deletedCount === 0.
        const res = await applySlotDeleteToCycle(slot.cyclus_id ?? null, [slot.id]);
        if (res.protectedCount > 0) {
          // A booking protected it (deletedCount 0 + protectedCount 0 = already gone → treat as done).
          toast({
            title: t("calendar.slotHasBooking", "Can't delete this slot"),
            description: t("calendar.slotHasBookingDescription", "It still has an active booking. Cancel the booking first, then delete."),
            variant: "destructive",
          });
          setIsDeleting(false);
          return;
        }
        // Deleting a session from a real cyclus restamps split_count — rebuild the invoice line items.
        if (slot.cyclus_id) {
          try {
            await syncSplitCountForCycle(slot.cyclus_id);
          } catch (e) {
            logger.error("Failed to sync split count after slot delete", e instanceof Error ? e : new Error(String(e)), { component: 'DeleteSlotDialog' });
          }
        }

        toast({
          title: t("calendar.slotDeleted", "Slot deleted"),
          description: t("calendar.slotDeletedDescription", "The time slot has been removed"),
        });
      }

      onSlotDeleted();
      onOpenChange(false);
    } catch (error: unknown) {
      logger.error("Error deleting slot", error instanceof Error ? error : new Error(String(error)), { component: 'DeleteSlotDialog' });
      toast({
        title: t("common:error"),
        description: getFriendlyErrorMessage(error, t("calendar.deleteSlotError", "Could not delete the time slot. Please try again.")),
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  if (!slot) return null;

  const hasBookings = slot.active_bookings > 0 || slot.pending_bookings > 0;
  const hasCyclus = !!slot.cyclus_id;
  const unpaidInvoices = affectedInvoices.filter(i => i.status !== "paid");
  const paidInvoices = affectedInvoices.filter(i => i.status === "paid");

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-destructive" />
            {t("calendar.deleteSlot", "Delete Time Slot")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("calendar.deleteSlotDescription", "This action cannot be undone.")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="py-4 space-y-4">
          {/* Slot info */}
          <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
            <Calendar className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="font-medium">
                {format(new Date(slot.start_time), "EEEE, MMMM d")}
              </p>
              <p className="text-sm text-muted-foreground">
                {format(new Date(slot.start_time), "HH:mm")} -{" "}
                {format(new Date(slot.end_time), "HH:mm")}
                {slot.cyclus_name && ` • ${slot.cyclus_name}`}
              </p>
            </div>
          </div>

          {/* Warning if bookings exist */}
          {hasBookings && (
            <div className="flex items-start gap-3 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
              <div>
                <p className="font-medium text-yellow-800 dark:text-yellow-200">
                  {t("calendar.slotHasBookingsWarning", "This slot has {{count}} active booking(s)", { count: slot.active_bookings + slot.pending_bookings })}
                </p>
                <p className="text-sm text-yellow-700 dark:text-yellow-300">
                  {t("calendar.bookingsWillBeCancelled", "These bookings will be automatically cancelled.")}
                </p>
              </div>
            </div>
          )}

          {/* Invoice warnings */}
          {!isCheckingInvoices && unpaidInvoices.length > 0 && (
            <div className="flex items-start gap-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <Receipt className="h-5 w-5 text-blue-600 mt-0.5" />
              <div>
                <p className="font-medium text-blue-800 dark:text-blue-200">
                  {t("calendar.unpaidInvoiceAffected", "Unpaid invoice will be recalculated")}
                </p>
                <p className="text-sm text-blue-700 dark:text-blue-300">
                  {t("calendar.unpaidInvoiceRecalculate", "Invoice {{number}} will be automatically updated to reflect the removed session(s).", {
                    number: unpaidInvoices.map(i => i.invoice_number).join(", "),
                  })}
                </p>
              </div>
            </div>
          )}

          {!isCheckingInvoices && paidInvoices.length > 0 && (
            <div className="flex items-start gap-3 p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
              <CreditCard className="h-5 w-5 text-orange-600 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-orange-800 dark:text-orange-200">
                  {t("calendar.paidInvoiceAffected", "Paid invoice affected")}
                </p>
                <p className="text-sm text-orange-700 dark:text-orange-300 mb-3">
                  {t("calendar.paidInvoiceWarning", "Invoice {{number}} has already been paid. How would you like to handle this?", {
                    number: paidInvoices.map(i => i.invoice_number).join(", "),
                  })}
                </p>
                <div className="space-y-2">
                  <label className={`flex items-start gap-3 p-2 rounded-md border cursor-pointer transition-colors ${paidInvoiceAction === "credit" ? "border-orange-400 bg-orange-100/50 dark:bg-orange-900/30" : "border-border hover:bg-muted"}`}>
                    <input
                      type="radio"
                      name="paidInvoiceAction"
                      value="credit"
                      checked={paidInvoiceAction === "credit"}
                      onChange={() => setPaidInvoiceAction("credit")}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-medium">{t("calendar.addCreditNote", "Add credit note")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("calendar.addCreditNoteDescription", "A credit note will be added to the invoice. You can arrange compensation (e.g. credit for future sessions) with the player.")}
                      </p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-3 p-2 rounded-md border cursor-pointer transition-colors ${paidInvoiceAction === "proceed" ? "border-orange-400 bg-orange-100/50 dark:bg-orange-900/30" : "border-border hover:bg-muted"}`}>
                    <input
                      type="radio"
                      name="paidInvoiceAction"
                      value="proceed"
                      checked={paidInvoiceAction === "proceed"}
                      onChange={() => setPaidInvoiceAction("proceed")}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-medium">{t("calendar.proceedWithoutChange", "Don't modify invoice")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("calendar.proceedWithoutChangeDescription", "The invoice stays as-is. Handle compensation outside the platform.")}
                      </p>
                    </div>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Delete mode options for cyclus */}
          {hasCyclus && (
            <div className="space-y-3">
              <p className="text-sm font-medium">{t("calendar.deleteOptions", "What would you like to delete?")}</p>
              
              <div className="space-y-2">
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${deleteMode === "single" ? "border-primary bg-primary/5" : "border-border hover:bg-muted"}`}>
                  <input
                    type="radio"
                    name="deleteMode"
                    value="single"
                    checked={deleteMode === "single"}
                    onChange={() => setDeleteMode("single")}
                    className="mt-1"
                  />
                  <div>
                    <p className="font-medium">{t("calendar.deleteThisSlotOnly", "This slot only")}</p>
                    <p className="text-sm text-muted-foreground">
                      {t("calendar.deleteThisSlotOnlyDescription", "Only delete this single time slot")}
                    </p>
                  </div>
                </label>

                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${deleteMode === "cyclus" ? "border-destructive bg-destructive/5" : "border-border hover:bg-muted"}`}>
                  <input
                    type="radio"
                    name="deleteMode"
                    value="cyclus"
                    checked={deleteMode === "cyclus"}
                    onChange={() => setDeleteMode("cyclus")}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <p className="font-medium text-destructive">{t("calendar.deleteEntireCyclus", "Delete entire cyclus")}</p>
                    <p className="text-sm text-muted-foreground mb-2">
                      {t("calendar.deleteEntireCyclusDescription", "Delete slots in '{{name}}'", { name: slot.cyclus_name })}
                    </p>
                    
                    {deleteMode === "cyclus" && (
                      <div className="space-y-2 pt-2 border-t">
                        <p className="text-xs font-medium text-muted-foreground">{t("calendar.deleteScope", "Which slots to delete?")}</p>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="radio"
                            name="deleteScope"
                            value="future"
                            checked={deleteScope === "future"}
                            onChange={() => setDeleteScope("future")}
                          />
                          <span>{t("calendar.deleteFutureOnly", "Future slots only ({{count}} slots)", { count: cyclusSlotCount })}</span>
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="radio"
                            name="deleteScope"
                            value="all"
                            checked={deleteScope === "all"}
                            onChange={() => setDeleteScope("all")}
                          />
                          <span>{t("calendar.deleteAllSlots", "All slots including past ({{count}} slots)", { count: totalCyclusSlotCount })}</span>
                        </label>
                      </div>
                    )}
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Notify players option */}
          {hasBookings && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="notify-players"
                checked={notifyPlayers}
                onCheckedChange={(c) => setNotifyPlayers(!!c)}
              />
              <Label htmlFor="notify-players" className="text-sm font-normal cursor-pointer flex items-center gap-2">
                <Bell className="h-4 w-4" />
                {t("calendar.notifyPlayers", "Notify affected players by email")}
              </Label>
            </div>
          )}
        </div>

        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDeleting}>
            {t("common:cancel")}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isDeleting || isCheckingInvoices}>
            {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {deleteMode === "cyclus" 
              ? t("calendar.deleteCyclus", "Delete Cyclus")
              : t("calendar.deleteSlot", "Delete Slot")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
