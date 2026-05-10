## Problem

The agenda's "All Players" sidebar (in `AcademyDayGrid`) only shows players that already have a non-cancelled booking with one of the academy's trainers. That's why the count (e.g. 105) is much lower than the full roster shown on the Players page, and trainers can't drag a brand-new or never-booked player onto a slot.

The source is `fetchAllKnownPlayers` in `src/pages/academy/AcademyCalendar.tsx`, which only joins through `bookings`.

## Goal

The sidebar should list every player known to the academy (same set as the Players page tab "All Players"), so trainers can search any player and drag them onto a slot.

## Plan

1. **Replace `fetchAllKnownPlayers` in `src/pages/academy/AcademyCalendar.tsx`** to mirror the logic used by `AcademyPlayers.fetchPlayers`:
   - **Guest players**: union of
     - `guest_players` where `trainer_id IN (academyTrainerIds)`
     - `guest_players` where `academy_profile_id = activeAcademy.id AND trainer_id IS NULL`
     - dedupe by id; mark `is_guest: true`
   - **Registered players**: distinct `profiles` referenced via the academy's trainers (through `bookings.player_id` and `intake_requests.player_id` joined on `availability_slots.trainer_id IN trainerIds`), excluding any whose id is already covered by a linked guest record (matches AcademyPlayers' linked-id dedupe). Mark `is_guest: false`.
   - Map each into the existing `KnownPlayer` shape (`id`, `full_name`, `skill_rating`, `rating_system`, `is_guest`).
   - Sort alphabetically and `setAllKnownPlayers(...)`.

2. **No UI changes** required: the sidebar already renders `allKnownPlayers.length` as the badge and filters `filteredSidebarPlayers` by `sidebarSearch`, so increasing the underlying list automatically fixes the count and the search.

3. **Keep the drag/drop contract intact**: `KnownPlayer.id` for guests stays the raw `guest_players.id` (with `is_guest: true`), for registered players stays the raw `profiles.id`. This matches what the existing booking flow expects on drop, so no consumer changes are needed.

4. **Refresh trigger**: `fetchAllKnownPlayers` keeps being called on the existing effect (mount + academy change). No extra invalidation needed for this fix.

## Out of scope

- Refactoring the AcademyPlayers query into a shared hook (can be a follow-up; for now we duplicate the minimal query needed for the sidebar to keep the change small and isolated).
- Showing extra metadata (location, has_active_cyclus, status badges) in the sidebar — the sidebar stays a lean name + rating list as today.
- Changing the Players page itself.

## Files to edit

- `src/pages/academy/AcademyCalendar.tsx` — rewrite `fetchAllKnownPlayers` only.
