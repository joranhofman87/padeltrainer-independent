import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { playerComboboxSearchValue } from "@/lib/playerSearch";
import type { GuestPlayer } from "./guestPlayer";

/**
 * GuestPlayer plus optional billing fields: callers that have them (e.g. rows
 * from select('*')) make the business name searchable; callers without them
 * still satisfy the prop type.
 */
export type GuestPlayerSlotComboboxPlayer = GuestPlayer & {
  billing_business_name?: string | null;
};

export type GuestPlayerSlotComboboxProps = {
  players: GuestPlayerSlotComboboxPlayer[];
  value: string;
  onValueChange: (playerId: string) => void;
  placeholder: string;
  emptyLabel?: string;
  /** Shown when every player is disabled (e.g. already picked in other slots). */
  allPlayersTakenLabel?: string;
  clearLabel?: string;
  /** Player ids that cannot be selected (e.g. already chosen in another slot). */
  disabledPlayerIds?: string[];
  showEmail?: boolean;
  className?: string;
  "data-testid"?: string;
  /**
   * Server-search mode: when provided (together with searchValue), the search
   * input becomes controlled, cmdk's client-side filtering is disabled
   * (shouldFilter=false) and `players` is expected to already be filtered for
   * the current search. Omit both for the default client-filtered behavior.
   */
  onSearchValueChange?: (search: string) => void;
  searchValue?: string;
  /** Trigger label fallback when the selected player is not in `players`
   * (server-search mode only returns the current result page). */
  selectedLabel?: string;
};

export function GuestPlayerSlotCombobox({
  players,
  value,
  onValueChange,
  placeholder,
  emptyLabel = "No player found.",
  allPlayersTakenLabel,
  clearLabel = "-",
  disabledPlayerIds = [],
  showEmail = false,
  className,
  "data-testid": testId,
  onSearchValueChange,
  searchValue,
  selectedLabel,
}: GuestPlayerSlotComboboxProps) {
  const [open, setOpen] = useState(false);
  const [searchResetKey, setSearchResetKey] = useState(0);

  const serverSearch = onSearchValueChange != null;
  const selectedPlayer = value ? players.find((p) => p.id === value) : undefined;
  const triggerLabel =
    selectedPlayer?.full_name ?? (value ? selectedLabel : undefined) ?? placeholder;
  const disabledSet = new Set(disabledPlayerIds);
  const hasSelectablePlayer = players.some(
    (p) => !disabledSet.has(p.id) || p.id === value,
  );

  const closeAndSelect = (playerId: string) => {
    onValueChange(playerId);
    setOpen(false);
    setSearchResetKey((k) => k + 1);
    onSearchValueChange?.("");
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    // Uncontrolled mode resets implicitly (the input unmounts with the
    // popover); controlled mode must reset explicitly so reopening is fresh.
    if (!nextOpen) onSearchValueChange?.("");
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={triggerLabel}
          data-testid={testId}
          className={cn(
            "h-8 min-w-0 flex-1 justify-between font-normal",
            className,
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(250px,calc(100vw-2rem))] p-0"
        align="start"
      >
        <Command key={searchResetKey} shouldFilter={!serverSearch}>
          <CommandInput
            placeholder={placeholder}
            {...(serverSearch
              ? { value: searchValue ?? "", onValueChange: onSearchValueChange }
              : {})}
          />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {!hasSelectablePlayer && allPlayersTakenLabel ? (
                <div className="p-2 text-sm text-muted-foreground text-center">
                  {allPlayersTakenLabel}
                </div>
              ) : null}
              <CommandItem value="__clear__" onSelect={() => closeAndSelect("")}>
                {clearLabel}
              </CommandItem>
              {/* With shouldFilter=false CommandEmpty never triggers (the
                  clear item always "matches"), so render it explicitly. */}
              {serverSearch && players.length === 0 ? (
                <div className="p-2 text-sm text-muted-foreground text-center">
                  {emptyLabel}
                </div>
              ) : null}
              {players.map((player) => {
                const isSelected = value === player.id;
                const isDisabled = disabledSet.has(player.id);
                return (
                  <CommandItem
                    key={player.id}
                    value={playerComboboxSearchValue(player)}
                    disabled={isDisabled}
                    onSelect={() => {
                      if (!isDisabled) closeAndSelect(player.id);
                    }}
                    className={cn(isDisabled && "opacity-50")}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-3 w-3",
                        isSelected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="flex flex-col">
                      <span>{player.full_name}</span>
                      {showEmail && player.email ? (
                        <span className="text-xs text-muted-foreground">{player.email}</span>
                      ) : null}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
