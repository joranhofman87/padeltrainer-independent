
# Fix: Sidebar Cannot Expand After Minimizing

## Problem

When the sidebar is minimized (collapsed) on the Trainer, Admin, and Academy dashboards, there is no way to expand it again on desktop. This happens because:

1. The collapse button inside the sidebar header is only shown when the sidebar is **expanded** (`!collapsed`)
2. The `SidebarTrigger` in the layout is hidden on desktop (`lg:hidden`) - it only appears on mobile
3. Once collapsed on desktop, users have no visible control to expand the sidebar

## Solution

Following the shadcn sidebar documentation guidelines, the fix is to make the `SidebarTrigger` in the layout **always visible** on desktop when the sidebar is collapsed, while keeping it in the mobile header for mobile users.

## Files to Modify

| File | Change |
|------|--------|
| `src/components/trainer/TrainerLayout.tsx` | Add always-visible trigger on desktop |
| `src/components/admin/AdminLayout.tsx` | Add always-visible trigger on desktop |
| `src/components/academy/AcademyLayout.tsx` | Add always-visible trigger on desktop |

## Implementation Details

For each layout, add a desktop-visible `SidebarTrigger` that appears when the sidebar is collapsed. This can be done by:

1. Adding a sticky header that shows the trigger on desktop when collapsed
2. Or adding the trigger as an overlay button near the collapsed sidebar

The cleanest approach is to update the mobile header to be visible on desktop when the sidebar is collapsed, or add a separate desktop trigger.

### TrainerLayout Changes

```tsx
// Current mobile header (only visible on mobile)
<header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background/80 backdrop-blur-sm px-4 lg:hidden">
  <SidebarTrigger />
  ...
</header>

// Fixed: Always show header when sidebar is collapsed OR on mobile
<header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background/80 backdrop-blur-sm px-4 lg:hidden group-data-[state=collapsed]:flex">
  <SidebarTrigger />
  ...
</header>
```

However, since `group-data-[state=collapsed]` needs to come from the sidebar's parent, we need to use the `useSidebar` hook to check the state conditionally.

### Updated Approach

Import `useSidebar` in each layout and conditionally show the header:

```tsx
const { state } = useSidebar();
const isCollapsed = state === "collapsed";

// Show header on mobile OR when sidebar is collapsed on desktop
<header className={cn(
  "sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background/80 backdrop-blur-sm px-4",
  !isCollapsed && "lg:hidden" // Only hide on desktop if expanded
)}>
  <SidebarTrigger />
  ...
</header>
```

Since `useSidebar` must be used within `SidebarProvider`, we need to extract the main content area into a child component, or restructure slightly.

### Alternative: Add desktop trigger in sidebar header when collapsed

Add a trigger button that appears when collapsed inside each sidebar:

```tsx
// In SidebarHeader, show expand button when collapsed
{collapsed && (
  <Button
    variant="ghost"
    size="icon"
    className="h-7 w-7"
    onClick={toggleSidebar}
  >
    <PanelLeft className="h-4 w-4" />
  </Button>
)}
```

This is the simpler fix that keeps everything self-contained within the sidebar component.

## Recommended Fix

Add the expand button to each sidebar's header when collapsed:

### TrainerSidebar (lines 171-179)
```tsx
{!collapsed && (
  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={toggleSidebar}>
    <PanelLeftClose className="h-4 w-4" />
  </Button>
)}
{collapsed && (
  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={toggleSidebar}>
    <PanelLeft className="h-4 w-4" />
  </Button>
)}
```

### AdminSidebar (lines 106-115)
Same pattern as above.

### AcademySidebar (lines 158-167)
Same pattern as above.

## Visual Result

**Expanded Sidebar:**
```
+----------------------------------+
| [Avatar] Trainer Name    [◀]    |  <- PanelLeftClose to collapse
+----------------------------------+
```

**Collapsed Sidebar:**
```
+------+
| [▶] |  <- PanelLeft to expand
| [👤] |
+------+
```

## Summary

Add the `PanelLeft` expand button to show when `collapsed` is true in all three sidebars:
- `TrainerSidebar.tsx` 
- `AdminSidebar.tsx`
- `AcademySidebar.tsx`

This ensures users can always toggle the sidebar state regardless of whether it's currently expanded or collapsed.
