

## Add Academy Manager from Trainers

### What's changing

Academy owners will be able to add trainers (who are already part of the academy) as managers/admins directly from the Settings page. A dropdown will show available trainers, and a button will add them as a manager to the `academy_managers` table.

### Changes

**1. Add helper functions to `src/lib/academy.ts`**

- `addAcademyManager(academyProfileId, userId, role)` -- inserts into `academy_managers`
- `removeAcademyManager(managerId)` -- deletes from `academy_managers` (only non-owners)
- `getAcademyTrainersWithProfiles(academyProfileId)` -- fetches active trainers with their `user_id` and profile info (name, email, avatar) for the dropdown

**2. Update `src/pages/academy/AcademySettings.tsx`**

- Add state for the trainer list and selected trainer
- Fetch active academy trainers on mount (alongside managers)
- Filter out trainers who are already managers
- Show a Select dropdown + "Add" button below the managers list
- Only show the add controls for users who are owners
- Add a remove button (X or trash icon) on non-owner manager rows, with confirmation
- After adding/removing, refresh the managers list

**3. Update translation files**

- `src/i18n/locales/en/academy.json` -- add keys: `managers.addManager`, `managers.selectTrainer`, `managers.added`, `managers.removed`, `managers.remove`, `managers.confirmRemove`, `managers.noTrainersAvailable`
- `src/i18n/locales/nl/academy.json` -- add Dutch equivalents

### Technical Details

**Add manager function:**
```typescript
export async function addAcademyManager(
  academyProfileId: string,
  userId: string,
  role: 'manager' = 'manager'
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('academy_managers')
    .insert({
      academy_profile_id: academyProfileId,
      user_id: userId,
      role,
    });
  if (error) return { success: false, error: error.message };
  return { success: true };
}
```

**Trainer dropdown query** (reuses `academy_trainers` joined with `trainer_profiles` and `profiles` to get `user_id`, `full_name`, `avatar_url`):
```typescript
const { data } = await supabase
  .from('academy_trainers')
  .select(`
    trainer_profile:trainer_profiles(
      id, user_id,
      profile:profiles!trainer_profiles_user_id_fkey(user_id, full_name, email, avatar_url)
    )
  `)
  .eq('academy_profile_id', academyProfileId)
  .eq('status', 'active');
```

**UI in Settings page:**
- Below the existing managers list, show a row with a Select component (trainer name + avatar) and an "Add" Button
- On each non-owner manager row, show a remove button (only visible to owners)
- The current user's own `academy_managers` role determines if they see owner-only controls

### Files to modify
- `src/lib/academy.ts` -- add `addAcademyManager`, `removeAcademyManager`, `getAcademyTrainersForManagerPicker`
- `src/pages/academy/AcademySettings.tsx` -- add trainer dropdown, add/remove manager UI
- `src/i18n/locales/en/academy.json` -- add manager translation keys
- `src/i18n/locales/nl/academy.json` -- add Dutch manager translation keys

