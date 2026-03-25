

# Reorder Extra Costs: Presets First, Manual Second + Fix Hover Styling

## Problem
1. **Hover readability** — preset items in the popover have poor contrast on hover (text becomes unreadable against accent background)
2. **Wrong order** — currently shows manual input fields first, then "Kies uit presets" button. Should be presets first, then manual add option
3. **No link to preset settings** — user can't navigate to settings to create presets from this UI

## Changes

### 1. `ExtraCostPresetPicker.tsx` — Fix hover contrast
- Change hover class from `hover:bg-accent` to `hover:bg-accent hover:text-accent-foreground` so text stays readable
- When no presets exist, add a link to settings (e.g. "Beheer presets in instellingen →")

### 2. `AddSlotDialog.tsx` (lines ~1334-1363) — Reorder buttons & layout
**Current order inside `hasExtraCosts` block:**
1. Manual cost input fields (description, price, VAT, type)
2. "+ Add cost" button + "Kies uit presets" button

**New order:**
1. `ExtraCostPresetPicker` button — shown first, prominently
2. "+ Handmatig toevoegen" button — secondary, below presets
3. Already-added cost items (manual fields) shown below the buttons
4. Small link: "Presets beheren →" pointing to `/app/settings` (or trainer settings section)

### 3. Preset picker improvements
- In the empty state, include a link to settings page to manage presets
- Add the same "Presets beheren →" link at the bottom of the popover when presets exist

| File | Change |
|------|--------|
| `src/components/settings/ExtraCostPresetPicker.tsx` | Fix hover contrast, add settings link |
| `src/components/trainer/AddSlotDialog.tsx` | Reorder: presets first, manual add second |

