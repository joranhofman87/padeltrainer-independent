

## Admin Player Ratings Page

### What
A new admin page at `/app/admin/player-ratings` that shows a spreadsheet-like table of all players with their KNLTB rating history. Each month (starting January 2026) gets its own column, and admins can click cells to enter/update ratings. Changes are saved to the existing `player_rating_history` table and also update the player's current `skill_rating` in `profiles`, keeping the Rating Progress chart on player profiles in sync.

### Layout

The page shows a horizontally scrollable table:

```text
| Name          | KNLTB Number | Current | Jan 2026 | Feb 2026 | ... | [current month] |
|---------------|-------------|---------|----------|----------|-----|-----------------|
| John Doe      | 12345678    | 7.5     | 8.0      | 7.8      |     | 7.5             |
| Jane Smith    | 87654321    | 6.2     | [click]  |          |     |                 |
```

- Columns auto-extend up to the current month
- Each month cell is editable inline (click to edit, blur/Enter to save)
- A search bar filters by player name or KNLTB number
- Only shows players with `rating_system = 'knltb'` (or all players with a filter toggle)

### Changes

**1. New file: `src/pages/admin/AdminPlayerRatings.tsx`**

- Fetch all profiles where `rating_system = 'knltb'` (with `full_name`, `rating_member_id`, `skill_rating`, `id` as profile_id)
- Fetch all `player_rating_history` rows for those profile_ids where `rating_system = 'knltb'`
- Generate month columns from Jan 2026 to the current month
- Build a map: `profileId -> month -> rating` for quick cell lookup
- Render editable table with inline input cells
- On save: upsert into `player_rating_history` with `scraped_at` set to the 1st of that month, `source = 'admin'`, `rating_system = 'knltb'`
- If saving the latest month, also update `profiles.skill_rating` for that player
- Search filter on name / rating_member_id

**2. Update `src/components/admin/AdminSidebar.tsx`**

- Add "Player Ratings" nav item under the main nav (after Users), using the `Star` icon from lucide-react
- URL: `/app/admin/player-ratings`

**3. Update `src/components/DomainRouter.tsx`**

- Add route: `<Route path="player-ratings" element={<AdminPlayerRatings />} />`
- Add lazy import for the new page

### Data flow

- Saving a cell upserts a row in `player_rating_history` with `scraped_at` = first day of the month, `rating_system = 'knltb'`, `source = 'admin'`
- The `RatingHistoryChart` component already queries this exact table filtered by `profile_id` and `rating_system`, so charts update automatically
- When the latest month rating is saved, `profiles.skill_rating` is updated too, keeping the "Current rating" display in sync

### Technical details

- Month columns generated dynamically: `eachMonthOfInterval({ start: new Date(2026, 0, 1), end: new Date() })`
- Uses `date-fns` `format` and `startOfMonth` for date handling
- Cell editing uses local state with optimistic updates
- Upsert logic: check if a `player_rating_history` row exists for that profile_id + month, update if so, insert if not
- Table uses horizontal scroll for many month columns
- No new database tables or migrations needed -- uses existing `player_rating_history` and `profiles`

