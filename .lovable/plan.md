

# Add Search to Player Dropdown in Cycle Creation

## Problem
When creating a cyclus in `AddSlotDialog.tsx`, the player selection uses a plain `<Select>` dropdown with no search/filter capability. With many players, finding the right one is slow.

## Solution
Replace the `<Select>` component with a searchable `Popover` + `Command` (combobox pattern) for each of the 4 player slots. This is the same pattern used across shadcn/ui projects for searchable selects.

## Changes

### File: `src/components/trainer/AddSlotDialog.tsx`

**Lines ~1290-1322** — Replace the `<Select>` per player slot with a `Popover` + `Command` combobox:

- Import `Popover`, `PopoverTrigger`, `PopoverContent` from `@/components/ui/popover`
- Import `Command`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem` from `@/components/ui/command`
- Import `Check`, `ChevronsUpDown` from `lucide-react`

Each player slot becomes:
```
Popover > PopoverTrigger (styled like SelectTrigger)
        > PopoverContent > Command > CommandInput (search box)
                                   > CommandList > CommandEmpty ("No player found")
                                                 > CommandGroup > CommandItem per player
```

- The "none" option (clear) is kept as the first `CommandItem`
- Already-selected players in other slots are visually dimmed (same `disabled` logic)
- Selecting a player closes the popover and updates `selectedPlayers` array
- Display shows `player.full_name` or placeholder text

### Files
- `src/components/trainer/AddSlotDialog.tsx` — Replace Select with searchable combobox (~30 line change in one location)

