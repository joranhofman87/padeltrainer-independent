import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, UserPlus, X, Users, Repeat } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import { syncSplitCountForCycle } from "@/lib/invoiceSync";
import { formatPrice } from "@/lib/pricing";
import {
  buildGuestBookingInsertRow,
  calculateSlotBookingPricing,
  countActiveBookings,
  getRebalanceBookingIds,
  normalizeSessionPrice,
} from "@/lib/bookingPricing";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { AddPlayerDialog, GuestPlayer } from "./AddPlayerDialog";
import { BookedPlayer } from "./CalendarSlotCard";
import { Check, Clock } from "lucide-react";

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

interface InlineBookPlayerProps {
  trainerId: string;
  slot: Slot;
  onBookingCreated: () => void;
  onClose: () => void;
}

const EMPTY_PLAYER_SLOTS = ["", "", "", ""];

type ExistingBookingRow = {
  id: string;
  slot_id: string;
  payment_status: string | null;
  paid_externally: boolean | null;
};

export function InlineBookPlayer({ trainerId, slot, onBookingCreated, onClose }: InlineBookPlayerProps) {
  const { t } = useTranslation("trainer");
  const { t: tCommon } = useTranslation("common");
  const { toast } = useToast();

  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [players, setPlayers] = useState<GuestPlayer[]>([]);
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<string[]>(EMPTY_PLAYER_SLOTS);
  const [notes, setNotes] = useState("");
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [bookingScope, setBookingScope] = useState<"single" | "cyclus">("single");
  const [cyclusSlotsCount, setCyclusSlotsCount] = useState(0);
  const [cyclusSlots, setCyclusSlots] = useState<{ id: string; start_time: string; end_time: string }[]>([]);

  const sessionPrice = normalizeSessionPrice(slot.price_per_session);
  const splitPayment = Boolean(slot.split_payment);

  useEffect(() => {
    fetchPlayers();
    if (slot.cyclus_id) fetchCyclusSlots(slot.cyclus_id);
  }, [trainerId, slot.cyclus_id]);

  const fetchPlayers = async () => {
    setIsFetching(true);
    try {
      const { data, error } = await supabase.from("guest_players").select("*").eq("trainer_id", trainerId).order("full_name");
      if (error) throw error;
      setPlayers(data as GuestPlayer[]);
    } catch (error) {
      logger.error("Error fetching players", error as Error, { component: "InlineBookPlayer" });
    } finally {
      setIsFetching(false);
    }
  };

  const fetchCyclusSlots = async (cyclusId: string) => {
    try {
      const { data, error } = await supabase.from("availability_slots").select("id, start_time, end_time")
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

  const getAvailablePlayersForSlot = (slotIndex: number) => {
    const selectedInOtherSlots = selectedPlayerIds.filter((id, idx) => id && idx !== slotIndex);
    return players.filter(player => !selectedInOtherSlots.includes(player.id));
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
  });

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
        component: "InlineBookPlayer",
        slotId,
        rebalanceIds,
        amount,
      });
      throw error;
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
        const bySlot = await fetchExistingBookingsBySlot(cyclusSlots.map(s => s.id));
        const bookingsToInsert = cyclusSlots.flatMap((cyclusSlot) => {
          const existingOnSlot = (bySlot.get(cyclusSlot.id) || []).length;
          const pricing = calculateSlotBookingPricing({
            sessionPrice,
            splitPayment,
            existingActiveBookingCount: existingOnSlot,
            newPlayerCount: selectedPlayers.length,
          });

          return selectedPlayers.map((player, playerIndex) =>
            buildGuestBookingInsertRow({
              slotId: cyclusSlot.id,
              guestPlayerId: player.id,
              paymentAmount: pricing.newPlayerAmounts[playerIndex] ?? 0,
              sessionPrice: pricing.sessionPrice,
              notes: notesValue,
            }),
          );
        });

        const { error } = await supabase.from("bookings").insert(bookingsToInsert);
        if (error) throw error;
        insertSucceeded = true;

        for (const cyclusSlot of cyclusSlots) {
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
              { component: "InlineBookPlayer", slotId: cyclusSlot.id },
            );
          }
        }

        const guestIds = selectedPlayers.map(p => p.id);
        if (guestIds.length > 0) {
          await supabase.from("guest_players").update({ has_trained: true }).in("id", guestIds);
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
      } else {
        const pricing = calculateSlotBookingPricing({
          sessionPrice,
          splitPayment,
          existingActiveBookingCount: existingActiveCount,
          newPlayerCount: selectedPlayers.length,
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

        const { error } = await supabase.from("bookings").insert(bookingsToInsert);
        if (error) throw error;
        insertSucceeded = true;

        if (pricing.shouldRebalanceExisting && pricing.existingBookingsNewAmount != null) {
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

      if (slot.cyclus_id) {
        try {
          await syncSplitCountForCycle(slot.cyclus_id);
        } catch (err) {
          logger.warn("Split count sync failed", { error: (err as Error)?.message, component: "InlineBookPlayer" });
        }
      }

      if (insertSucceeded) {
        onBookingCreated();
        onClose();
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
                const availablePlayers = getAvailablePlayersForSlot(selectionIndex);
                const isFirst = index === existingActiveCount;
                const currentPlayerId = selectedPlayerIds[selectionIndex];

                return (
                  <div key={index} className="flex gap-2 items-center">
                    <span className="text-xs text-muted-foreground w-16 shrink-0">{t("bookings.player")} {index + 1}{isFirst && " *"}</span>
                    <Select value={currentPlayerId} onValueChange={v => handlePlayerSelect(selectionIndex, v)}>
                      <SelectTrigger className="flex-1 h-9"><SelectValue placeholder={isFirst ? t("bookings.selectPlayerPlaceholder") : t("bookings.optionalPlayer")} /></SelectTrigger>
                      <SelectContent>
                        {availablePlayers.length === 0 ? (
                          <div className="p-2 text-sm text-muted-foreground text-center">{players.length === 0 ? t("players.noPlayers") : t("bookings.allPlayersSelected")}</div>
                        ) : availablePlayers.map(p => (
                          <SelectItem key={p.id} value={p.id}><span>{p.full_name}</span> <span className="text-xs text-muted-foreground ml-1">{p.email}</span></SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {currentPlayerId && <Button type="button" variant="ghost" size="icon" aria-label="Close" className="h-8 w-8 shrink-0" onClick={() => clearPlayerSlot(selectionIndex)}><X className="h-4 w-4" /></Button>}
                    {!currentPlayerId && isFirst && <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => setShowAddPlayer(true)}><UserPlus className="h-4 w-4" /></Button>}
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

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isLoading}>{tCommon("cancel")}</Button>
          <Button type="submit" size="sm" disabled={isLoading || !hasAtLeastOnePlayer}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("bookings.confirmBooking")}
          </Button>
        </div>
      </form>

      <AddPlayerDialog open={showAddPlayer} onOpenChange={setShowAddPlayer} trainerId={trainerId} onPlayerCreated={handlePlayerCreated} />
    </>
  );
}
