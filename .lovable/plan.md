

# Default "Add Players" to Open/Selected

## Problem
When creating a new slot, the "Add players to this cycle" checkbox defaults to unchecked (`addPlayers: false`), making it hidden. The user wants it defaulted to **checked** so the player selection is always visible, and users can turn it off if they don't need it.

## Change

### `src/components/trainer/AddSlotDialog.tsx`

1. **Line ~539** — Change the default value when creating a new bulk slot config:
   ```
   addPlayers: false  →  addPlayers: true
   ```

2. **Line ~691** — Change the default when adding another config row ("Add another"):
   ```
   addPlayers: false  →  addPlayers: true
   ```

That's it — two `false` → `true` changes. The duplicate-from-existing path (line ~631) already correctly sets `addPlayers` based on whether players exist, so no change needed there.

## File summary

| File | Change |
|------|--------|
| `src/components/trainer/AddSlotDialog.tsx` | Default `addPlayers` to `true` in two places |

