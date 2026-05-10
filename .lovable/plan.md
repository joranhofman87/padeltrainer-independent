## Problem

In the Academy Dashboard's "Recente boekingen" widget, the same player appears multiple times (e.g. Larissa Rand × 4) instead of being grouped as one row with a session count.

## Root cause

`src/pages/academy/AcademyDashboard.tsx` groups bookings by `cyclus_name + player_id`, but the Supabase select only fetches the **joined** `profiles` / `guest_players` relations — it never selects the raw `player_id` or `guest_player_id` columns. As a result the grouping key is always empty, the `if (cyclusName && playerId)` branch is never taken, and every booking row is pushed individually into `recentBookings`.

The "Cyclus —" dashes are a related symptom: when `cyclus_name` is null on the slot, no grouping happens either.

## Fix (UI/data layer only)

In `AcademyDashboard.tsx`, inside the bookings query (around line 115):

1. Add `player_id, guest_player_id` to the select string so grouping has real IDs to key on.
2. Make the grouping fall back gracefully: if `cyclus_name` is missing, group by `(cyclus_id || 'no-cyclus') + playerId` instead of skipping grouping entirely. Pull `cyclus_id` into the slot select too.
3. Keep `sessionCount` increment behavior, so the row can show e.g. "Larissa Rand · 4 sessions" (or just dedupe — see question below).
4. Bump the initial `.limit(10)` to a higher number (e.g. 30) since we're now collapsing rows; otherwise after grouping we may show fewer than 10 unique entries.

No schema/RLS/business-logic changes. Trainer dashboard is not touched (Academy-only fix, and trainer side has its own widget).

## Out of scope

- Visual redesign of the table
- Trainer dashboard changes
- Backend/edge function changes

## Open question

Should the grouped row show a session count (e.g. "Larissa Rand — 4 sessions in Cyclus X") or just dedupe silently to one row per player+cyclus with no count? I'd suggest showing the count since `sessionCount` is already being computed.
