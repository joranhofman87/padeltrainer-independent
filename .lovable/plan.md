
## Add Minimum Group Size to Cycles

### What this does
Adds a "minimum players" setting when creating a cycle (cyclus), so academy owners can enforce rules like "evening sessions require exactly 4 players." When a player books a session from that cycle, the booking flow will enforce that they book at least the minimum number of spots -- they cannot book fewer players than required.

### Changes

**1. Add `min_group_size` field to the Cycle Form**

In the cycle creation/edit form (`CycleForm.tsx`), add a new number input for "Minimum group size" right next to the existing "Maximum group size" field. This gets stored in `cycle.settings.min_group_size`.

- Default value: 1 (no minimum enforced)
- Validation: must be between 1 and the max_group_size value
- Side-by-side layout with the existing max field

**2. Update the `CycleSettings` type**

Add `min_group_size?: number` to the `CycleSettings` interface in `src/lib/cycles.ts`.

**3. Enforce minimum on the Booking Page**

On the booking page (`BookLesson.tsx`), when a player selects a slot that belongs to a cycle with `min_group_size` set:

- In "flexible" booking mode: the quantity picker's minimum becomes `min_group_size` instead of 1
- In "individual" booking mode: if `min_group_size > 1`, show a message explaining the slot requires booking multiple spots
- In "full_slot" mode: no change needed (already books all spots)
- Display a clear message like "This session requires a minimum of 4 players"

**4. Pass cycle settings through to slots**

The cycle's `min_group_size` needs to be accessible when viewing a slot. The slot already has a `cyclus_id` reference. We'll fetch the cycle settings when displaying booking details for cycle-linked slots, or store the min_group_size on the slot/lesson level.

### Technical Details

**File: `src/lib/cycles.ts`**
- Add `min_group_size?: number` to `CycleSettings` interface (line ~51)

**File: `src/components/cycles/CycleForm.tsx`**
- Add `min_group_size` to the form schema (default 1, min 1)
- Add form field next to the existing `max_group_size` field in a grid layout
- Include in the `settings` object on submit
- Add validation: `min_group_size` must be less than or equal to `max_group_size`

**File: `src/pages/BookLesson.tsx`**
- When loading slots, also fetch cycle settings for slots with `cyclus_id`
- In the quantity picker section, use `min_group_size` as the lower bound instead of hardcoded 1
- Show informational message when minimum is enforced: "This session requires at least X players"
- Disable the "Confirm Booking" button if quantity is below the minimum

**File: `src/i18n/locales/en/cycles.json` and `nl/cycles.json`**
- Add translation keys: `form.minGroupSize`, `form.minGroupSizeHelp`

### Example User Flow

1. Academy owner creates a cycle, sets min group size = 4, max group size = 4
2. Player opens a session from that cycle to book
3. The quantity picker starts at 4 (minimum) and maxes at 4 -- effectively "exactly 4 players"
4. Player must provide details for all 4 players before confirming
