

## Remove indicative pricing note from registration form

Remove the "Indicatieve prijzen — bevestigd na inschrijving" text shown at the bottom of the price summary card.

### Changes

**`src/components/cycles/CycleApplicationForm.tsx`** (lines 963-967): Remove the `{hasAnyPrice && (...indicativeNote...)}` block.

No need to remove the translation keys — they're harmless as unused strings.

