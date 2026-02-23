

# Move "Refer & Earn" to Sidebar Footer

## Overview

Move the "Refer & Earn" menu item from within the main sidebar navigation (SidebarContent) down into the SidebarFooter section in all four sidebars. This places it just above the ProfileSwitcher/ThemeToggle/Logout area, making it persistently visible at the bottom.

## Changes

### 1. TrainerSidebar (`src/components/trainer/TrainerSidebar.tsx`)
- Remove the "Refer & Earn" SidebarMenuItem block (lines 496-502) from SidebarContent
- Add it inside SidebarFooter, as the first item before ProfileSwitcher (before line 535)

### 2. PlayerSidebar (`src/components/player/PlayerSidebar.tsx`)
- Remove the "Refer & Earn" SidebarMenuItem block from inside the SidebarMenu in SidebarContent
- Add it inside SidebarFooter, as the first item before ProfileSwitcher

### 3. AcademySidebar (`src/components/academy/AcademySidebar.tsx`)
- Remove the "Refer & Earn" SidebarMenuItem block (lines 446-452) from SidebarContent
- Add it inside SidebarFooter, as the first item before ProfileSwitcher

### 4. ClubSidebar (`src/components/club/ClubSidebar.tsx`)
- Remove the "Refer & Earn" SidebarMenuItem block (lines 356-362) from SidebarContent
- Add it inside SidebarFooter, as the first item before ProfileSwitcher

## Footer Layout (all sidebars)

The footer will follow this order:
1. **Refer & Earn** button (new position)
2. ProfileSwitcher
3. View Public Profile (where applicable)
4. ThemeToggle + Logout row

The "Refer & Earn" button will render as a full-width ghost button with the Gift icon, matching the existing footer button styling. When collapsed, it shows just the icon.

