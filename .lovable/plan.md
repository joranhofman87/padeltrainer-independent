
# Move Refer & Earn to Icon-Only Between Theme Toggle and Logout

## Overview
Remove the full "Refer & Earn" button with label and move it as an icon-only button placed between the ThemeToggle and the Logout button in the footer row, across all 4 sidebars.

## Changes

### 4 Files Modified

**1. `src/components/player/PlayerSidebar.tsx`**
- Remove the standalone Refer & Earn button block (lines 287-298)
- In the ThemeToggle/Logout row, insert a Gift icon-only button between `<ThemeToggle />` and the Logout button

**2. `src/components/trainer/TrainerSidebar.tsx`**
- Remove the standalone Refer & Earn button block (lines 528-539)
- In the ThemeToggle/Logout row (lines 559-571), insert a Gift icon-only button between ThemeToggle and Logout

**3. `src/components/club/ClubSidebar.tsx`**
- Remove the standalone Refer & Earn button block (lines 366-377)
- In the ThemeToggle/Logout row (lines 403-417), insert a Gift icon-only button between ThemeToggle and Logout

**4. `src/components/academy/AcademySidebar.tsx`**
- Remove the standalone Refer & Earn button block (lines 456-467)
- In the ThemeToggle/Logout row (lines 493-507), insert a Gift icon-only button between ThemeToggle and Logout

### Result
The footer row will consistently show: **[ThemeToggle] [Gift icon] [Logout icon]** across all sidebars, in both collapsed and expanded states.
