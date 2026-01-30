
# Plan: Admin Academy Location & Trainer Linking

## Overview

Extend the AcademyEditDialog to allow admins to link/unlink locations and trainers directly. Currently, the dialog only displays existing connections but doesn't allow modifications.

## Current State

The Locations and Trainers tabs in the AcademyEditDialog show:
- A table of connected locations/trainers if any exist
- An empty state message if none are connected

## Proposed Changes

### Locations Tab Enhancements

Add the ability for admins to:
1. **Add Location**: A searchable dropdown (using LocationPicker) to select and link locations
2. **Remove Location**: A delete button on each location row to unlink
3. **Toggle Settings**: Inline switches for `is_active` and `show_on_academy_page`

```text
+--------------------------------------------------+
|  Locations (2)                                   |
+--------------------------------------------------+
|  [+ Add Location]                                |
|                                                  |
|  Location    | City     | Status  | Visible | X |
|  ------------|----------|---------|---------|---|
|  Padel X     | Amsterdam| Active  | Yes     | X |
|  Club Y      | Rotterdam| Inactive| No      | X |
+--------------------------------------------------+
```

### Trainers Tab Enhancements

Add the ability for admins to:
1. **Add Trainer**: A searchable dropdown to select existing trainers from the platform
2. **Set Payment %**: Slider/input for payment percentage when adding
3. **Remove Trainer**: A delete button on each trainer row
4. **Update Status**: Inline status toggle (active/inactive)

```text
+--------------------------------------------------+
|  Trainers (1)                                    |
+--------------------------------------------------+
|  [+ Add Trainer]                                 |
|                                                  |
|  Trainer     | Email     | Status | Pay % |  X  |
|  ------------|-----------|--------|-------|-----|
|  John Doe    | john@..   | Active | 70%   |  X  |
+--------------------------------------------------+
```

## Implementation

### 1. Add Trainer Picker Component

Create a searchable trainer picker that:
- Fetches all trainers from `trainer_profiles` joined with `profiles` for names/emails
- Excludes trainers already linked to this academy
- Returns selected trainer_profile_id

### 2. Update AcademyEditDialog

**File:** `src/components/admin/AcademyEditDialog.tsx`

Add state and handlers for:
- `showAddLocation` / `showAddTrainer` dialogs
- `handleAddLocation(locationId, contractType)` - Insert into `academy_locations`
- `handleRemoveLocation(academyLocationId)` - Delete from `academy_locations`
- `handleToggleLocationActive(id, value)` - Update `is_active`
- `handleAddTrainer(trainerProfileId, paymentPercentage)` - Insert into `academy_trainers`
- `handleRemoveTrainer(academyTrainerId)` - Delete from `academy_trainers`

**Note:** Admin operations need to bypass regular RLS since admins have full access.

### 3. Update Database RLS (if needed)

Check if admins already have policies for:
- `academy_locations` - INSERT/DELETE
- `academy_trainers` - INSERT/DELETE

If not, add admin policies for these operations.

## Technical Details

### Adding a Location (Admin)
```typescript
const handleAddLocation = async (locationIds: string[]) => {
  for (const locationId of locationIds) {
    await supabase.from("academy_locations").insert({
      academy_profile_id: academy.id,
      location_id: locationId,
      is_active: true,
      show_on_academy_page: true,
      contract_type: "non_exclusive"
    });
  }
  loadRelatedData(); // Refresh
};
```

### Adding a Trainer (Admin)
```typescript
const handleAddTrainer = async (trainerProfileId: string, paymentPercentage: number) => {
  await supabase.from("academy_trainers").insert({
    academy_profile_id: academy.id,
    trainer_profile_id: trainerProfileId,
    status: "active",
    payment_percentage: paymentPercentage,
    show_on_academy_page: true,
    joined_at: new Date().toISOString()
  });
  loadRelatedData();
};
```

### Fetching All Trainers for Selection
Using the established pattern from `useAdminData.ts`:
```typescript
// Get trainer_profiles
const { data: trainers } = await supabase
  .from("trainer_profiles")
  .select("id, user_id")
  .eq("is_verified", true);

// Get profiles for names
const { data: profiles } = await supabase
  .from("profiles")
  .select("user_id, full_name, email")
  .in("user_id", userIds);
```

## Database Changes Required

Add admin RLS policies for direct manipulation:

| Table | Policy | Command |
|-------|--------|---------|
| `academy_locations` | Admins can insert locations | INSERT |
| `academy_locations` | Admins can update locations | UPDATE |
| `academy_trainers` | Admins can insert trainers | INSERT |
| `academy_trainers` | Admins can update trainers | UPDATE |

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| Database migration | Create | Add admin RLS policies for academy_locations and academy_trainers |
| `src/components/admin/AcademyEditDialog.tsx` | Modify | Add location/trainer management UI and handlers |

## UI Components

The enhanced Locations tab will include:
- "Add Location" button at the top
- LocationPicker popover for selection
- Table with action column (delete button)
- Inline toggles for status/visibility

The enhanced Trainers tab will include:
- "Add Trainer" button at the top
- TrainerPicker popover with search
- Payment percentage input when adding
- Table with action column (delete button)

## Expected Outcome

After implementation:
- Admins can add/remove locations from any academy
- Admins can add/remove trainers from any academy
- Changes are immediately reflected in the dialog
- All operations use proper admin RLS policies
