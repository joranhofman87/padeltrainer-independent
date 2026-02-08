
# Add Profile Visibility Toggle to Trainer Profile Page

## What changes
Add a visibility toggle card at the top of the Edit Profile page (for trainers only) that lets them publish/unpublish their profile. When a trainer without a paid subscription (or paid academy membership) tries to toggle visibility on, show an upgrade banner instead.

## UI Design

### Toggle Card (top of form, trainers only)
A card with an Eye/EyeOff icon, title "Marketplace visibility", current status text, and a Switch toggle -- similar to the existing one in TrainerSettings but embedded in the profile edit page.

### Upgrade Banner (shown as a Dialog when unpaid trainer tries to publish)
- **Title**: Publish your profile and start getting booking requests
- **Body**: Public visibility is available on the Pro plan (or via a paid academy). Upgrade to get listed in the trainer marketplace and let players request lessons.
- **Primary CTA**: "Upgrade to publish" -- navigates to `/trainer/subscription`
- **Secondary CTA**: "See what's included" -- navigates to pricing page
- **Small text**: You can keep your profile in preview mode until you're ready.

## Logic
- Use the existing `canBeVisible()` from `src/lib/subscription.ts` plus a new check: if the trainer is part of a paid academy (check `academy_trainers` table for an active academy link), they can also publish
- When `canBeVisible()` returns false AND no paid academy membership, show the upgrade dialog instead of toggling

## Technical Details

### File: `src/pages/EditProfile.tsx`
1. Import `Switch`, `useAuth` subscription data, `canBeVisible`, `Dialog` components, and visibility icons
2. Add state: `isPublic`, `showUpgradeDialog`, `updatingVisibility`
3. Fetch `is_public` from trainer profile (add to existing query on line 191)
4. Add a visibility card before the Basic Info card (only for `role === 'trainer'`)
5. Add upgrade Dialog component at the bottom
6. Handle toggle: if paid or in trial or in paid academy, update `trainer_profiles.is_public`; otherwise open upgrade dialog

### File: `src/lib/academy.ts`
- Add/export a helper `isTrainerInPaidAcademy(trainerId)` that checks `academy_trainers` joined with `academy_profiles` for `subscription_status = 'active'`

### Translation keys
- Add relevant keys to `trainer.json` (EN + NL) under a `profileVisibility` namespace
