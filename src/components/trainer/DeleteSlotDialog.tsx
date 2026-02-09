import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Trash2, AlertTriangle, Loader2, Bell, Calendar } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { sendBookingCancellation } from "@/lib/email";
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
  const [deleteScope, setDeleteScope] = useState<"future" | "all">("future");
  const [notifyPlayers, setNotifyPlayers] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [cyclusSlotCount, setCyclusSlotCount] = useState(0);
  const [totalCyclusSlotCount, setTotalCyclusSlotCount] = useState(0);

  // Reset state and fetch cyclus info when dialog opens
  useEffect(() => {
    if (open) {
      // Reset state when dialog opens
      setDeleteMode("single");
      setDeleteScope("future");
      setNotifyPlayers(true);
      setIsDeleting(false);
      
      if (slot?.cyclus_id) {
        // Fetch both future and total slot counts
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
    }
  }, [open, slot?.cyclus_id]);

  const handleDelete = async () => {
    if (!slot) return;

    setIsDeleting(true);
    try {
      const hasBookings = slot.active_bookings > 0 || slot.pending_bookings > 0;

      if (deleteMode === "cyclus" && slot.cyclus_id) {
        // Get slots in cyclus based on scope selection
        let query = supabase
          .from("availability_slots")
          .select("id")
          .eq("cyclus_id", slot.cyclus_id);
        
        // Only filter to future slots if that scope is selected
        if (deleteScope === "future") {
          query = query.gte("start_time", new Date().toISOString());
        }

        const { data: cyclusSlots, error: fetchError } = await query;

        if (fetchError) throw fetchError;

        const slotIds = cyclusSlots?.map((s) => s.id) || [];

        if (slotIds.length > 0) {
          // Get slot details for email notifications
          const { data: slotsWithDetails } = await supabase
            .from("availability_slots")
            .select(`
              id,
              start_time,
              end_time,
              cyclus_name,
              lessons(title),
              trainer:trainer_profiles(
                id,
                user_id,
                profiles:user_id(full_name, email)
              )
            `)
            .in("id", slotIds);

          // Cancel all bookings for these slots and get player info for notifications
          const { data: bookingsToCancel } = await supabase
            .from("bookings")
            .select(`
              id, 
              slot_id,
              guest_player_id, 
              player_id,
              guest_players(full_name, email),
              profiles:player_id(full_name, email, user_id)
            `)
            .in("slot_id", slotIds)
            .in("status", ["pending", "confirmed"]);

          if (bookingsToCancel && bookingsToCancel.length > 0) {
            await supabase
              .from("bookings")
              .update({ status: "cancelled" })
              .in("id", bookingsToCancel.map((b) => b.id));

            // Send notification emails if notifyPlayers is true
            if (notifyPlayers) {
              for (const booking of bookingsToCancel) {
                const slotDetails = slotsWithDetails?.find(s => s.id === booking.slot_id);
                const trainerProfile = slotDetails?.trainer as any;
                const trainerName = trainerProfile?.profiles?.full_name || "Your trainer";
                const lessonTitle = slotDetails?.cyclus_name || (slotDetails?.lessons as any)?.title || "Training session";
                const lessonDate = slotDetails?.start_time ? format(new Date(slotDetails.start_time), "MMMM d, yyyy") : "";
                const lessonTime = slotDetails?.start_time ? format(new Date(slotDetails.start_time), "HH:mm") : "";

                // Get player info from either guest_players or profiles
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
                  ).catch(err => console.error("Failed to send cancellation email:", err));
                }
              }
            }
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
        if (hasBookings && notifyPlayers) {
          // Get slot details for email notifications
          const { data: slotWithDetails } = await supabase
            .from("availability_slots")
            .select(`
              id,
              start_time,
              end_time,
              cyclus_name,
              lessons(title),
              trainer:trainer_profiles(
                id,
                user_id,
                profiles:user_id(full_name, email)
              )
            `)
            .eq("id", slot.id)
            .single();

          // Get bookings with player info
          const { data: bookingsToCancel } = await supabase
            .from("bookings")
            .select(`
              id,
              guest_player_id,
              player_id,
              guest_players(full_name, email),
              profiles:player_id(full_name, email, user_id)
            `)
            .eq("slot_id", slot.id)
            .in("status", ["pending", "confirmed"]);

          if (bookingsToCancel && bookingsToCancel.length > 0) {
            // Cancel bookings
            await supabase
              .from("bookings")
              .update({ status: "cancelled" })
              .eq("slot_id", slot.id)
              .in("status", ["pending", "confirmed"]);

            // Send notifications
            const trainerProfile = slotWithDetails?.trainer as any;
            const trainerName = trainerProfile?.profiles?.full_name || "Your trainer";
            const lessonTitle = slotWithDetails?.cyclus_name || (slotWithDetails?.lessons as any)?.title || "Training session";
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
                ).catch(err => console.error("Failed to send cancellation email:", err));
              }
            }
          }
        } else if (hasBookings) {
          // Cancel bookings without notification
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
