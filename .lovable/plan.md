
# Fix Delete Account Button Width

## Problem
The "Account verwijderen" (Delete Account) button is rendered full-width (`w-full`) across all settings pages (Trainer, Player, Club, Academy). This looks oversized for a danger-zone action button.

## Solution
Remove the `w-full` class from the default trigger button inside `DeleteAccountDialog.tsx`. Replace it with `w-auto` so the button only takes up as much space as its content needs.

## Changes

### File: `src/components/settings/DeleteAccountDialog.tsx`
- Change the default trigger `Button` from `className="w-full"` to `className="w-auto"` (line ~82)
- This single change fixes all 4 settings pages (Trainer, Player, Club, Academy) since they all use the default trigger

No other files need to be modified.
