import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  GuestPlayerSlotCombobox,
  type GuestPlayerSlotComboboxPlayer,
} from "@/components/players/GuestPlayerSlotCombobox";
import { AddPlayerDialog, type CreatedPlayer } from "@/components/players/AddPlayerDialog";
import { fetchBookablePersons, type BookablePerson } from "@/lib/playersOverview";
import { logger } from "@/lib/logger";

interface CycleRosterInlinePickerProps {
  academyProfileId: string | null | undefined;
  /** The selected person's `comboboxId` (`g_…`|`p_…`), or '' when nothing is picked. */
  value: string;
  /** Emits the selected person (or null on clear). The caller resolves a `p_` (registered) pick to
   *  its guest twin at add/swap time — person-unification Phase 0. */
  onSelect: (person: BookablePerson | null) => void;
  /** People that must not be selectable (e.g. the row being replaced), by `comboboxId`. */
  excludePersonKeys?: string[];
  /** Same, by person id — closes the gap where a roster entry's refs are profile-only while the
   * (merged) person's picker row is keyed by their guest side. */
  excludePersonIds?: string[];
  disabled?: boolean;
  namespace?: string;
}

/**
 * Inline person picker for the cycle roster — search the academy's bookable people (guests AND
 * registered players) or create a new guest. A registered pick surfaces here so an existing
 * app-account holder can be added as a participant; the caller mints/reuses their guest twin.
 * Controlled: the caller owns the selected value, the skip-invoices toggle, and the confirm.
 */
export function CycleRosterInlinePicker({
  academyProfileId,
  value,
  onSelect,
  excludePersonKeys = [],
  excludePersonIds = [],
  disabled = false,
  namespace = "cycles",
}: CycleRosterInlinePickerProps) {
  const { t } = useTranslation(namespace);
  const [persons, setPersons] = useState<BookablePerson[]>([]);
  const [fetching, setFetching] = useState(false);
  const [showAddPlayer, setShowAddPlayer] = useState(false);

  useEffect(() => {
    if (!academyProfileId) return;
    let cancelled = false;
    (async () => {
      setFetching(true);
      try {
        const data = await fetchBookablePersons({ kind: "academy", id: academyProfileId });
        if (!cancelled) setPersons(data);
      } catch (error) {
        logger.error("Failed to load bookable people for cycle roster", error as Error, {
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

  // The combobox is id-agnostic (keys on player.id) — feed it person-keyed rows so guests and
  // registered players are both selectable, and map the chosen key back to its BookablePerson.
  const byKey = useMemo(() => new Map(persons.map((p) => [p.comboboxId, p])), [persons]);
  const disabledKeys = useMemo(() => {
    const keys = new Set(excludePersonKeys);
    if (excludePersonIds.length > 0) {
      const ids = new Set(excludePersonIds);
      for (const p of persons) {
        if (p.personId && ids.has(p.personId)) keys.add(p.comboboxId);
      }
    }
    return Array.from(keys);
  }, [persons, excludePersonKeys, excludePersonIds]);
  const comboboxPlayers = useMemo<GuestPlayerSlotComboboxPlayer[]>(
    () =>
      persons.map((p) => ({
        id: p.comboboxId,
        trainer_id: null,
        academy_profile_id: academyProfileId ?? null,
        first_name: null,
        last_name: null,
        full_name: p.full_name,
        email: p.email,
        phone: p.phone,
        skill_rating: p.skill_rating,
        rating_system: p.rating_system,
        notes: null,
        created_at: "",
        updated_at: "",
        linked_profile_id: null,
      })),
    [persons, academyProfileId],
  );

  const handlePlayerCreated = async (player: CreatedPlayer) => {
    // The create flow answers with the canonical person and nothing else (U2, owner correction
    // 2026-08-09). The picker re-reads its own list — the same overview surface every other row
    // came from — and selects the row whose person_id matches. No legacy id passes through here:
    // the row's guest key belongs to the list, not to the create contract.
    setShowAddPlayer(false);
    if (!academyProfileId) return;
    try {
      const data = await fetchBookablePersons({ kind: "academy", id: academyProfileId });
      setPersons(data);
      const created = data.find((p) => p.personId === player.personId) ?? null;
      if (created) {
        onSelect(created);
      } else {
        logger.error("Created player not found in the refreshed roster picker", undefined, {
          component: "CycleRosterInlinePicker",
        });
      }
    } catch (error) {
      logger.error("Failed to refresh the roster picker after a create", error as Error, {
        component: "CycleRosterInlinePicker",
      });
    }
  };

  return (
    <div className="flex items-center gap-2">
      <GuestPlayerSlotCombobox
        players={comboboxPlayers}
        value={value}
        onValueChange={(key) => onSelect(byKey.get(key) ?? null)}
        placeholder={
          fetching
            ? t("detail.roster.picker.loading", "Loading players…")
            : t("detail.roster.picker.select", "Select a player")
        }
        emptyLabel={t("detail.roster.picker.empty", "No player found.")}
        disabledPlayerIds={disabledKeys}
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
