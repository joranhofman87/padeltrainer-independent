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
import type { GuestPlayer } from "./AddPlayerDialog";

export type GuestPlayerSlotComboboxProps = {
  players: GuestPlayer[];
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
}: GuestPlayerSlotComboboxProps) {
  const [open, setOpen] = useState(false);
  const [searchResetKey, setSearchResetKey] = useState(0);

  const selectedPlayer = value ? players.find((p) => p.id === value) : undefined;
  const disabledSet = new Set(disabledPlayerIds);
  const hasSelectablePlayer = players.some(
    (p) => !disabledSet.has(p.id) || p.id === value,
  );

  const closeAndSelect = (playerId: string) => {
    onValueChange(playerId);
    setOpen(false);
    setSearchResetKey((k) => k + 1);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          data-testid={testId}
          className={cn(
            "h-8 min-w-0 flex-1 justify-between font-normal",
            className,
          )}
        >
          <span className="truncate">
            {selectedPlayer?.full_name ?? placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(250px,calc(100vw-2rem))] p-0"
        align="start"
      >
        <Command key={searchResetKey}>
          <CommandInput placeholder={placeholder} />
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
              {players.map((player) => {
                const isSelected = value === player.id;
                const isDisabled = disabledSet.has(player.id);
                return (
                  <CommandItem
                    key={player.id}
                    value={`${player.full_name} ${player.email ?? ""}`.trim()}
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
