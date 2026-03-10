

## UI Cleanup: Registration Page Header

### Problem
The top of the registration page is cluttered — the cycle name, dates, deadline, location, status badge, and description all sit inside one card with inconsistent hierarchy. Location appears twice (once in meta row, once in `CycleDetailDisplay`). The description with rich text makes the card feel heavy.

### Design

Restructure the header area into clearer sections:

1. **Owner branding** — keep as-is (logo + name), no changes needed
2. **Cycle hero section** — outside a card, cleaner layout:
   - Cycle name as `h1`
   - Location displayed prominently below the name (larger text, not inline with dates)
   - Meta row: dates + deadline + status badge (compact, secondary)
3. **Details card** — separate card for description, price table, terms (only if content exists)
4. Remove duplicate location from `CycleDetailDisplay` since it's now shown prominently in the hero

### Files to change

**`src/pages/BrandedCycleRegistration.tsx`** (lines 259-309):
- Move cycle name + location out of the card into a standalone hero section
- Show location with a slightly larger/bolder style beneath the title
- Keep dates, deadline, badge as a compact meta row below
- Move description/price/terms into a separate details card below

**`src/components/cycles/CycleDetailDisplay.tsx`**:
- Add an optional `hideLocation` prop (default false) so the branded registration page can suppress the duplicate location display
- The component is used elsewhere too, so we keep it backward-compatible

