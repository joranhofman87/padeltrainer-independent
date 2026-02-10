

## Add Waiting List Toggle for Trainers and Academies

### Overview
Add a `waiting_list_enabled` boolean column to both `trainer_profiles` and `academy_profiles` tables (defaulting to `false`). Create a new "Waiting List" page under the Registration sidebar group for both roles, where they can toggle this feature on/off. The public profile pages will only show the WaitingListCard when the feature is enabled.

### Database Changes

Add a new column to each table:
- `trainer_profiles.waiting_list_enabled` (boolean, default `false`, not null)
- `academy_profiles.waiting_list_enabled` (boolean, default `false`, not null)

### New Pages

**`src/pages/TrainerWaitingList.tsx`** -- A settings-style page (similar to `TrainerBookingSettings.tsx`) with:
- Back button navigating to `/trainer/cycles`
- A Card with a Switch toggle to enable/disable the waiting list
- When enabled, show the `WaitingListTable` component below so trainers can manage entries
- Description text explaining what the waiting list does

**`src/pages/academy/AcademyWaitingList.tsx`** -- Same pattern for academies, navigating back to `/app/academy/cycles`.

### Sidebar Updates

**`src/components/trainer/TrainerSidebar.tsx`**:
- Add "Waiting List" as a third sub-item under the Registration collapsible group (after Registrations and Intake Requests)
- Update `registrationOpen` state to also check for `/trainer/waiting-list`

**`src/components/academy/AcademySidebar.tsx`**:
- Add "Waiting List" as a third sub-item under the Registration collapsible group
- Update `registrationOpen` state to also check for `/app/academy/waiting-list`

### Routing Updates

**`src/components/DomainRouter.tsx`**:
- Add route `waiting-list` under trainer routes pointing to `TrainerWaitingList`
- Add route `waiting-list` under academy routes pointing to `AcademyWaitingList`

### Public Profile Conditional Display

**`src/pages/TrainerProfile.tsx`**:
- Fetch `waiting_list_enabled` from `trainer_profiles` alongside existing trainer data
- Only render `WaitingListCard` when `waiting_list_enabled` is `true`

**`src/pages/AcademyPublicProfile.tsx`**:
- Fetch `waiting_list_enabled` from `academy_profiles` alongside existing academy data
- Only render `WaitingListCard` when `waiting_list_enabled` is `true`

### Translation Keys

Add to both EN and NL trainer/academy translation files:
- `nav.waitingList` -- sidebar label
- `waitingList.settingsTitle` -- page title
- `waitingList.settingsSubtitle` -- page subtitle
- `waitingList.enableTitle` -- toggle card title
- `waitingList.enableDescription` -- explanation of the feature
- `waitingList.enabled` / `waitingList.disabled` -- toast messages

### Technical Details

- The toggle pages follow the exact same pattern as `TrainerBookingSettings.tsx`: fetch setting on mount, update via `supabase.from(...).update(...)` on toggle, show toast feedback
- The `WaitingListTable` component already exists and accepts `ownerType` and `ownerId` props, so it can be embedded directly on the new pages when the feature is enabled
- No RLS changes needed since trainers/academies already have update access to their own profile rows
