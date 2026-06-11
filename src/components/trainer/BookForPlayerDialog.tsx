import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { format, differenceInMinutes } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabaseClient";
import { invalidateAllPlayerData } from "@/lib/playerQueryKeys";
import {
  syncInvoicesAfterAddPlayer,
  applyAddPlayerInvoiceChoice,
  getInvoiceFollowUpMessages,
  type InvoiceAfterAddPlayerResult,
} from "@/lib/invoiceAfterAddPlayer";
import { buildAffectedInvoicesSummary, type AffectedInvoicesSummary } from "@/lib/affectedInvoices";
import type { InvoiceUpdateChoice } from "@/lib/invoiceUpdateChoice";
import { UpdateAffectedInvoicesDialog } from "@/components/invoices/UpdateAffectedInvoicesDialog";
import {
  shouldDeferAddPlayerClose,
  shouldWarnInvoiceCreateFailure,
} from "@/lib/addPlayerInvoiceFlow";
import {
  buildCyclusSlotAddPlayerBookings,
  buildSingleSlotAddPlayerBookings,
} from "@/lib/bookForPlayerBooking";
import {
  getSelectedGuestPlayerIds,
  normalizePayerId,
  shouldShowPayerSelector,
} from "@/lib/cyclePayerSelection";
import {
  calculateSlotBookingPricing,
  countActiveBookings,
  resolveSlotSessionPrice,
} from "@/lib/bookingPricing";
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
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GuestPlayerSlotCombobox } from "./GuestPlayerSlotCombobox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Loader2, UserPlus, Clock, Calendar, Repeat, X, Check, Users, Percent, ChevronDown, Euro } from "lucide-react";
import { AddPlayerDialog, GuestPlayer } from "./AddPlayerDialog";
import { loadActiveGuestPlayersForBooking } from "@/lib/guestPlayers";
import { Badge } from "@/components/ui/badge";
import { BookedPlayer } from "./CalendarSlotCard";
import { cn } from "@/lib/utils";
import { calculateSlotPrice, applyDiscount, formatPrice } from "@/lib/pricing";
import { logger } from "@/lib/logger";

// Lesson interface removed - pricing now on slots

/**
 * loadActiveGuestPlayersForBooking selects '*', so rows carry the billing
 * fields; declaring billing_business_name here lets the player combobox
 * search on business name.
 */
type BookableGuestPlayer = GuestPlayer & {
  billing_business_name?: string | null;
};

interface Slot {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id?: string | null;
  cyclus_name?: string | null;
  price_per_session?: number | null;
  split_payment?: boolean;
  booked_players?: BookedPlayer[];
}

type CyclusSlotRow = {
  id: string;
  start_time: string;
  end_time: string;
  price_per_session?: number | null;
};

type ExistingBookingRow = {
  id: string;
  slot_id: string;
  payment_status: string | null;
  paid_externally: boolean | null;
};

interface BookForPlayerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string;
  /** When booking from academy calendar/slot detail, also hide academy-removed players. */
  academyProfileId?: string | null;
  slot: Slot | null;
  onBookingCreated?: () => void;
}

const EMPTY_PLAYER_SLOTS = ["", "", "", ""];

const INSERTED_BOOKING_SELECT =
  "id, slot_id, guest_player_id, player_id, payment_amount, payment_status, paid_externally";

