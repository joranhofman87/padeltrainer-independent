

## Add Dedicated Club Registrations Page

Currently, the academy has a separate "Registrations" page (`/app/academy/cycles`) with a table, create/edit forms, and event creation. The club does not have an equivalent -- it needs one for consistency.

### Changes

**1. Create `src/pages/club/ClubCycles.tsx`**
- Mirror the structure of `AcademyCycles.tsx` but use `useClubContext()` instead of `useAcademyContext()`
- Use `getCyclesWithCounts('club', activeClub.id)` to fetch cycles
- Get trainers from `getClubTrainers(activeClub.id)` (already exists in `src/lib/club.ts`)
- For locations, use the single club location from `activeClub.location_id` / `activeClub.location`
- Include both "Create Registration" and "Create Event" buttons, opening `CycleForm` with `ownerType="club"`
- Include the `CyclesTable` component for listing

**2. Add route in `DomainRouter.tsx`**
- Add lazy import: `const ClubCycles = lazy(() => import('@/pages/club/ClubCycles'))`
- Add route under club: `<Route path="registrations" element={<ClubCycles />} />`

**3. Add sidebar nav item in `ClubSidebar.tsx`**
- Add a "Registrations" nav link (`/app/club/registrations`) with `BookOpen` icon (already imported)
- Place it after "Calendar" to match the academy sidebar pattern

**4. Remove "Create Cyclus" button from `ClubCalendar.tsx`**
- Remove the orange "Create Cyclus" button and the `ClubBulkCreateSheet` from the calendar page since registrations now have their own dedicated page
- Keep only the "Add Slot" button on the calendar

