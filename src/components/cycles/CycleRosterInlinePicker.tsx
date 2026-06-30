import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GuestPlayerSlotCombobox } from "@/components/players/GuestPlayerSlotCombobox";
import { AddPlayerDialog, type GuestPlayer } from "@/components/players/AddPlayerDialog";
import { fetchBookableGuestPlayers } from "@/lib/playersOverview";
import { logger } from "@/lib/logger";

interface CycleRosterInlinePickerProps {
  academyProfileId: string | null | undefined;
  value: string;
  onValueChange: (guestPlayerId: string) => void;
  /** Guests that must not be selectable (e.g. the player being replaced). */
  excludeGuestPlayerIds?: string[];
  disabled?: boolean;
  namespace?: string;
}

/**
 * Inline guest picker for the cycle roster — search the academy's bookable
 * players or create a new one. Mirrors the slot-page InlineBookPlayer picker so
 * cycle-roster add/change feel the same as per-slot editing. Controlled: the
 * caller owns the selected value, the skip-invoices toggle, and the confirm.
 */
export function CycleRosterInlinePicker({
  academyProfileId,
  value,
  onValueChange,
  excludeGuestPlayerIds = [],
  disabled = false,
  namespace = "cycles",
}: CycleRosterInlinePickerProps) {
  const { t } = useTranslation(namespace);
  const [players, setPlayers] = useState<GuestPlayer[]>([]);
  const [fetching, setFetching] = useState(false);
  const [showAddPlayer, setShowAddPlayer] = useState(false);

  useEffect(() => {
    if (!academyProfileId) return;
    let cancelled = false;
    (async () => {
      setFetching(true);
      try {
        const data = await fetchBookableGuestPlayers({ kind: "academy", id: academyProfileId });
        if (!cancelled) setPlayers(data as GuestPlayer[]);
      } catch (error) {
        logger.error("Failed to load bookable players for cycle roster", error as Error, {
          component: "CycleRosterInlinePicker",
        });
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyProfileId]);

  const handlePlayerCreated = (player: GuestPlayer) => {
    setPlayers((prev) => [...prev, player].sort((a, b) => a.full_name.localeCompare(b.full_name)));
    onValueChange(player.id);
    setShowAddPlayer(false);
  };

  return (
    <div className="flex items-center gap-2">
      <GuestPlayerSlotCombobox
        players={players}
        value={value}
        onValueChange={onValueChange}
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
        disabled={disabled}
        aria-label={t("detail.roster.picker.addNew", "Add a new player")}
        title={t("detail.roster.picker.addNew", "Add a new player")}
      >
        <UserPlus className="h-4 w-4" />
      </Button>

      <AddPlayerDialog
        open={showAddPlayer}
        onOpenChange={setShowAddPlayer}
        academyId={academyProfileId ?? undefined}
        onPlayerCreated={handlePlayerCreated}
      />
    </div>
  );
}
