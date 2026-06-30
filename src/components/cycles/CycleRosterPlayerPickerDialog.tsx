import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, UserPlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { GuestPlayerSlotCombobox } from "@/components/players/GuestPlayerSlotCombobox";
import { AddPlayerDialog, type GuestPlayer } from "@/components/players/AddPlayerDialog";
import { SkipInvoiceUpdatesCheckbox } from "@/components/booking/SkipInvoiceUpdatesCheckbox";
import { fetchBookableGuestPlayers } from "@/lib/playersOverview";
import { logger } from "@/lib/logger";

interface CycleRosterPlayerPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Academy scope for the bookable-player list + new-player creation. */
  academyProfileId: string | null | undefined;
  title: string;
  description?: string;
  confirmLabel: string;
  loading?: boolean;
  onConfirm: (guestPlayerId: string) => void;
  /** Guests that must not be selectable (e.g. the player being replaced). */
  excludeGuestPlayerIds?: string[];
  skipInvoiceUpdates: boolean;
  onSkipInvoiceUpdatesChange: (value: boolean) => void;
  namespace?: string;
}

/**
 * Pick a guest player (search the academy's bookable players or create a new
 * one) for a cycle-roster action, with the page-level "Don't update invoices"
 * toggle surfaced so the owner sets the invoice behaviour at the moment of the
 * add/change. Presentational — the caller owns the actual cycle write.
 */
export function CycleRosterPlayerPickerDialog({
  open,
  onOpenChange,
  academyProfileId,
  title,
  description,
  confirmLabel,
  loading = false,
  onConfirm,
  excludeGuestPlayerIds = [],
  skipInvoiceUpdates,
  onSkipInvoiceUpdatesChange,
  namespace = "cycles",
}: CycleRosterPlayerPickerDialogProps) {
  const { t } = useTranslation(namespace);
  const [players, setPlayers] = useState<GuestPlayer[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [fetching, setFetching] = useState(false);
  const [showAddPlayer, setShowAddPlayer] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedId(""); // clear stale selection on every open, even before the academy resolves
    if (!academyProfileId) return;
    let cancelled = false;
    (async () => {
      setFetching(true);
      try {
        const data = await fetchBookableGuestPlayers({ kind: "academy", id: academyProfileId });
        if (!cancelled) setPlayers(data as GuestPlayer[]);
      } catch (error) {
        logger.error("Failed to load bookable players for cycle roster", error as Error, {
          component: "CycleRosterPlayerPickerDialog",
        });
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, academyProfileId]);

  const handlePlayerCreated = (player: GuestPlayer) => {
    setPlayers((prev) => [...prev, player].sort((a, b) => a.full_name.localeCompare(b.full_name)));
    setSelectedId(player.id);
    setShowAddPlayer(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !loading && onOpenChange(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <GuestPlayerSlotCombobox
                players={players}
                value={selectedId}
                onValueChange={setSelectedId}
                placeholder={
                  fetching
                    ? t("detail.roster.picker.loading", "Loading players…")
                    : t("detail.roster.picker.select", "Select a player")
                }
                emptyLabel={t("detail.roster.picker.empty", "No player found.")}
                disabledPlayerIds={excludeGuestPlayerIds}
                showEmail
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowAddPlayer(true)}
                disabled={loading}
                aria-label={t("detail.roster.picker.addNew", "Add a new player")}
                title={t("detail.roster.picker.addNew", "Add a new player")}
              >
                <UserPlus className="h-4 w-4" />
              </Button>
            </div>

            <SkipInvoiceUpdatesCheckbox
              checked={skipInvoiceUpdates}
              onCheckedChange={onSkipInvoiceUpdatesChange}
              disabled={loading}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              {t("detail.delete.cancel", "Cancel")}
            </Button>
            <Button onClick={() => selectedId && onConfirm(selectedId)} disabled={loading || !selectedId}>
              {loading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddPlayerDialog
        open={showAddPlayer}
        onOpenChange={setShowAddPlayer}
        academyId={academyProfileId ?? undefined}
        onPlayerCreated={handlePlayerCreated}
      />
    </>
  );
}