export function BookForPlayerDialog({
  open,
  onOpenChange,
  trainerId,
  academyProfileId,
  slot,
  onBookingCreated,
}: BookForPlayerDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [players, setPlayers] = useState<BookableGuestPlayer[]>([]);
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<string[]>(EMPTY_PLAYER_SLOTS);
  const [notes, setNotes] = useState("");
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [bookingScope, setBookingScope] = useState<"single" | "cyclus">("single");
  const [cyclusSlotsCount, setCyclusSlotsCount] = useState(0);
  const [cyclusSlots, setCyclusSlots] = useState<CyclusSlotRow[]>([]);
  const [hourlyRate, setHourlyRate] = useState<number>(50);
  const [slotSplitPayment, setSlotSplitPayment] = useState(false);
  const [slotPricePerSession, setSlotPricePerSession] = useState<number | null>(null);
  const [invoicePayerGuestPlayerId, setInvoicePayerGuestPlayerId] = useState<string | null>(null);
  
  // Discount state
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountType, setDiscountType] = useState<"percentage" | "fixed">("percentage");
  const [discountValue, setDiscountValue] = useState<number>(0);
  const [discountReason, setDiscountReason] = useState("");
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [invoiceDialogSummary, setInvoiceDialogSummary] = useState<AffectedInvoicesSummary | null>(null);
  const [pendingInvoiceSlotIds, setPendingInvoiceSlotIds] = useState<string[]>([]);
  const [pendingInvoiceResult, setPendingInvoiceResult] = useState<
    Awaited<ReturnType<typeof syncInvoicesAfterAddPlayer>> | null
  >(null);
  const [invoiceConfirmLoading, setInvoiceConfirmLoading] = useState(false);
  const closingInvoiceDialogFromChoiceRef = useRef(false);

  useEffect(() => {
    if (open && trainerId) {
      fetchPlayers();
      fetchHourlyRate();
      if (slot?.id) {
        fetchSlotPricingMeta(slot.id);
      }
      if (slot?.cyclus_id) {
        fetchCyclusSlots(slot.cyclus_id);
      }
    }
  }, [open, trainerId, slot?.id, slot?.cyclus_id]);

  useEffect(() => {
    if (slot?.split_payment != null) {
      setSlotSplitPayment(Boolean(slot.split_payment));
    }
    if (slot?.price_per_session != null) {
      setSlotPricePerSession(slot.price_per_session);
    }
  }, [slot?.split_payment, slot?.price_per_session]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedPlayerIds(EMPTY_PLAYER_SLOTS);
      setNotes("");
      setBookingScope("single");
      setCyclusSlotsCount(0);
      setCyclusSlots([]);
      setShowDiscount(false);
      setDiscountType("percentage");
      setDiscountValue(0);
      setDiscountReason("");
      setInvoicePayerGuestPlayerId(null);
    }
  }, [open]);

  const fetchHourlyRate = async () => {
    try {
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("hourly_rate")
        .eq("id", trainerId)
        .single();
      
      if (error) throw error;
      if (data?.hourly_rate) {
        setHourlyRate(data.hourly_rate);
      }
    } catch (error) {
      logger.error("Error fetching hourly rate", error as Error, { component: "BookForPlayerDialog" });
    }
  };

  const fetchPlayers = async () => {
    setIsFetching(true);
    try {
      const { data, error } = await loadActiveGuestPlayersForBooking(trainerId, academyProfileId);
      if (error) throw error;
      setPlayers(data as BookableGuestPlayer[]);
    } catch (error: any) {
      logger.error("Error fetching players", error as Error, { component: "BookForPlayerDialog" });
    } finally {
      setIsFetching(false);
    }
  };

  const fetchSlotPricingMeta = async (slotId: string) => {
    try {
      const { data, error } = await supabase
        .from("availability_slots")
        .select("split_payment, price_per_session")
        .eq("id", slotId)
        .maybeSingle();

      if (error) throw error;
      if (data) {
        setSlotSplitPayment(Boolean(data.split_payment));
        setSlotPricePerSession(data.price_per_session);
      }
    } catch (error) {
      logger.error("Error fetching slot pricing", error as Error, { component: "BookForPlayerDialog" });
    }
  };

  const fetchCyclusSlots = async (cyclusId: string) => {
    try {
      const { data, error } = await supabase
        .from("availability_slots")
        .select("id, start_time, end_time, price_per_session")
        .eq("cyclus_id", cyclusId)
        .gte("start_time", new Date().toISOString())
        .order("start_time");

      if (error) throw error;
      setCyclusSlots(data || []);
      setCyclusSlotsCount(data?.length || 0);
    } catch (error) {
      logger.error("Error fetching cyclus slots", error as Error, { component: "BookForPlayerDialog" });
    }
  };

  const fetchExistingBookingsBySlot = async (
    slotIds: string[],
  ): Promise<Map<string, ExistingBookingRow[]>> => {
    const { data, error } = await supabase
      .from("bookings")
      .select("id, slot_id, payment_status, paid_externally")
      .in("slot_id", slotIds)
      .in("status", ["confirmed", "pending"]);

    if (error) throw error;

    const bySlot = new Map<string, ExistingBookingRow[]>();
    for (const row of data || []) {
      const list = bySlot.get(row.slot_id) || [];
      list.push(row);
      bySlot.set(row.slot_id, list);
    }
    return bySlot;
  };

  const rebalanceExistingOnSlot = async (
    slotId: string,
    rebalanceIds: string[],
    amount: number,
    sessionPriceForOriginal: number,
  ): Promise<void> => {
    if (rebalanceIds.length === 0) return;

    const { error } = await supabase
      .from("bookings")
      .update({
        payment_amount: amount,
        original_amount: sessionPriceForOriginal,
        discount_amount: 0,
      })
      .in("id", rebalanceIds);

    if (error) {
      logger.error("Failed to rebalance booking amounts", error, {
        component: "BookForPlayerDialog",
        slotId,
        rebalanceIds,
        amount,
      });
      throw error;
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
      syncPayerAfterSelectionChange(newIds);
    }
    setShowAddPlayer(false);
  };

  const syncPayerAfterSelectionChange = (newIds: string[]) => {
    setSelectedPlayerIds(newIds);
    const guestIds = getSelectedGuestPlayerIds(newIds);
    setInvoicePayerGuestPlayerId((current) => normalizePayerId(guestIds, current));
  };

  const handlePlayerSelect = (index: number, playerId: string) => {
    const newIds = [...selectedPlayerIds];
    newIds[index] = playerId;
    syncPayerAfterSelectionChange(newIds);
  };

  const clearPlayerSlot = (index: number) => {
    const newIds = [...selectedPlayerIds];
    newIds[index] = "";
    syncPayerAfterSelectionChange(newIds);
  };

  const selectedGuestIds = getSelectedGuestPlayerIds(selectedPlayerIds);
  const selectedCount = selectedGuestIds.length;
  const hasAtLeastOnePlayer = selectedCount > 0;
  const showInvoicePayerSelector = shouldShowPayerSelector(slotSplitPayment, selectedGuestIds);

  // Calculate price based on slot duration and hourly rate
  const slotDurationMinutes = slot 
    ? differenceInMinutes(new Date(slot.end_time), new Date(slot.start_time))
    : 60;
  const pricePerSession = calculateSlotPrice(hourlyRate, slotDurationMinutes);
  
  // Calculate total based on scope and number of players
  const sessionsCount = bookingScope === "cyclus" && cyclusSlotsCount > 1 ? cyclusSlotsCount : 1;
  const subtotal = pricePerSession * sessionsCount * selectedCount;
  
  // Apply discount
  const { finalAmount, discountAmount: calculatedDiscount } = applyDiscount(
    subtotal,
    discountType,
    discountValue
  );
  
  // Price per player for bookings
  const totalDiscountPerPlayer = selectedCount > 0 ? calculatedDiscount / selectedCount : 0;
  const finalPricePerPlayer = selectedCount > 0 ? finalAmount / selectedCount : 0;

  const showInvoiceFollowUpToasts = (
    invoiceResult: Awaited<ReturnType<typeof syncInvoicesAfterAddPlayer>>,
    sentWasUpdated: boolean,
  ) => {
    const followUp = getInvoiceFollowUpMessages(invoiceResult, { sentWasUpdated });
    if (followUp.paidUnchanged) {
      toast({ title: t("invoices.paidUnchanged", followUp.paidUnchanged) });
    }
    if (followUp.sentUpdated) {
      toast({ title: t("invoices.sentUpdated", followUp.sentUpdated) });
    }
    if (followUp.sentNotUpdated) {
      toast({ title: t("invoices.sentUnchanged", followUp.sentNotUpdated) });
    }
  };

  const runInvoicesAfterAddPlayer = async (
    insertedBookings: {
      id: string;
      slot_id: string;
      guest_player_id: string | null;
      player_id: string | null;
      payment_amount: number | null;
      payment_status: string;
      paid_externally: boolean | null;
    }[],
    affectedSlotIds: string[],
    splitPayment: boolean,
  ): Promise<InvoiceAfterAddPlayerResult> => {
    const invoiceResult = await syncInvoicesAfterAddPlayer({
      newBookings: insertedBookings,
      splitPayment,
      slotIds: affectedSlotIds,
      cyclusId: slot?.cyclus_id,
    });

    if (shouldWarnInvoiceCreateFailure(invoiceResult)) {
      toast({
        title: t("bookings.invoiceNotCreatedTitle", "Player added, but invoice was not created."),
        description: t(
          "bookings.invoiceNotCreatedDescription",
          "Check invoice business settings or try creating the invoice manually.",
        ),
        variant: "destructive",
      });
    }

    if (invoiceResult.needsConfirmation) {
      setPendingInvoiceSlotIds(affectedSlotIds);
      setPendingInvoiceResult(invoiceResult);
      setInvoiceDialogSummary(buildAffectedInvoicesSummary(invoiceResult.classification));
      setInvoiceDialogOpen(true);
      return invoiceResult;
    }

    showInvoiceFollowUpToasts(invoiceResult, false);
    return invoiceResult;
  };

  const finishDialogAfterBooking = () => {
    setSelectedPlayerIds(EMPTY_PLAYER_SLOTS);
    setNotes("");
    setBookingScope("single");
    onOpenChange(false);
    onBookingCreated?.();
  };

  const handleInvoiceUpdateChoice = async (choice: InvoiceUpdateChoice) => {
    closingInvoiceDialogFromChoiceRef.current = true;
    setInvoiceConfirmLoading(true);
    try {
      if (choice !== "skip" && pendingInvoiceSlotIds.length > 0) {
        await applyAddPlayerInvoiceChoice(pendingInvoiceSlotIds, choice);
      }
      if (pendingInvoiceResult) {
        showInvoiceFollowUpToasts(
          pendingInvoiceResult,
          choice === "update_drafts_and_sent",
        );
      }
    } catch (err) {
      logger.warn("Invoice update choice failed", {
        component: "BookForPlayerDialog",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setInvoiceConfirmLoading(false);
      setInvoiceDialogOpen(false);
      setPendingInvoiceSlotIds([]);
      setPendingInvoiceResult(null);
      setInvoiceDialogSummary(null);
      finishDialogAfterBooking();
      closingInvoiceDialogFromChoiceRef.current = false;
    }
  };

  const handleInvoiceDialogOpenChange = (open: boolean) => {
    if (
      !open &&
      invoiceDialogOpen &&
      !invoiceConfirmLoading &&
      !closingInvoiceDialogFromChoiceRef.current
    ) {
      void handleInvoiceUpdateChoice("skip");
      return;
    }
    setInvoiceDialogOpen(open);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slot || !hasAtLeastOnePlayer) return;

    setIsLoading(true);

    const notesValue = notes.trim() || null;
    const guestPlayerIds = getSelectedGuestPlayerIds(selectedPlayerIds);
    let rebalanceFailed = false;
    let deferDialogClose = false;

    try {
      const selectedPlayers = guestPlayerIds
        .map((id) => players.find((p) => p.id === id)!)
        .filter(Boolean);

      const splitPayment = slotSplitPayment;

      if (bookingScope === "cyclus" && slot.cyclus_id && cyclusSlots.length > 0) {
        const slotsToBook = cyclusSlots;

        if (slotsToBook.length === 0) {
          throw new Error("No future slots found in this cyclus");
        }

        const bySlot = await fetchExistingBookingsBySlot(slotsToBook.map((s) => s.id));

        const bookingsToInsert = slotsToBook.flatMap((cyclusSlot, slotIndex) => {
          const slotDuration = differenceInMinutes(
            new Date(cyclusSlot.end_time),
            new Date(cyclusSlot.start_time),
          );
          const sessionPrice = resolveSlotSessionPrice(
            cyclusSlot.price_per_session ?? slotPricePerSession,
            hourlyRate,
            slotDuration,
          );
          const existingOnSlot = (bySlot.get(cyclusSlot.id) || []).length;

          return buildCyclusSlotAddPlayerBookings({
            slotId: cyclusSlot.id,
            sessionPrice,
            splitPayment,
            existingActiveBookingCount: existingOnSlot,
            guestPlayerIds,
            payerGuestPlayerId: invoicePayerGuestPlayerId,
            notes: notesValue,
            firstPlayerDiscount: totalDiscountPerPlayer,
            discountReason: discountReason || null,
            isFirstCyclusSlot: slotIndex === 0,
          });
        });

        const { data: insertedRows, error: bookingError } = await supabase
          .from("bookings")
          .insert(bookingsToInsert)
          .select(INSERTED_BOOKING_SELECT);

        if (bookingError) throw bookingError;

        for (const cyclusSlot of slotsToBook) {
          const slotDuration = differenceInMinutes(
            new Date(cyclusSlot.end_time),
            new Date(cyclusSlot.start_time),
          );
          const sessionPrice = resolveSlotSessionPrice(
            cyclusSlot.price_per_session ?? slotPricePerSession,
            hourlyRate,
            slotDuration,
          );
          const existingOnSlot = (bySlot.get(cyclusSlot.id) || []).length;
          const pricing = calculateSlotBookingPricing({
            sessionPrice,
            splitPayment,
            existingActiveBookingCount: existingOnSlot,
            newPlayerCount: selectedPlayers.length,
          });

          if (!pricing.shouldRebalanceExisting || pricing.existingBookingsNewAmount == null) {
            continue;
          }

          const rebalanceIds = (bySlot.get(cyclusSlot.id) || [])
            .filter((b) => b.payment_status !== "paid" && !b.paid_externally)
            .map((b) => b.id);

          try {
            await rebalanceExistingOnSlot(
              cyclusSlot.id,
              rebalanceIds,
              pricing.existingBookingsNewAmount,
              pricing.sessionPrice,
            );
          } catch (rebalanceError) {
            rebalanceFailed = true;
            logger.error(
              "Cyclus slot rebalance failed after insert",
              rebalanceError instanceof Error ? rebalanceError : new Error(String(rebalanceError)),
              { component: "BookForPlayerDialog", slotId: cyclusSlot.id },
            );
          }
        }

        const guestIds = selectedPlayers.map((p) => p.id);
        if (guestIds.length > 0) {
          await supabase.from("guest_players").update({ has_trained: true }).in("id", guestIds);
          invalidateAllPlayerData(queryClient, { kind: "trainer", id: trainerId });
          if (academyProfileId) invalidateAllPlayerData(queryClient, { kind: "academy", id: academyProfileId });
        }

        let invoiceResult: InvoiceAfterAddPlayerResult | null = null;
        if (insertedRows?.length) {
          invoiceResult = await runInvoicesAfterAddPlayer(
            insertedRows,
            slotsToBook.map((s) => s.id),
            splitPayment,
          );
          deferDialogClose = invoiceResult != null && shouldDeferAddPlayerClose(invoiceResult);
        }

        // Send email notifications
        const firstSlot = slotsToBook[0];
        const lastSlot = slotsToBook[slotsToBook.length - 1];
        
        const { data: { session } } = await supabase.auth.getSession();
        await Promise.all(
          selectedPlayers.map(player =>
            supabase.functions.invoke("send-email", {
              body: {
                type: "manual_booking_confirmation",
                to: player.email,
                data: {
                  playerName: player.full_name,
                  lessonTitle: `${slot.cyclus_name || t("bookings.lesson")} (${slotsToBook.length} ${t("calendar.sessions")})`,
                  lessonDate: `${format(new Date(firstSlot.start_time), "MMM d")} - ${format(new Date(lastSlot.start_time), "MMM d, yyyy")}`,
                  lessonTime: `${format(new Date(firstSlot.start_time), "HH:mm")} - ${format(new Date(firstSlot.end_time), "HH:mm")}`,
                  location: null,
                  price: finalPricePerPlayer,
                },
              },
              headers: {
                Authorization: `Bearer ${session?.access_token}`,
              },
            }).catch(err => logger.warn("Email notification failed", { error: err?.message }))
          )
        );

        const totalBookings = selectedPlayers.length * slotsToBook.length;
        toast({
          title: t("bookings.bookingCreated"),
          description: t("bookings.multiBookingCreated", { 
            players: selectedPlayers.length, 
            sessions: slotsToBook.length,
            total: totalBookings
          }),
        });
      } else {
        const sessionPrice = resolveSlotSessionPrice(
          slotPricePerSession,
          hourlyRate,
          slotDurationMinutes,
        );
        const existingActiveCount = countActiveBookings(slot.booked_players);

        const bookingsToInsert = buildSingleSlotAddPlayerBookings({
          slotId: slot.id,
          sessionPrice,
          splitPayment,
          existingActiveBookingCount: existingActiveCount,
          guestPlayerIds,
          payerGuestPlayerId: invoicePayerGuestPlayerId,
          notes: notesValue,
          firstPlayerDiscount: calculatedDiscount,
          discountReason: discountReason || null,
        });

        const { data: insertedRows, error: bookingError } = await supabase
          .from("bookings")
          .insert(bookingsToInsert)
          .select(INSERTED_BOOKING_SELECT);

        if (bookingError) throw bookingError;

        const pricing = calculateSlotBookingPricing({
          sessionPrice,
          splitPayment,
          existingActiveBookingCount: existingActiveCount,
          newPlayerCount: selectedPlayers.length,
        });

        if (pricing.shouldRebalanceExisting && pricing.existingBookingsNewAmount != null) {
          const rebalanceIds = (slot.booked_players || [])
            .filter((p) => p.paymentStatus !== "paid" && !p.paidExternally)
            .map((p) => p.bookingId);

          try {
            await rebalanceExistingOnSlot(
              slot.id,
              rebalanceIds,
              pricing.existingBookingsNewAmount,
              pricing.sessionPrice,
            );
          } catch (rebalanceError) {
            rebalanceFailed = true;
            logger.error(
              "Slot rebalance failed after insert",
              rebalanceError instanceof Error ? rebalanceError : new Error(String(rebalanceError)),
              { component: "BookForPlayerDialog", slotId: slot.id },
            );
          }
        }

        const singleGuestIds = selectedPlayers.map((p) => p.id);
        if (singleGuestIds.length > 0) {
          await supabase.from("guest_players").update({ has_trained: true }).in("id", singleGuestIds);
          invalidateAllPlayerData(queryClient, { kind: "trainer", id: trainerId });
          if (academyProfileId) invalidateAllPlayerData(queryClient, { kind: "academy", id: academyProfileId });
        }

        let invoiceResult: InvoiceAfterAddPlayerResult | null = null;
        if (insertedRows?.length) {
          invoiceResult = await runInvoicesAfterAddPlayer(insertedRows, [slot.id], splitPayment);
          deferDialogClose = invoiceResult != null && shouldDeferAddPlayerClose(invoiceResult);
        }

        // Send email notifications
        const { data: { session: emailSession } } = await supabase.auth.getSession();
        await Promise.all(
          selectedPlayers.map(player =>
            supabase.functions.invoke("send-email", {
              body: {
                type: "manual_booking_confirmation",
                to: player.email,
                data: {
                  playerName: player.full_name,
                  lessonTitle: slot.cyclus_name || t("bookings.lesson"),
                  lessonDate: format(new Date(slot.start_time), "EEEE, MMMM d, yyyy"),
                  lessonTime: `${format(new Date(slot.start_time), "HH:mm")} - ${format(new Date(slot.end_time), "HH:mm")}`,
                  location: null,
                  price: finalPricePerPlayer / selectedPlayers.length,
                },
              },
              headers: {
                Authorization: `Bearer ${emailSession?.access_token}`,
              },
            }).catch(err => logger.warn("Email notification failed", { error: err?.message }))
          )
        );

        toast({
          title: t("bookings.bookingCreated"),
          description: selectedPlayers.length > 1 
            ? t("bookings.multiPlayersBooked", { count: selectedPlayers.length })
            : t("bookings.bookingCreatedDescription"),
        });
      }

      if (rebalanceFailed) {
        toast({
          title: t("bookings.rebalanceFailedTitle", "Player added, pricing incomplete"),
          description: t(
            "bookings.rebalanceFailedDescription",
            "The player was booked, but existing booking amounts could not be updated. Please check amounts or contact support.",
          ),
          variant: "destructive",
        });
      }

      if (!deferDialogClose) {
        finishDialogAfterBooking();
      }
    } catch (error: any) {
      logger.error("Error creating booking", error as Error, { component: "BookForPlayerDialog" });
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
            <div className="flex items-center gap-2 text-sm">
              <Euro className="h-4 w-4 text-muted-foreground" />
              <span>
                {formatPrice(pricePerSession)} / {slotDurationMinutes} min
              </span>
            </div>
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
                    const isFirstEmptySlot = index === existingBookedCount;
                    const currentPlayerId = selectedPlayerIds[selectionIndex];

                    return (
                      <div key={index} className="flex gap-2 items-center">
                        <span className="text-sm text-muted-foreground w-20 shrink-0">
                          {t("bookings.player")} {index + 1}
                          {isFirstEmptySlot && " *"}
                        </span>
                        <GuestPlayerSlotCombobox
                          players={players}
                          value={currentPlayerId}
                          showEmail
                          placeholder={
                            isFirstEmptySlot
                              ? t("bookings.selectPlayerPlaceholder")
                              : t("bookings.optionalPlayer")
                          }
                          emptyLabel={
                            players.length === 0
                              ? t("players.noPlayers")
                              : t("calendar.selectPlayer")
                          }
                          allPlayersTakenLabel={t("bookings.allPlayersSelected")}
                          disabledPlayerIds={selectedPlayerIds.filter(
                            (id, i) => i !== selectionIndex && !!id,
                          )}
                          data-testid={`book-player-slot-${selectionIndex}`}
                          className="flex-1 h-10"
                          onValueChange={(value) =>
                            handlePlayerSelect(selectionIndex, value)
                          }
                        />
                        {currentPlayerId && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon" aria-label="Close"
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
                            aria-label={t("players.addPlayer", "Add player")}
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

            {showInvoicePayerSelector && (
              <div className="space-y-1.5">
                <Label className="text-sm">
                  {t("calendar.invoicePayerLabel", "Who should receive the invoice?")}
                </Label>
                <Select
                  value={invoicePayerGuestPlayerId ?? ""}
                  onValueChange={setInvoicePayerGuestPlayerId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("calendar.selectPlayer", "Select player")} />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedGuestIds.map((playerId) => {
                      const player = players.find((p) => p.id === playerId);
                      return (
                        <SelectItem key={playerId} value={playerId}>
                          {player?.full_name ?? playerId}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "calendar.invoicePayerHint",
                    "Because split payment is off, only this player will be invoiced for the full amount.",
                  )}
                </p>
              </div>
            )}

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

            {/* Discount Section - Collapsible */}
            {hasAtLeastOnePlayer && (
              <Collapsible open={showDiscount} onOpenChange={setShowDiscount}>
                <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full py-2">
                  <Percent className="h-4 w-4" />
                  <span>{t("bookings.addDiscount", "Add discount")}</span>
                  <ChevronDown className={cn(
                    "h-4 w-4 ml-auto transition-transform",
                    showDiscount && "rotate-180"
                  )} />
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2 space-y-3">
                  <div className="flex gap-2">
                    <Select
                      value={discountType}
                      onValueChange={(v) => setDiscountType(v as "percentage" | "fixed")}
                    >
                      <SelectTrigger className="w-20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">%</SelectItem>
                        <SelectItem value="fixed">€</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min="0"
                      step={discountType === "percentage" ? "1" : "0.01"}
                      max={discountType === "percentage" ? "100" : undefined}
                      value={discountValue || ""}
                      onChange={(e) => setDiscountValue(Number(e.target.value))}
                      placeholder={t("bookings.discountAmount", "Amount")}
                      className="flex-1"
                    />
                  </div>
                  <Textarea
                    placeholder={t("bookings.discountReason", "Reason (optional)")}
                    value={discountReason}
                    onChange={(e) => setDiscountReason(e.target.value)}
                    rows={1}
                  />
                </CollapsibleContent>
              </Collapsible>
            )}

            {/* Price Summary */}
            {hasAtLeastOnePlayer && (
              <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {selectedCount} {selectedCount === 1 ? t("bookings.player") : t("bookings.players")} × {sessionsCount} {sessionsCount === 1 ? t("calendar.session", "session") : t("calendar.sessions")} × {formatPrice(pricePerSession)}
                  </span>
                  <span>{formatPrice(subtotal)}</span>
                </div>
                {calculatedDiscount > 0 && (
                  <div className="flex justify-between text-sm text-green-600 dark:text-green-400">
                    <span>{t("bookings.discount", "Discount")}</span>
                    <span>-{formatPrice(calculatedDiscount)}</span>
                  </div>
                )}
                <div className="flex justify-between font-medium border-t pt-2">
                  <span>{t("bookings.total", "Total")}</span>
                  <span>{formatPrice(finalAmount)}</span>
                </div>
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

      {invoiceDialogSummary && (
        <UpdateAffectedInvoicesDialog
          open={invoiceDialogOpen}
          onOpenChange={handleInvoiceDialogOpenChange}
          summary={invoiceDialogSummary}
          onConfirm={handleInvoiceUpdateChoice}
          loading={invoiceConfirmLoading}
        />
      )}
    </>
  );
}