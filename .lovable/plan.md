

## Enable Trainer + Player Dual Role (Opt-in via Settings)

### What's changing

Trainers will be able to opt in to also use the Player dashboard by enabling a toggle in their Trainer Settings. Once enabled, a "Player Dashboard" option appears in the ProfileSwitcher, giving trainers access to book lessons, join waiting lists, and register for cycles as a player.

### How it works

1. Trainer goes to Settings and toggles "Enable Player Mode"
2. This inserts a `player` role into `user_roles` for that user (via an edge function to prevent privilege escalation)
3. The ProfileSwitcher now shows a "Player Dashboard" option
4. Trainer can switch between Trainer and Player dashboards freely
5. If toggled off, the player role is removed

### Changes

**1. New backend function to toggle player role**

Create an edge function `toggle-player-role` that:
- Accepts `{ enable: boolean }` from the authenticated user
- If `enable: true`, inserts a `player` role for the user (ON CONFLICT DO NOTHING)
- If `enable: false`, deletes the `player` role for the user
- Only works for users who already have the `trainer` role
- Uses service role key to bypass RLS

**2. Add "Player Mode" toggle to Trainer Settings**

- File: `src/pages/TrainerSettings.tsx`
- Add a new Card section (similar to the existing "Marketplace visibility" card) with a Switch toggle
- Label: "Player mode" with description "Access the player dashboard to book lessons with other trainers"
- On toggle, call the `toggle-player-role` edge function, then refresh auth state
- Only show this toggle for trainers (not admins viewing trainer settings)

**3. Update PlayerLayout auth guard**

- File: `src/components/player/PlayerLayout.tsx`
- Change from checking `role` (primary) to checking `roles` (array)
- Allow access if `roles` includes `player`, `trainer`, or `admin`
- This prevents trainers with dual roles from being redirected away

**4. Update TrainerLayout auth guard**

- File: `src/components/trainer/TrainerLayout.tsx`
- Change from `role !== 'trainer'` to `!roles.includes('trainer')` so trainers returning from the player dashboard aren't kicked out
- Also allow `admin`

**5. Add Player option to ProfileSwitcher**

- File: `src/components/ProfileSwitcher.tsx`
- Check if `roles.includes('player')` and `roles.includes('trainer')`
- When in trainer context and user has player role, show "Player Dashboard" linking to `/app/player`
- When in player context and user has trainer role, show "Trainer Dashboard" linking to `/app/trainer`
- Update `showSwitcher` logic to account for this new case

**6. Translation keys**

- Files: `src/i18n/locales/en/trainer.json`, `src/i18n/locales/nl/trainer.json`
- Add keys for the player mode toggle (title, description, enabled/disabled toast messages)
- Files: `src/i18n/locales/en/common.json`, `src/i18n/locales/nl/common.json`
- Verify `playerDashboard` key exists

### Files to create
- `supabase/functions/toggle-player-role/index.ts`

### Files to modify
- `src/pages/TrainerSettings.tsx` -- add Player Mode toggle card
- `src/components/player/PlayerLayout.tsx` -- relax auth guard to use `roles` array
- `src/components/trainer/TrainerLayout.tsx` -- use `roles.includes('trainer')` instead of `role !== 'trainer'`
- `src/components/ProfileSwitcher.tsx` -- add player/trainer switching for dual-role users
- `src/i18n/locales/en/trainer.json` -- add player mode translation keys
- `src/i18n/locales/nl/trainer.json` -- add Dutch player mode translation keys
- `src/i18n/locales/en/common.json` -- verify `playerDashboard` key
- `src/i18n/locales/nl/common.json` -- verify Dutch `playerDashboard` key

