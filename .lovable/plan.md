
# Add Logout Button to Select Role Page

## Problem
Users with old or orphaned profiles (accounts that exist but have no role assigned) get stuck on the `/select-role` page with no way to sign out. This is frustrating because they can't start fresh or switch accounts.

## Solution
Add a subtle logout button to the Select Role page that allows users to sign out and return to the auth page.

## Implementation

### File to Modify
- `src/pages/SelectRole.tsx`

### Changes
1. **Import the LogOut icon** from lucide-react (already using other icons from this library)
2. **Import the signOut function** from `@/lib/auth`
3. **Add a handleSignOut function** that calls signOut and navigates to `/auth`
4. **Add a logout button** in the top-right corner of the page (similar pattern used in PlayerLayout and other layouts)

### UI Design
- Position: Fixed in top-right corner or as a subtle link below the main content
- Style: Ghost button with LogOut icon to match the app's design language
- Text: "Sign out" or just icon with tooltip

### Code Changes Summary
```text
1. Add imports: LogOut icon, signOut function
2. Add handleSignOut async function  
3. Add Button in top-right corner:
   - Ghost variant
   - LogOut icon
   - "Sign out" text or tooltip
```

This is a simple, low-risk change that follows the existing patterns in the codebase (e.g., PlayerLayout has the same logout pattern).
