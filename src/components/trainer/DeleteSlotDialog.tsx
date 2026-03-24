import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Trash2, AlertTriangle, Loader2, Bell, Calendar, Receipt, CreditCard } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { sendBookingCancellation } from "@/lib/email";
import { logger } from "@/lib/logger";
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
import { SlotWithBookings } from "./CalendarSlotCard";

interface DeleteSlotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slot: SlotWithBookings | null;
  trainerId: string;
  onSlotDeleted: () => void;
}

interface InvoiceInfo {
  id: string;
  invoice_number: string;
  status: string;
  booking_ids: string[];
  total: number;
  vat_rate: number;
  line_items: any[];
}

export function DeleteSlotDialog({
  open,
  onOpenChange,
  slot,
  trainerId,
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
        .in("status", ["sent", "paid", "pending"])
        .overlaps("booking_ids", bookingIds);

      setAffectedInvoices((invoices || []).map(inv => ({
        ...inv,
        booking_ids: inv.booking_ids || [],
        line_items: inv.line_items as any[] || [],
      })));
    } catch (err) {
      logger.error("Error checking invoices", err instanceof Error ? err : new Error(String(err)), { component: 'DeleteSlotDialog' });
    } finally {
      setIsCheckingInvoices(false);
    }
  };

  const recalculateInvoice = async (invoice: InvoiceInfo, removedBookingIds: string[]) => {
    const remainingBookingIds = invoice.booking_ids.filter(id => !removedBookingIds.includes(id));
    
    if (remainingBookingIds.length === 0) {
      // All bookings removed — mark invoice as credited/cancelled
      await supabase
        .from("invoices")
        .update({ 
          status: "credited",
          booking_ids: [],
          line_items: [],
          subtotal: 0,
          vat_amount: 0,
          total: 0,
          notes: t("calendar.invoiceCreditedNote", "Invoice credited — all sessions were cancelled"),
        })
        .eq("id", invoice.id);
      return;
    }

    // Fetch remaining bookings to recalculate
    const { data: remainingBookings } = await supabase
      .from("bookings")
      .select(`
        id, payment_amount,
        availability_slots!inner(price_per_session, cyclus_id, cyclus_name, start_time, locations(name), prices_include_vat, extra_costs)
      `)
      .in("id", remainingBookingIds);

    if (!remainingBookings || remainingBookings.length === 0) return;

    const firstSlot = remainingBookings[0].availability_slots as any;
    const sharedCyclusId = firstSlot.cyclus_id;
    const allSameCyclus = sharedCyclusId && remainingBookings.every(b => (b.availability_slots as any).cyclus_id === sharedCyclusId);

    let lineItems: { description: string; quantity: number; unit_price: number; date?: string }[];

    if (allSameCyclus) {
      const cyclusName = firstSlot.cyclus_name || "Training cyclus";
      const pricePerSession = remainingBookings[0].payment_amount || firstSlot.price_per_session || 0;
      lineItems = [{
        description: `${cyclusName} (${remainingBookings.length} weken)`,
        quantity: remainingBookings.length,
        unit_price: pricePerSession,
      }];
    } else {
      lineItems = remainingBookings.map(b => {
        const bSlot = b.availability_slots as any;
        const startTime = new Date(bSlot.start_time);
        const locationName = bSlot.locations?.name || "";
        const description = bSlot.cyclus_name
          ? `${bSlot.cyclus_name} - ${startTime.toLocaleDateString("nl-NL")} ${startTime.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}${locationName ? ` (${locationName})` : ""}`
          : `Training sessie - ${startTime.toLocaleDateString("nl-NL")}`;
        return {
          description,
          quantity: 1,
          unit_price: b.payment_amount || bSlot.price_per_session || 0,
          date: startTime.toISOString().split("T")[0],
        };
      });
    }

    // Add extra costs from cycle settings, fall back to slot extra_costs
    let extraCosts: any[] | null = null;

    if (sharedCyclusId) {
      const { data: cycleData } = await supabase
        .from("cycles")
        .select("settings")
        .eq("id", sharedCyclusId)
        .maybeSingle();

      extraCosts = (cycleData?.settings as any)?.extra_costs || null;
    }

    // Fallback: use extra_costs from the first slot if no cycle-level costs
    if (!extraCosts || !Array.isArray(extraCosts) || extraCosts.length === 0) {
      const slotExtraCosts = (remainingBookings[0].availability_slots as any).extra_costs;
      if (slotExtraCosts && Array.isArray(slotExtraCosts)) {
        extraCosts = slotExtraCosts;
      }
    }

    if (extraCosts && Array.isArray(extraCosts)) {
      for (const ec of extraCosts) {
        if (ec.description && ec.price > 0) {
          const isOneTime = ec.type === 'one_time';
          lineItems.push({
            description: isOneTime ? ec.description : `${ec.description} (per sessie)`,
            quantity: isOneTime ? 1 : remainingBookings.length,
            unit_price: ec.price,
          });
        }
      }
    }

    const vatRate = invoice.vat_rate || 21;
    const slotPricesIncludeVat = (remainingBookings[0].availability_slots as any).prices_include_vat ?? true;
    const lineItemTotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);

    let subtotal: number, vatAmount: number, totalInclusive: number;
    if (slotPricesIncludeVat) {
      totalInclusive = lineItemTotal;
      subtotal = totalInclusive / (1 + vatRate / 100);
      vatAmount = totalInclusive - subtotal;
    } else {
      subtotal = lineItemTotal;
      vatAmount = subtotal * (vatRate / 100);
      totalInclusive = subtotal + vatAmount;
    }

    await supabase
      .from("invoices")
      .update({
        booking_ids: remainingBookingIds,
        line_items: lineItems,
        subtotal: Math.round(subtotal * 100) / 100,
        vat_amount: Math.round(vatAmount * 100) / 100,
        total: Math.round(totalInclusive * 100) / 100,
      })
      .eq("id", invoice.id);

    // Regenerate PDF
    try {
      await supabase.functions.invoke("generate-invoice", {
        body: { invoiceId: invoice.id },
      });
    } catch (err) {
      logger.error("Failed to regenerate invoice PDF", err instanceof Error ? err : new Error(String(err)), { component: 'DeleteSlotDialog' });
    }
  };

  const handleInvoiceUpdates = async (cancelledBookingIds: string[]) => {
    for (const invoice of affectedInvoices) {
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
          const { data: slotsWithDetails } = await supabase
            .from("availability_slots")
            .select(`
              id, start_time, end_time, cyclus_name,
              trainer:trainer_profiles(id, user_id, profiles:user_id(full_name, email))
            `)
            .in("id", slotIds);

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
              for (const booking of bookingsToCancel) {
                const slotDetails = slotsWithDetails?.find(s => s.id === booking.slot_id);
                const trainerProfile = slotDetails?.trainer as any;
                const trainerName = trainerProfile?.profiles?.full_name || "Your trainer";
                const lessonTitle = slotDetails?.cyclus_name || "Training session";
                const lessonDate = slotDetails?.start_time ? format(new Date(slotDetails.start_time), "MMMM d, yyyy") : "";
                const lessonTime = slotDetails?.start_time ? format(new Date(slotDetails.start_time), "HH:mm") : "";

                const playerInfo = booking.guest_player_id 
                  ? (booking.guest_players as any)
                  : (booking.profiles as any);

                if (playerInfo?.email) {
                  sendBookingCancellation(
                    playerInfo.email,
                    playerInfo.full_name || "Player",
                    trainerName,
                    lessonTitle,
                    lessonDate,
                    lessonTime
                  ).catch(err => logger.error("Failed to send cancellation email", err instanceof Error ? err : new Error(String(err)), { component: 'DeleteSlotDialog' }));
                }
              }
            }
          }

          // Handle invoice updates before deleting slots
          if (cancelledBookingIds.length > 0 && affectedInvoices.length > 0) {
            await handleInvoiceUpdates(cancelledBookingIds);
          }

          const { error: deleteError } = await supabase
            .from("availability_slots")
            .delete()
            .in("id", slotIds);

          if (deleteError) throw deleteError;

          toast({
            title: t("calendar.cyclusDeleted", "Cyclus deleted"),
            description: t("calendar.cyclusDeletedDescription", "Deleted {{count}} slots and cancelled associated bookings", { count: slotIds.length }),
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
              const { data: slotWithDetails } = await supabase
                .from("availability_slots")
                .select(`
                  id, start_time, end_time, cyclus_name,
                  trainer:trainer_profiles(id, user_id, profiles:user_id(full_name, email))
                `)
                .eq("id", slot.id)
                .single();

              const trainerProfile = slotWithDetails?.trainer as any;
              const trainerName = trainerProfile?.profiles?.full_name || "Your trainer";
              const lessonTitle = slotWithDetails?.cyclus_name || "Training session";
              const lessonDate = slotWithDetails?.start_time ? format(new Date(slotWithDetails.start_time), "MMMM d, yyyy") : "";
              const lessonTime = slotWithDetails?.start_time ? format(new Date(slotWithDetails.start_time), "HH:mm") : "";

              for (const booking of bookingsToCancel) {
                const playerInfo = booking.guest_player_id 
                  ? (booking.guest_players as any)
                  : (booking.profiles as any);

                if (playerInfo?.email) {
                  sendBookingCancellation(
                    playerInfo.email,
                    playerInfo.full_name || "Player",
                    trainerName,
                    lessonTitle,
                    lessonDate,
                    lessonTime
                  ).catch(err => logger.error("Failed to send cancellation email", err instanceof Error ? err : new Error(String(err)), { component: 'DeleteSlotDialog' }));
                }
              }
            }
          }
        }

        // Handle invoice updates before deleting the slot
        if (cancelledBookingIds.length > 0 && affectedInvoices.length > 0) {
          await handleInvoiceUpdates(cancelledBookingIds);
        }

        const { error } = await supabase
          .from("availability_slots")
          .delete()
          .eq("id", slot.id);

        if (error) throw error;

        toast({
          title: t("calendar.slotDeleted", "Slot deleted"),
          description: t("calendar.slotDeletedDescription", "The time slot has been removed"),
        });
      }

      onSlotDeleted();
      onOpenChange(false);
    } catch (error: any) {
      logger.error("Error deleting slot", error instanceof Error ? error : new Error(String(error)), { component: 'DeleteSlotDialog' });
      toast({
        title: t("common:error"),
        description: error.message,
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
