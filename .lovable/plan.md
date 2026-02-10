
## Add Player Management (Add + Import) to Academy Players Page

### Problem

The Academy Players page is read-only. Academy managers cannot manually add or import players like trainers can. They should have the same "Add Player" and "Import Players" functionality available on the trainer dashboard.

### Key Challenge

The `guest_players` table requires a `trainer_id`. When an academy has multiple trainers, the manager needs to select which trainer the player should be associated with. The existing `AddPlayerDialog` and `ImportPlayersDialog` components already accept a `trainerId` prop, so we can reuse them directly.

### Changes

**`src/pages/academy/AcademyPlayers.tsx`**

1. Add state for `showAddPlayer`, `showImportPlayers`, `searchQuery`, and `trainerIds` (list of active academy trainer IDs)
2. If the academy has multiple trainers, add a trainer selector (dropdown) so the manager can choose which trainer to associate new players with -- defaulting to the first trainer
3. Add header section with "Import" and "Add Player" buttons (same layout as TrainerPlayers)
4. Add search input for filtering
5. Reuse the existing `AddPlayerDialog` and `ImportPlayersDialog` components, passing the selected `trainerId`
6. Add callbacks (`handlePlayerCreated`, `handlePlayersImported`) that refresh the player list after add/import
7. Expand the `PlayerRow` interface to include `phone`, `skill_rating`, `notes`, `rating_system` fields to match the trainer view
8. Add edit/delete actions for guest players using the existing `EditPlayerDialog` component
9. Add the same contact info, skill rating columns from the trainer view

### Technical Details

- Reuse `AddPlayerDialog` from `@/components/trainer/AddPlayerDialog` (takes `trainerId` prop)
- Reuse `ImportPlayersDialog` from `@/components/trainer/ImportPlayersDialog` (takes `trainerId` prop)
- Reuse `EditPlayerDialog` from `@/components/trainer/EditPlayerDialog`
- Fetch trainer list from `academy_trainers` table to populate trainer selector and set default
- When adding/importing, the selected trainer ID determines ownership of guest_players records
- After add/import, call `fetchPlayers()` to refresh the full list
- RLS: The `guest_players` table already allows inserts by trainers. Academy managers acting on behalf of trainers may need the `create-manual-player` edge function for registered players, but for guest players the existing `AddPlayerDialog` inserts directly. Since the academy user may not own those trainer profiles, we should verify RLS allows this -- if not, we use the existing pattern where academy managers can manage their trainers' data

### Files to modify

- `src/pages/academy/AcademyPlayers.tsx` -- major rewrite to add buttons, search, dialogs, trainer selector, and action menus
