
## Redesign Player Dashboard to Match Trainer/Academy Pattern

### Overview
Restructure the Player Dashboard to follow the same layout pattern as the Trainer and Academy dashboards: quick-action cards at the top, followed by activity tables in a 2-column grid.

### Layout Structure

```text
+--------------------------------------------------+
| Welcome back, Player!                            |
+--------------------------------------------------+
| Rating History Chart                             |
+--------------------------------------------------+
| [Find Trainers] | [My Bookings] | [My Profile]  |   <-- 3 quick-action cards (top)
+--------------------------------------------------+
| Upcoming Bookings (table)  | Followed Trainers   |   <-- 2x2 activity tables
|   - session, trainer, date |   (table w/ avatar)  |
|   [View all -> bookings]   |   [View all ->       |
|                            |    trainers page]    |
+----------------------------+---------------------+
| Open Slots from Followed   | Waiting List        |
|   Trainers (table)         |   Entries            |
|   [View all -> trainers]   |                      |
+----------------------------+---------------------+
```

### What gets removed
- The 4 stats cards (Upcoming count, Completed, Total Bookings, Following)
- The "Next Up" styled card with booking previews
- The "Following" avatar chips section
- The "Quick Actions" grid (Find Trainers, My Bookings, My Profile, Calendar Sync) -- moved to top as simpler cards
- The "Featured Trainers" section with trainer cards

### What gets added/changed
1. **Top: 3 Quick-Action Cards** (matching Academy stats card style) -- Find Trainers, My Bookings, My Profile -- each clickable with arrow icon
2. **Upcoming Bookings Table** -- reuse existing data, show as proper Table with columns: Session, Trainer, Date, Status. Increase limit to 10. Link "View all" to `/app/player/bookings`
3. **Followed Trainers Table** -- show trainer name (with avatar), link to profile. "View all" links to marketing trainers page
4. **Open Slots from Followed Trainers** -- new query: fetch upcoming public availability_slots from followed trainer IDs. Show session name, trainer, date/time. "View all" links to trainers page
5. **Waiting List Entries** -- keep existing `MyWaitingListEntries` component in the grid

### Technical Details

**File: `src/pages/PlayerDashboard.tsx`**

- Remove `FeaturedTrainer` interface and `fetchFeaturedTrainers` function
- Remove unused state: `featuredTrainers`, `loadingTrainers`
- Add new state: `followedTrainerSlots` for open slots from followed trainers
- Add new fetch function `fetchFollowedTrainerSlots` that queries `availability_slots` where `trainer_id` is in the followed trainer IDs, `is_marked_full = false`, `start_time >= now`, `is_public = true`, limited to 10
- Enrich slots with trainer names using the existing two-step profile lookup pattern
- Update `fetchFollowedTrainers` to remove the limit of 5 (show up to 10 in table)
- Update `fetchPlayerData` to increase upcoming bookings slice to 10 and add `status` to `UpcomingBooking` interface
- Replace entire render section with new layout:
  - 3 top cards in a `grid-cols-1 md:grid-cols-3` grid
  - 4 activity sections in a `grid-cols-1 md:grid-cols-2` grid using `Table` components
- Add imports for `Table, TableBody, TableCell, TableHead, TableHeader, TableRow` and `ArrowRight`
- Remove unused imports: `Star`, `MapPin`, `Bell`, `Settings`, `CalendarSync`, `LanguageSwitcher`, `LogOut`, `signOut`
