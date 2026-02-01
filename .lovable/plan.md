

# Academy Calendar Fixes Plan

## Issues Identified

### 1. Trainer Names Showing as "Unknown"
The current code in `loadAcademyData()` queries the private `profiles` table directly:
```typescript
const { data: profile } = await supabase
  .from("profiles")  // <-- Private table with RLS restrictions
  .select("full_name, avatar_url")
  .eq("user_id", trainer.user_id)
```

The RLS policy on `profiles` only allows:
- Admins to view all profiles
- Users to view their own profile
- Service role to view all

Academy managers don't have permission to read other users' profiles, so the query fails silently and returns `null`, resulting in "Unknown" names.

### 2. Missing Action Buttons
The Club calendar has "Add Slot" and "Create Cyclus" buttons (lines 362-370 in ClubCalendar.tsx), but the Academy calendar is missing these controls.

---

## Solution

### Fix 1: Use `profiles_public` View Instead of `profiles` Table

Replace the manual trainer fetching logic in `loadAcademyData()` with the existing `getAcademyTrainersWithProfiles()` function from `src/lib/academy.ts`, which correctly uses the `profiles_public` view.

```text
Current (broken):
  for (const t of academyTrainers) {
    const { data: profile } = await supabase.from("profiles")...
  }

After fix:
  const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
  // This function uses profiles_public internally
```

### Fix 2: Add Action Buttons

Add buttons above the calendar matching the Club calendar pattern:
- **Add Cycle** button (orange, primary action) - Opens the CycleForm dialog
- The filters stay as-is but are repositioned to be grouped with the buttons

---

## Technical Changes

### File: `src/pages/academy/AcademyCalendar.tsx`

1. **Import changes**:
   - Add import for `getAcademyTrainersWithProfiles` from `@/lib/academy`
   - Add import for `CycleForm` from `@/components/cycles/CycleForm`

2. **State additions**:
   - `showCreateCycleDialog` (boolean) - Controls CycleForm visibility
   - `trainerOptions` (array) - Trainer ID/name pairs for CycleForm

3. **Update `loadAcademyData()` function**:
   - Replace manual profile fetching with `getAcademyTrainersWithProfiles()`
   - This ensures proper use of `profiles_public` view
   - Build trainer list from the correctly-fetched data

4. **Add UI elements in CardHeader**:
   - Add "Add Cycle" button (orange styling matching Club calendar's "Create Cyclus")
   - Button opens CycleForm dialog

5. **Add CycleForm dialog**:
   - Include the CycleForm component at the end of the component
   - Pass `ownerType="academy"`, `ownerId={activeAcademy.id}`, and trainer options

---

## Result

After these changes:
- Trainer dropdown will show actual names (e.g., "Rene Lindenbergh" instead of "Unknown")
- Academy managers can create new training cycles directly from the calendar view
- UI matches the Club calendar pattern for consistency

