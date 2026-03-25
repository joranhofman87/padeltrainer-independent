
Problem identified from your console logs:
- The open slots request fails with `PGRST200` because `AcademyPublicOpenSlots` is trying to do a nested join `trainer_profiles -> profiles:user_id`, but there is no direct FK relationship for that nested path.
- Because the query errors, `dayGroups` stays empty and the whole section returns `null`, so nothing is shown.

Implementation plan (focused fix):

1) Update `src/components/academy/AcademyPublicOpenSlots.tsx` query strategy
- Remove the nested relational select that causes the error:
  - remove `trainer_profiles:trainer_id(... profiles:user_id(full_name))`
- Keep the slots query simple and safe:
  - fetch slot fields + `trainer_id` + `location` only.

2) Fetch trainer slug/name in sequential queries (no problematic nested join)
- Query `trainer_profiles_safe` with collected `trainer_id`s to get `id, slug, user_id`.
- Query `profiles_public` with collected `user_id`s to get `full_name`.
- Merge results in-memory:
  - `trainer_slug` from `trainer_profiles_safe`
  - `trainer_name` from `profiles_public`
- This follows the existing project pattern for trainer/profile data and avoids schema-cache relationship errors.

3) Keep current slot UI requirements intact
- Preserve:
  - Date
  - Time
  - Cyclus vs single-session badge
  - Indoor/outdoor badge
  - Location
  - Price per session + total for cyclus
  - Book CTA routing (cyclus registration vs trainer booking page)

4) Harden rendering + cleanup
- Remove temporary debug `console.log` lines.
- Add defensive dedupe by `slot.id` before grouping/rendering to prevent duplicate React key warnings.
- Keep graceful fallback if trainer name is unavailable (show row without trainer name, not a crash).

5) Verify end-to-end on `/en/academies/rl-padel-performance`
- Confirm section renders between “Open for Registration” and “Academy Locations”.
- Confirm console no longer shows `PGRST200`.
- Confirm Book button routes correctly for:
  - cyclus slot (`/academies/{academySlug}/register/{cyclusId}`)
  - standalone slot (`/book/{trainerSlug}`).
