import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Trash2, AlertTriangle, Loader2, Bell, Calendar } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
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
  const [notifyPlayers, setNotifyPlayers] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [cyclusSlotCount, setCyclusSlotCount] = useState(0);

  // Reset state and fetch cyclus info when dialog opens
  useEffect(() => {
    if (open) {
      // Reset state when dialog opens
      setDeleteMode("single");
      setNotifyPlayers(true);
      setIsDeleting(false);
      
      if (slot?.cyclus_id) {
        supabase
          .from("availability_slots")
          .select("id", { count: "exact" })
          .eq("cyclus_id", slot.cyclus_id)
          .gte("start_time", new Date().toISOString())
          .then(({ count }) => {
            setCyclusSlotCount(count || 0);
          });
      } else {
        setCyclusSlotCount(0);
      }
    }
  }, [open, slot?.cyclus_id]);

  const handleDelete = async () => {
    if (!slot) return;

    setIsDeleting(true);
    try {
      const hasBookings = slot.active_bookings > 0 || slot.pending_bookings > 0;

      if (deleteMode === "cyclus" && slot.cyclus_id) {
        // Get all future slots in cyclus
        const { data: cyclusSlots, error: fetchError } = await supabase
          .from("availability_slots")
          .select("id")
          .eq("cyclus_id", slot.cyclus_id)
          .gte("start_time", new Date().toISOString());

        if (fetchError) throw fetchError;

        const slotIds = cyclusSlots?.map((s) => s.id) || [];

        if (slotIds.length > 0) {
          // Cancel all bookings for these slots
          const { data: bookingsToCancel } = await supabase
            .from("bookings")
            .select("id, guest_player_id, player_id")
            .in("slot_id", slotIds)
            .in("status", ["pending", "confirmed"]);

          if (bookingsToCancel && bookingsToCancel.length > 0) {
            await supabase
              .from("bookings")
              .update({ status: "cancelled" })
              .in("id", bookingsToCancel.map((b) => b.id));

            // TODO: Send notification emails if notifyPlayers is true
          }

          // Delete all slots
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
          // Cancel bookings first
          await supabase
            .from("bookings")
            .update({ status: "cancelled" })
            .eq("slot_id", slot.id)
            .in("status", ["pending", "confirmed"]);
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
      console.error("Error deleting slot:", error);
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
                {slot.lesson_title && ` • ${slot.lesson_title}`}
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
                  <div>
                    <p className="font-medium text-destructive">{t("calendar.deleteEntireCyclus", "Delete entire cyclus")}</p>
                    <p className="text-sm text-muted-foreground">
                      {t("calendar.deleteEntireCyclusDescription", "Delete all {{count}} future slots in '{{name}}'", { count: cyclusSlotCount, name: slot.cyclus_name })}
                    </p>
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
          <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
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
