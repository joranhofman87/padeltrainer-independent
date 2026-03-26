

# Remove Calendar Integration Settings Card

## Problem
The Google Calendar integration settings card is still visible in Trainer Settings (route `/settings/calendar`), even though the route itself is already commented out in `DomainRouter.tsx`. Clicking it leads nowhere useful.

## Changes

| File | Change |
|------|--------|
| `src/pages/TrainerSettings.tsx` | Remove the calendar sync settings card (lines 218-225) from the `settingsCards` array. Remove `CalendarSync` from the lucide-react import if no longer used. |

The `CalendarSettings.tsx` page, `src/lib/calendar.ts`, and the edge functions (`google-calendar-auth`, `google-calendar-callback`, `sync-calendar-event`) can remain as dead code for now — they're not referenced from any active route. The route is already commented out in `DomainRouter.tsx`.

