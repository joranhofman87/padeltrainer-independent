

# Inline Add Player Form on Create Tab

## Summary
Replace the Create tab's button-only content with the full add-player form inline, plus keep CSV import as a secondary action. Extract the form logic from `AddPlayerDialog` into a reusable `AddPlayerForm` component.

## Changes

### 1. `src/components/trainer/AddPlayerForm.tsx` — New component
Extract the form body (lines 220-348 of `AddPlayerDialog.tsx`) into a standalone `AddPlayerForm` that:
- Accepts same props: `trainerId`, `academyId`, `onPlayerCreated`
- Contains all state (fullName, email, phone, rating, notes, linkedProfile)
- Shows a success state after creation with a "Add another player" button to reset
- No Dialog wrapper — just the raw form in a Card

### 2. `src/components/trainer/AddPlayerDialog.tsx` — Refactor to use AddPlayerForm
- Import `AddPlayerForm` and render it inside the Dialog, keeping the dialog as a thin wrapper
- Export `GuestPlayer` interface as before

### 3. `src/pages/academy/AcademyPlayers.tsx` — Update Create tab
Replace the current button-only card (lines 728-750) with:
- A two-column layout (on md+): left side = inline `AddPlayerForm` in a Card, right side = CSV import Card with the import button
- Remove `showAddPlayer` state usage for this tab (form is always visible)
- Keep the `AddPlayerDialog` for other places that trigger it (e.g. slot booking)

## File summary

| File | Change |
|------|--------|
| `src/components/trainer/AddPlayerForm.tsx` | **New** — Extracted form component with all add-player logic |
| `src/components/trainer/AddPlayerDialog.tsx` | Refactor to wrap `AddPlayerForm` in a Dialog |
| `src/pages/academy/AcademyPlayers.tsx` | Embed `AddPlayerForm` inline on the Create tab |

