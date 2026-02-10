

## Move "Get Started" to Bottom of Sidebar

### What changes
The "Get Started" (Rocket icon) navigation item in the **Trainer sidebar** will be moved from its current position at the very top of the menu (above "My Profile") to the very bottom (below the "Business" collapsible group).

This ensures that all other navigation items (Profile, Dashboard, Players, Schedule, Registrations, Clubs, Business) remain in fixed positions regardless of whether the Get Started item is visible or not.

### Scope
Only the **Trainer sidebar** is affected -- the Academy and Player sidebars do not have a "Get Started" item.

### Technical details

**File: `src/components/trainer/TrainerSidebar.tsx`**

- Remove the "Get Started" `SidebarMenuItem` block from lines 225-244 (currently the first item in the menu)
- Re-insert the same block after the Business `Collapsible` group (after line 499), just before the closing `</SidebarMenu>` tag
- No logic changes -- just moving the JSX block down

