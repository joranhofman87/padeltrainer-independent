

# Enhanced Open Slots on Academy Public Page

## Current State
`AcademyPublicOpenSlots` already fetches `court_type` from `availability_slots` and includes it in `SlotData`, but:
- Filters out cyclus slots (`.is('cyclus_id', null)`)
- Doesn't display `court_type` (indoor/outdoor)
- No total price for cyclus slots
- No proper booking CTA
- Click just navigates to academy page (useless)

## Changes in `src/components/academy/AcademyPublicOpenSlots.tsx`

1. **Remove `.is('cyclus_id', null)`** — show all open slots including cyclus ones
2. **Add to query**: `total_price`, trainer `slug`
3. **Add to `SlotData` interface**: `total_price`, `trainer_slug`
4. **Display per slot row**:
   - Indoor/outdoor badge when `court_type` is set (use 🏠/☀️ pattern from `SlotList.tsx`)
   - Cyclus name badge when `cyclus_name` is set, otherwise "Single session"
   - Price per session always; total price additionally when cyclus
5. **Replace ChevronRight with a "Book" Button** as CTA:
   - Cyclus slot → navigate to `/academies/${academySlug}/register/${cyclus_id}`
   - Standalone slot → navigate to `/book/${trainer_slug}`
6. **Remove the row-level onClick** (replaced by button CTA)

## Position on page
Already correct — between Open Registrations and Locations sections (line 285).

## Files
- `src/components/academy/AcademyPublicOpenSlots.tsx` — all changes in this single file

