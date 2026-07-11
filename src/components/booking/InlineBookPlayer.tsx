import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { differenceInMinutes } from "date-fns";
import { Loader2, UserPlus, X, Users, Repeat } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { insertBookings } from "@/lib/bookings";
import { SkipInvoiceUpdatesCheckbox } from "@/components/booking/SkipInvoiceUpdatesCheckbox";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import {
  syncInvoicesAfterAddPlayer,
  applyAddPlayerInvoiceChoice,
  getInvoiceFollowUpMessages,
} from "@/lib/invoiceAfterAddPlayer";
import { buildAffectedInvoicesSummary, type AffectedInvoicesSummary } from "@/lib/affectedInvoices";
import type { InvoiceUpdateChoice } from "@/lib/invoiceUpdateChoice";
import { UpdateAffectedInvoicesDialog } from "@/components/invoices/UpdateAffectedInvoicesDialog";
import {
  shouldDeferAddPlayerClose,
  shouldWarnInvoiceCreateFailure,
} from "@/lib/addPlayerInvoiceFlow";
import type { InvoiceAfterAddPlayerResult } from "@/lib/invoiceAfterAddPlayer";
import { formatPrice } from "@/lib/pricing";
import {
  buildGuestBookingInsertRow,
  calculateSlotBookingPricing,
  countActiveBookings,
  getRebalanceBookingIds,
  resolveSlotSessionPrice,
} from "@/lib/bookingPricing";
import {
  insertGuestsIntoSlots,
  rebalanceExistingOnSlot,
  INSERTED_BOOKING_SELECT,
} from "@/lib/slotBookingWrite";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { AddPlayerDialog, GuestPlayer } from "@/components/players/AddPlayerDialog";
import { invalidateAllPlayerData } from "@/lib/playerQueryKeys";
import { GuestPlayerSlotCombobox } from "@/components/players/GuestPlayerSlotCombobox";
import { BookedPlayer } from "@/lib/slotTypes";
import { Check, Clock } from "lucide-react";
import { fetchBookableGuestPlayers } from '@/lib/playersOverview';

interface Slot {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id?: string | null;
  cyclus_name?: string | null;
  price_per_session?: number | null;
  split_payment?: boolean;
  /** G5 frozen split divisor (court capacity). Omitted → legacy live-count split. */
  max_participants?: number | null;
  booked_players?: BookedPlayer[];
}

interface InlineBookPlayerProps {
  trainerId: string;
  academyProfileId?: string | null;
  slot: Slot;
  onBookingCreated: () => void;
  onClose: () => void;
  /**
   * When `onSkipInvoiceUpdatesChange` is provided, a "Don't update invoices"
   * checkbox is shown (controlled by `skipInvoiceUpdates`). While checked, adding
   * the player(s) skips ALL invoice work (no new draft, no recalc) AND the
   * co-occupant split rebalance. Omit both to keep the current behaviour.
   */
  skipInvoiceUpdates?: boolean;
  onSkipInvoiceUpdatesChange?: (value: boolean) => void;
}

const EMPTY_PLAYER_SLOTS = ["", "", "", ""];

