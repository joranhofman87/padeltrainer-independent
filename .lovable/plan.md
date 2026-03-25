

# Hide Calendar Sync + Add .ICS Download for Cycles

## What Changes

### 1. Hide Calendar Sync from Player Settings
Remove the Calendar Sync card from the settings grid and the sidebar link. Keep the route/page intact so it can be re-enabled later.

| File | Change |
|------|--------|
| `src/pages/PlayerSettings.tsx` | Remove the calendar sync entry from `settingsItems` array (lines 33-40), remove `CalendarSync` import |
| `src/components/player/PlayerSidebar.tsx` | Remove/comment out the calendar sync nav link (line 276-281) |
| `src/components/DomainRouter.tsx` | Comment out the calendar route for player (line 211) — keeps code, hides access |

### 2. Add "Add to Calendar" (.ICS download) Button on Player Bookings
Instead of a full Google Calendar integration, generate a downloadable `.ics` file for each cycle's sessions so players can import them into any calendar app (Google, Apple, Outlook).

**Where it appears:**
- On the **Player Bookings** page — an "Add to Calendar" button per booking/cycle
- Optionally on the **Booking Success** page after payment

**How it works (client-side, no edge function needed):**
- Create a utility `src/lib/icsGenerator.ts` that builds a valid iCalendar `.ics` string from booking data (event title, start/end time, location, trainer name)
- For a full cycle: generate a single `.ics` file containing all sessions as separate `VEVENT` entries
- Trigger a browser download when the player clicks "Add to Calendar"

**ICS format is universal** — works with Google Calendar, Apple Calendar, Outlook, etc. No OAuth integration needed.

| File | Change |
|------|--------|
| `src/lib/icsGenerator.ts` | New file — utility to generate `.ics` content from booking/slot data |
| `src/pages/player/PlayerBookings.tsx` (or equivalent) | Add "Add to Calendar" button that generates and downloads the `.ics` file |

