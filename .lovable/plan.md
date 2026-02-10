

## Redesign Trainer + Academy Dashboards as Activity Overview

### What changes
Replace the current calendar-heavy trainer dashboard and the static academy dashboard with a clean activity overview showing four recent-data tables: **My Players**, **My Bookings**, **Registrations**, and **My Open Spots**. Each section shows the 10 most recent/upcoming items with a "View all" link to the full page.

### Layout (both dashboards)

1. **Trial/verification banners** -- kept as-is at the top
2. **Stats cards row** -- kept as-is (profile views, followers, students, open slots, revenue for trainer; trainers, locations, views for academy)
3. **Unpaid bookings card** -- kept as-is
4. **Activity sections** -- 4 cards in a 2-column grid:
   - **Recent Players** (last 10 by join date) with "View all" link to /players
   - **Recent Bookings** (last 10 by created_at) with "View all" link to /bookings (trainer) or /calendar (academy)
   - **Registrations** (last 10 cycle applications) with "View all" link to /intake-requests
   - **Upcoming Open Spots** (next 10 upcoming available slots) with "View all" link to /open-slots (trainer) or /calendar (academy)

Each table is a compact Card with a small table (name, date, status badge) -- no search, no filters, just a quick glance.

### Technical details

**File: `src/pages/TrainerDashboard.tsx`** (major rewrite)
- Remove all calendar state, calendar fetching, calendar navigation, calendar grid, and all dialog components (SlotTypeChoiceDialog, AddSlotDialog, BulkCreateSheet, BookForPlayerDialog, DuplicateCyclusDialog, DeleteSlotDialog, EditBookingDialog)
- Keep: stats fetching, stats cards, trial banner, unpaid bookings card
- Add 4 new data fetches (all using existing supabase queries, limited to 10):
  1. **Recent Players**: query `guest_players` + `bookings` -> `profiles` (reuse pattern from TrainerPlayers.tsx), order by `created_at desc`, limit 10
  2. **Recent Bookings**: query `bookings` with `availability_slots!inner` filter on trainer_id, order by `created_at desc`, limit 10
  3. **Registrations**: query `cycle_applications` joined with `cycles` filtered by trainer_id, order by `created_at desc`, limit 10
  4. **Upcoming Open Spots**: query `availability_slots` where start_time >= now, not marked full, order by `start_time asc`, limit 10
- Render 4 Cards each containing a small Table with 3-4 columns and a CardHeader with title + "View all" Button

**File: `src/pages/academy/AcademyDashboard.tsx`** (major rewrite)
- Keep: trial banners, verification alert, stats cards, unpaid bookings
- Remove: quick action cards (manage trainers, manage locations)
- Add same 4 activity sections, but scoped to academy:
  1. **Recent Players**: bookings on slots belonging to academy trainers
  2. **Recent Bookings**: bookings on slots belonging to academy trainers
  3. **Registrations**: cycle applications for academy cycles
  4. **Upcoming Open Spots**: slots from academy trainers
- "View all" links point to academy equivalents (/app/academy/trainers, /app/academy/calendar, /app/academy/intake-requests)

**i18n keys** -- Add new keys to `src/i18n/locales/en/trainer.json` and `src/i18n/locales/nl/trainer.json` (and academy equivalents):
- `dashboard.recentPlayers`, `dashboard.recentBookings`, `dashboard.registrations`, `dashboard.upcomingSpots`, `dashboard.viewAll`

### What stays the same
- The dedicated Calendar page (`/trainer/calendar`) remains fully functional and unchanged
- All sidebar navigation remains unchanged
- Stats cards at the top remain unchanged
- All existing full pages (Players, Bookings, Cycles, Open Slots) remain unchanged

### Scope
- TrainerDashboard.tsx: ~870 lines reduced to ~350 lines (all calendar/dialog code removed)
- AcademyDashboard.tsx: ~190 lines expanded to ~300 lines (activity tables added)
- 4 i18n files updated (en/nl for trainer/academy)

