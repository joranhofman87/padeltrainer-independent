

# Slim Down Trainer Profile Hero & Reorganize Actions

## Problem
The trainer hero banner is too noisy with experience years, verified badge, social links, book lesson button, contact, and share profile all crammed in. This pushes the important open slots content below the fold.

## Changes

### 1. `src/pages/TrainerProfile.tsx` — Hero card cleanup

**Remove from ProfileHeroCard props:**
- `experienceYears` — stop passing it (already in quick stats)
- `isVerified` — stop passing it
- `socialLinks` — stop passing it

**Remove from children (lines 484-551):**
- Book Lesson button (line 485-488)
- Contact button (line 512-515)
- Share Profile dropdown (line 516-550)

**Keep in hero children:**
- Follow button only

**Add to ProfileSocialCard in sidebar (line 819-824):**
- Share Profile dropdown and Contact button — add these inside or right after the "Follow Me" card

**Add to quickStats array (line 331-335):**
- Add verified status as a stat entry (it's already there at line 333 — keep it)

### 2. `src/components/profiles/ProfileSidebar.tsx` — Enhance ProfileSocialCard

Add optional props for:
- `shareActions` — render share/contact buttons within the Follow Me card
- Or: add `children` slot to ProfileSocialCard so TrainerProfile can inject the share dropdown and contact button

### 3. `src/pages/TrainerProfile.tsx` — Wire share & contact into sidebar

Pass the share dropdown and contact button as children to ProfileSocialCard in the sidebar.

## Summary of moves
| Element | From | To |
|---------|------|----|
| Experience years | Hero banner | Already in Quick Stats (remove from hero) |
| Verified badge | Hero banner | Already in Quick Stats (remove from hero) |
| Social links | Hero banner | Already in sidebar Follow Me card (remove from hero) |
| Book Lesson button | Hero banner | Remove entirely (open slots serve this purpose) |
| Contact button | Hero banner | Sidebar Follow Me card |
| Share Profile | Hero banner | Sidebar Follow Me card |
| Follow button | Hero banner | Keep in hero |

## Files
- `src/pages/TrainerProfile.tsx` — Remove props & children from hero, move share/contact to sidebar
- `src/components/profiles/ProfileSidebar.tsx` — Add children slot to ProfileSocialCard

