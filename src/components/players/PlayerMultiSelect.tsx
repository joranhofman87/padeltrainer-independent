import { useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface PlayerMultiSelectOption {
  id: string;
  full_name: string;
  email?: string | null;
}

export interface PlayerMultiSelectProps {
  options: PlayerMultiSelectOption[];
  /** ids of the currently-selected players. */
  selectedIds: string[];
  /** Toggle a single player in/out of the selection. */
  onToggle: (id: string) => void;
  triggerLabel: string;
  searchPlaceholder: string;
  emptyLabel: string;
  showEmail?: boolean;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

/**
 * A search + multi-select player picker: unlike GuestPlayerSlotCombobox (single
 * pick, closes on select), the popover STAYS OPEN so you can tick several players
 * in one pass. Each row toggles; a check marks the selected ones. Selection state
 * is owned by the parent (which typically also renders removable chips below).
 */
export function PlayerMultiSelect({
  options,
  selectedIds,
  onToggle,
  triggerLabel,
  searchPlaceholder,
  emptyLabel,
  showEmail = false,
  disabled = false,
  className,
  'data-testid': testId,
}: PlayerMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const selected = new Set(selectedIds);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          disabled={disabled}
          aria-expanded={open}
          aria-label={triggerLabel}
          data-testid={testId}
          className={cn('h-9 w-full justify-between font-normal', className)}
        >
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <Search className="h-4 w-4 shrink-0" />
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(360px,calc(100vw-2rem))] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {options.map((player) => {
                const isSelected = selected.has(player.id);
                return (
                  <CommandItem
                    key={player.id}
                    // Include name + email so cmdk's search matches either.
                    value={`${player.full_name} ${player.email ?? ''} ${player.id}`}
                    // Keep the popover OPEN on select so multiple players can be
                    // ticked in one pass.
                    onSelect={() => onToggle(player.id)}
                    data-testid="player-multiselect-option"
                    data-picked={isSelected ? 'true' : 'false'}
                  >
                    <Check className={cn('mr-2 h-4 w-4', isSelected ? 'opacity-100' : 'opacity-0')} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{player.full_name}</span>
                      {showEmail && player.email ? (
                        <span className="truncate text-xs text-muted-foreground">{player.email}</span>
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
