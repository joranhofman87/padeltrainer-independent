

# Registration Detail & Guest Application Flow

## Summary

Three changes: (1) Show more registration info publicly (location, description, terms, price table), (2) Add fields for trainers/academies to input that info when creating registrations, (3) Let unauthenticated players fill out the application form first, then create an account as part of submission.

---

## Database Changes

Add two new columns to the `cycles` table:
- `terms` (text, nullable) — registration-specific terms/voorwaarden (separate from the general trainer/academy terms)
- `price_table` (jsonb, nullable) — array of `{ label: string, price: number }` rows for the tarieven table

No RLS changes needed (existing policies cover cycles).

---

## Phase 1: CycleForm — Add Description, Terms & Price Table for Registrations

Currently, the `description` field in CycleForm is only shown for events (`isEvent`). Extend it to also show for registrations (`isRegistration`).

Add two new sections to CycleForm (for both registration and event types):

**Terms (Voorwaarden):**
- Rich text or plain textarea field for cycle-specific terms
- Saved to new `cycles.terms` column

**Price Table (Tarieven):**
- Dynamic row editor (like the existing `extraCosts` pattern): each row has a `label` (text) and `price` (number)
- Saved to new `cycles.price_table` JSONB column
- Add/remove row buttons, same UI pattern as extra costs

Update `CycleInput` interface and `createCycle`/`updateCycle` in `src/lib/cycles.ts` to include `terms` and `price_table`.

---

## Phase 2: Show Registration Details Publicly

Update `AcademyOpenCycles`, `TrainerOpenCycles`, and `LocationOpenCycles` to display:

1. **Location** — fetch location data alongside cycles using `getActiveCycles` (modify query to join `locations(id, name, city)`) and show with a MapPin icon
2. **Description** — already rendered for events; extend the `cycle.description` rendering to all cycle types (remove the event-only guard)
3. **Terms** — show a collapsible/expandable section with the cycle-specific terms text
4. **Price Table** — render a simple table from `cycle.price_table` JSON array showing label + price rows

All of this is visible **before** the user clicks "Apply" — no login required to see the info.

---

## Phase 3: Guest Application Flow (Apply Without Account)

This is the biggest UX improvement. Currently unauthenticated users see "Sign up & apply" which redirects to signup, then they must return.

**New flow for unauthenticated users:**
1. Show the full `CycleApplicationForm` immediately (no login gate)
2. Add email + password fields to the form (only shown when `!user`)
3. On submit:
   - Call `supabase.auth.signUp()` with the provided email/password
   - Create the profile
   - Submit the intake request
   - All in one action

**Implementation:**
- In `AcademyOpenCycles` / `TrainerOpenCycles` / `LocationOpenCycles`: remove the `!user` guard that shows the "Sign up" redirect button. Instead, show the same collapsible form for everyone.
- In `CycleApplicationForm`: 
  - Add conditional password field when `!user` (and make email editable)
  - On submit, if no user session exists, sign up first, then submit the application
  - Show appropriate success message mentioning email verification

- In `CycleApplicationModal`: same changes — show the form for unauthenticated users instead of the login prompt.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Add `terms`, `price_table` to Cycle interface and CycleInput; modify `getActiveCycles` to join locations |
| `src/components/cycles/CycleForm.tsx` | Add description for registrations, terms textarea, price table editor |
| `src/components/cycles/CycleApplicationForm.tsx` | Add signup fields for guests, handle auth+submit in one action |
| `src/components/academy/AcademyOpenCycles.tsx` | Show location/description/terms/prices; allow guest form expand |
| `src/components/trainer/TrainerOpenCycles.tsx` | Same display enhancements |
| `src/components/club/LocationOpenCycles.tsx` | Same display enhancements |
| `src/components/cycles/CycleApplicationModal.tsx` | Show form for unauthenticated users instead of login prompt |

**Migration:** Add `terms` and `price_table` columns to `cycles` table.

