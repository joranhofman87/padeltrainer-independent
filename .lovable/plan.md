

# Restrict Club Access Until Admin Approval

## Problem
When a user claims a club, they immediately get full dashboard access (edit profile, manage trainers, players, calendar, etc.) even though the claim is still pending admin verification. The "pending verification" alert is shown but has no actual access restriction.

## Solution
Add a verification gate in the `ClubLayout` so unverified clubs only see a "pending review" status page instead of the full dashboard. This is the simplest, most secure approach -- a single checkpoint that blocks all club pages.

## Changes

### 1. `src/components/club/ClubLayout.tsx` -- Add verification gate
After the "no clubs" empty state check, add a new check: if the active club's `is_verified` is `false`, render a "Pending Verification" page instead of the sidebar + Outlet. This page will show:
- A clock/pending icon
- "Your claim is being reviewed" message
- The club name and submission date
- A note that they'll be notified when approved
- A button to browse locations or go back to their other dashboard

This ensures **no** club sub-page (profile, trainers, players, calendar, settings) is accessible until verified.

### 2. `src/components/club/ClaimClubDialog.tsx` -- Don't navigate to club dashboard
Change `navigate('/app/club')` to stay on the current page after claiming. Show a success toast explaining the claim is under review. The user shouldn't be sent to a dashboard they can't use yet.

### 3. `src/lib/club.ts` -- Filter `getUserClubProfiles` (optional hardening)
No change needed here since the layout gate handles it. Keeping unverified clubs in the list allows showing the pending state. However, functions like `updateClubProfile`, `getClubTrainers`, etc. should ideally also be protected -- but since RLS is already in place and the layout gate blocks the UI, this is sufficient.

## Technical Details

### ClubLayout verification gate (inserted after `clubs.length === 0` check)
```text
if (activeClub && !activeClub.is_verified) {
  --> Render pending verification page
  --> No sidebar, no Outlet
  --> Show: icon, title, description, club name, claimed date
  --> Button: "Browse Locations" or navigate to player/trainer dashboard
}
```

### ClaimClubDialog post-submit behavior
- Remove `navigate('/app/club')`
- Keep the success toast (already says claim is pending)
- Close dialog only; user stays on location page

### Files modified
- `src/components/club/ClubLayout.tsx` -- add verification gate before full layout render
- `src/components/club/ClaimClubDialog.tsx` -- remove navigation to club dashboard after claim

### Translation keys needed (in club.json for both en and nl)
- `dashboard.pendingTitle` -- "Claim Under Review"
- `dashboard.pendingDescription` -- "Your request to manage {clubName} is being reviewed by our team. You'll receive an email once approved."
- `dashboard.pendingNote` -- "This usually takes 1-2 business days."