export function InlineBookPlayer({
  trainerId,
  academyProfileId,
  slot,
  onBookingCreated,
  onClose,
  skipInvoiceUpdates = false,
  onSkipInvoiceUpdatesChange,
}: InlineBookPlayerProps) {
  const { t } = useTranslation("trainer");
  const { t: tCommon } = useTranslation("common");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [players, setPlayers] = useState<GuestPlayer[]>([]);
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<string[]>(EMPTY_PLAYER_SLOTS);
  const [notes, setNotes] = useState("");
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [bookingScope, setBookingScope] = useState<"single" | "cyclus">("single");
  const [cyclusSlotsCount, setCyclusSlotsCount] = useState(0);
  const [cyclusSlots, setCyclusSlots] = useState<
    { id: string; start_time: string; end_time: string; price_per_session?: number | null }[]
  >([]);
  const [hourlyRate, setHourlyRate] = useState<number>(50);
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [invoiceDialogSummary, setInvoiceDialogSummary] = useState<AffectedInvoicesSummary | null>(null);
  const [pendingInvoiceSlotIds, setPendingInvoiceSlotIds] = useState<string[]>([]);
  const [pendingInvoiceResult, setPendingInvoiceResult] = useState<
    Awaited<ReturnType<typeof syncInvoicesAfterAddPlayer>> | null
  >(null);
  const [invoiceConfirmLoading, setInvoiceConfirmLoading] = useState(false);
  const closingInvoiceDialogFromChoiceRef = useRef(false);

  // Same fallback chain as BookForPlayerDialog: configured slot price, else
  // hourly rate × duration — never €0 just because price_per_session is unset.
  const slotDurationMinutes = differenceInMinutes(
    new Date(slot.end_time),
    new Date(slot.start_time),
  );
  const sessionPrice = resolveSlotSessionPrice(
    slot.price_per_session,
    hourlyRate,
    slotDurationMinutes,
  );
  const splitPayment = Boolean(slot.split_payment);

  const resolveCyclusSlotPrice = (cyclusSlot: {
    start_time: string;
    end_time: string;
    price_per_session?: number | null;
  }) =>
    resolveSlotSessionPrice(
      cyclusSlot.price_per_session ?? slot.price_per_session,
      hourlyRate,
      differenceInMinutes(new Date(cyclusSlot.end_time), new Date(cyclusSlot.start_time)),
    );

  useEffect(() => {
    fetchPlayers();
    fetchHourlyRate();
    if (slot.cyclus_id) fetchCyclusSlots(slot.cyclus_id);
  }, [trainerId, academyProfileId, slot.cyclus_id]);

  const fetchHourlyRate = async () => {
    try {
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("hourly_rate")
        .eq("id", trainerId)
        .single();
      if (error) throw error;
      if (data?.hourly_rate) setHourlyRate(data.hourly_rate);
    } catch (error) {
      logger.error("Error fetching hourly rate", error as Error, { component: "InlineBookPlayer" });
    }
  };

  const fetchPlayers = async () => {
    setIsFetching(true);
    try {
      const data = await fetchBookableGuestPlayers(
        academyProfileId
          ? { kind: 'academy', id: academyProfileId }
          : { kind: 'trainer', id: trainerId },
      );
      setPlayers(data as GuestPlayer[]);
    } catch (error) {
      logger.error("Error fetching players", error as Error, { component: "InlineBookPlayer" });
    } finally {
      setIsFetching(false);
    }
  };

  const fetchCyclusSlots = async (cyclusId: string) => {
    try {
      const { data, error } = await supabase.from("availability_slots").select("id, start_time, end_time, price_per_session, max_participants")
        .eq("cyclus_id", cyclusId).gte("start_time", new Date().toISOString()).order("start_time");
      if (error) throw error;
      setCyclusSlots(data || []);
      setCyclusSlotsCount(data?.length || 0);
    } catch (error) {
      logger.error("Error fetching cyclus slots", error as Error, { component: "InlineBookPlayer" });
    }
  };

  const handlePlayerCreated = (player: GuestPlayer) => {
    setPlayers(prev => [...prev, player].sort((a, b) => a.full_name.localeCompare(b.full_name)));
    const firstEmptyIndex = selectedPlayerIds.findIndex(id => !id);
    if (firstEmptyIndex !== -1) {
      const newIds = [...selectedPlayerIds];
      newIds[firstEmptyIndex] = player.id;
      setSelectedPlayerIds(newIds);
    }
    setShowAddPlayer(false);
  };

  const handlePlayerSelect = (index: number, playerId: string) => {
    const newIds = [...selectedPlayerIds];
    newIds[index] = playerId;
    setSelectedPlayerIds(newIds);
  };

  const clearPlayerSlot = (index: number) => {
    const newIds = [...selectedPlayerIds];
    newIds[index] = "";
    setSelectedPlayerIds(newIds);
  };

  const selectedCount = selectedPlayerIds.filter(id => id).length;
  const hasAtLeastOnePlayer = selectedCount > 0;
  const hasCyclus = !!slot.cyclus_id && cyclusSlotsCount > 1;
  const existingActiveCount = countActiveBookings(slot.booked_players);
  const totalParticipantsAfter = existingActiveCount + selectedCount;

  const previewPricing = calculateSlotBookingPricing({
    sessionPrice,
    splitPayment,
    existingActiveBookingCount: existingActiveCount,
    newPlayerCount: selectedCount,
    slotCapacity: slot.max_participants,
  });

  const showInvoiceFollowUpToasts = (
    invoiceResult: Awaited<ReturnType<typeof syncInvoicesAfterAddPlayer>>,
    sentWasUpdated: boolean,
  ) => {
    const followUp = getInvoiceFollowUpMessages(invoiceResult, { sentWasUpdated });
    if (followUp.paidUnchanged) {
      toast({
        title: t("invoices.paidUnchanged", followUp.paidUnchanged),
      });
    }
    if (followUp.sentUpdated) {
      toast({ title: t("invoices.sentUpdated", followUp.sentUpdated) });
    }
    if (followUp.sentNotUpdated) {
      toast({
        title: t("invoices.sentUnchanged", followUp.sentNotUpdated),
      });
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
  ): Promise<InvoiceAfterAddPlayerResult> => {
    const invoiceResult = await syncInvoicesAfterAddPlayer({
      newBookings: insertedBookings,
      splitPayment,
      slotIds: affectedSlotIds,
      cyclusId: slot.cyclus_id,
      skipInvoices: skipInvoiceUpdates,
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

  const completeAddPlayerSuccess = () => {
    onBookingCreated();
    onClose();
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
        component: "InlineBookPlayer",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setInvoiceConfirmLoading(false);
      setInvoiceDialogOpen(false);
      setPendingInvoiceSlotIds([]);
      setPendingInvoiceResult(null);
      setInvoiceDialogSummary(null);
      completeAddPlayerSuccess();
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
    if (!hasAtLeastOnePlayer) return;
    setIsLoading(true);

    const notesValue = notes.trim() || null;
    let insertSucceeded = false;
    let rebalanceFailed = false;

    try {
      const selectedPlayers = selectedPlayerIds
        .filter(id => id)
        .map(id => players.find(p => p.id === id)!)
        .filter(Boolean);

      if (bookingScope === "cyclus" && slot.cyclus_id && cyclusSlots.length > 0) {
        // Book every future cyclus session via the shared primitive (same money
        // math the cycle-roster add uses). Each session prices on its own price.
        const { insertedRows, rebalanceFailed: cyclusRebalanceFailed } =
          await insertGuestsIntoSlots({
            slots: cyclusSlots,
            guestPlayerIds: selectedPlayers.map((p) => p.id),
            splitPayment,
            skipRebalance: skipInvoiceUpdates,
            notes: notesValue,
            resolveSessionPrice: resolveCyclusSlotPrice,
            client: supabase,
          });
        insertSucceeded = true;
        if (cyclusRebalanceFailed) rebalanceFailed = true;

        const guestIds = selectedPlayers.map(p => p.id);
        if (guestIds.length > 0) {
          await supabase.from("guest_players").update({ has_trained: true }).in("id", guestIds);
          invalidateAllPlayerData(queryClient, { kind: "trainer", id: trainerId });
          if (academyProfileId) invalidateAllPlayerData(queryClient, { kind: "academy", id: academyProfileId });
        }

        if (!rebalanceFailed) {
          toast({
            title: t("bookings.bookingCreated"),
            description: t("bookings.multiBookingCreated", {
              players: selectedPlayers.length,
              sessions: cyclusSlots.length,
              total: selectedPlayers.length * cyclusSlots.length,
            }),
          });
        }

        let invoiceResult: InvoiceAfterAddPlayerResult | null = null;
        if (insertedRows?.length) {
          invoiceResult = await runInvoicesAfterAddPlayer(
            insertedRows,
            cyclusSlots.map((s) => s.id),
          );
        }

        if (insertSucceeded && (!invoiceResult || !shouldDeferAddPlayerClose(invoiceResult))) {
          completeAddPlayerSuccess();
        }
      } else {
        const pricing = calculateSlotBookingPricing({
          sessionPrice,
          splitPayment,
          existingActiveBookingCount: existingActiveCount,
          newPlayerCount: selectedPlayers.length,
          slotCapacity: slot.max_participants,
        });

        const bookingsToInsert = selectedPlayers.map((player, index) =>
          buildGuestBookingInsertRow({
            slotId: slot.id,
            guestPlayerId: player.id,
            paymentAmount: pricing.newPlayerAmounts[index] ?? 0,
            sessionPrice: pricing.sessionPrice,
            notes: notesValue,
          }),
        );

        const { data: insertedRows, error } = await insertBookings(
          bookingsToInsert,
          supabase,
          INSERTED_BOOKING_SELECT,
        );
        if (error) throw error;
        insertSucceeded = true;

        if (!skipInvoiceUpdates && pricing.shouldRebalanceExisting && pricing.existingBookingsNewAmount != null) {
          const rebalanceIds = getRebalanceBookingIds(
            (slot.booked_players || []).map((p) => ({
              bookingId: p.bookingId,
              paymentStatus: p.paymentStatus,
              paidExternally: p.paidExternally,
            })),
          );

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
              { component: "InlineBookPlayer", slotId: slot.id, rebalanceIds },
            );
          }
        }

        const guestIds = selectedPlayers.map(p => p.id);
        if (guestIds.length > 0) {
          await supabase.from("guest_players").update({ has_trained: true }).in("id", guestIds);
          invalidateAllPlayerData(queryClient, { kind: "trainer", id: trainerId });
          if (academyProfileId) invalidateAllPlayerData(queryClient, { kind: "academy", id: academyProfileId });
        }

        if (!rebalanceFailed) {
          toast({
            title: t("bookings.bookingCreated"),
            description:
              selectedPlayers.length > 1
                ? t("bookings.multiPlayersBooked", { count: selectedPlayers.length })
                : t("bookings.bookingCreatedDescription"),
          });
        }

        let invoiceResult: InvoiceAfterAddPlayerResult | null = null;
        if (insertedRows?.length) {
          invoiceResult = await runInvoicesAfterAddPlayer(insertedRows, [slot.id]);
        }

        if (insertSucceeded && (!invoiceResult || !shouldDeferAddPlayerClose(invoiceResult))) {
          completeAddPlayerSuccess();
        }
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

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Error creating booking", error instanceof Error ? error : new Error(message), {
        component: "InlineBookPlayer",
        slotId: slot.id,
      });
      toast({ title: tCommon("error"), description: message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="border rounded-lg p-4 space-y-4 bg-muted/30 mt-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium flex items-center gap-1.5">
            <UserPlus className="h-4 w-4" />
            {t("bookings.bookForPlayer")}
          </h4>
          <Button variant="ghost" size="icon" aria-label="Close" className="h-7 w-7" type="button" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs flex items-center gap-1.5"><Users className="h-3.5 w-3.5" />{t("bookings.players")}</Label>
            <span className="text-xs text-muted-foreground">{existingActiveCount + selectedCount}/4 {t("bookings.booked")}</span>
          </div>

          {isFetching ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />{tCommon("loading")}</div>
          ) : (
            <div className="space-y-2">
              {[0, 1, 2, 3].map(index => {
                const existingPlayer = slot.booked_players?.[index];
                if (existingPlayer) {
                  return (
                    <div key={index} className={cn("flex items-center gap-2 text-sm px-3 py-2 rounded-md",
                      existingPlayer.status === "confirmed" ? "bg-emerald-100 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800" : "bg-amber-100 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800"
                    )}>
                      <span className="text-muted-foreground w-16 shrink-0 text-xs">{t("bookings.player")} {index + 1}</span>
                      <div className="flex items-center gap-1.5 flex-1">
                        {existingPlayer.status === "confirmed" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Clock className="h-3.5 w-3.5 text-amber-600" />}
                        <span className="font-medium text-xs">{existingPlayer.name}</span>
                      </div>
                    </div>
                  );
                }
                const selectionIndex = index - existingActiveCount;
                if (selectionIndex < 0) return null;
                const isFirst = index === existingActiveCount;
                const currentPlayerId = selectedPlayerIds[selectionIndex];

                return (
                  <div key={index} className="flex gap-2 items-center">
                    <span className="text-xs text-muted-foreground w-16 shrink-0">{t("bookings.player")} {index + 1}{isFirst && " *"}</span>
                    <GuestPlayerSlotCombobox
                      players={players}
                      value={currentPlayerId}
                      showEmail
                      placeholder={
                        isFirst
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
                      data-testid={`inline-book-player-slot-${selectionIndex}`}
                      className="flex-1 h-9"
                      onValueChange={(v) => handlePlayerSelect(selectionIndex, v)}
                    />
                    {currentPlayerId && <Button type="button" variant="ghost" size="icon" aria-label="Close" className="h-8 w-8 shrink-0" onClick={() => clearPlayerSlot(selectionIndex)}><X className="h-4 w-4" /></Button>}
                    {!currentPlayerId && isFirst && <Button type="button" variant="outline" size="icon" aria-label={t("players.addPlayer", "Add Player")} className="h-8 w-8 shrink-0" onClick={() => setShowAddPlayer(true)}><UserPlus className="h-4 w-4" /></Button>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {hasCyclus && (
          <div className="space-y-2">
            <Label className="text-xs">{t("calendar.bookingScope")}</Label>
            <RadioGroup value={bookingScope} onValueChange={v => setBookingScope(v as "single" | "cyclus")} className="space-y-1.5">
              <div className="flex items-center space-x-3 rounded-md border p-2.5">
                <RadioGroupItem value="single" id="inline-single" />
                <Label htmlFor="inline-single" className="text-xs cursor-pointer">{t("calendar.singleSlot")}</Label>
              </div>
              <div className="flex items-center space-x-3 rounded-md border p-2.5 bg-primary/5 border-primary/30">
                <RadioGroupItem value="cyclus" id="inline-cyclus" />
                <Label htmlFor="inline-cyclus" className="text-xs cursor-pointer flex items-center gap-1.5">
                  <Repeat className="h-3.5 w-3.5" />
                  {t("calendar.entireCyclus")} ({cyclusSlotsCount} {t("calendar.sessions")})
                </Label>
              </div>
            </RadioGroup>
          </div>
        )}

        {hasAtLeastOnePlayer && sessionPrice > 0 && (
          <div className="rounded-md border bg-background p-3 space-y-1 text-xs">
            {splitPayment ? (
              <>
                <p className="font-medium">
                  {formatPrice(previewPricing.perPlayerAmount)}{" "}
                  {t("bookings.perPlayer", "per player")}
                </p>
                <p className="text-muted-foreground">
                  {t("bookings.sessionSplitSummary", "Session total: {{total}} split between {{count}} players", {
                    total: formatPrice(sessionPrice),
                    count: totalParticipantsAfter,
                  })}
                </p>
              </>
            ) : existingActiveCount > 0 ? (
              <p className="text-muted-foreground">
                {t(
                  "bookings.companionNotCharged",
                  "Added players are not charged when a payer is already on this slot.",
                )}
              </p>
            ) : (
              <p className="font-medium">
                {t("bookings.singlePayerAmount", "Payer amount: {{amount}}", {
                  amount: formatPrice(previewPricing.newPlayerAmounts[0] ?? 0),
                })}
              </p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <Label className="text-xs">{t("bookings.notes")}</Label>
          <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder={t("bookings.notesPlaceholder")} rows={2} />
        </div>

        {onSkipInvoiceUpdatesChange && (
          <SkipInvoiceUpdatesCheckbox
            checked={skipInvoiceUpdates}
            onCheckedChange={onSkipInvoiceUpdatesChange}
            disabled={isLoading}
            id="inline-book-skip-invoice"
          />
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isLoading}>{tCommon("cancel")}</Button>
          <Button type="submit" size="sm" disabled={isLoading || !hasAtLeastOnePlayer}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("bookings.confirmBooking")}
          </Button>
        </div>
      </form>

      <AddPlayerDialog open={showAddPlayer} onOpenChange={setShowAddPlayer} trainerId={trainerId} onPlayerCreated={handlePlayerCreated} />

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
