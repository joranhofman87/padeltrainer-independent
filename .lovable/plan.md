

# Fix Sidebar Icons Appearing Outside When Collapsed

## Problem
When the sidebar is in collapsed state (icon-only mode, ~48px wide), the avatar icon and toggle button appear outside the sidebar bounds. This affects both the Admin and Trainer sidebars.

**Root Cause:** The sidebar header uses `justify-between` layout, which spreads the avatar and toggle button to opposite edges. In collapsed mode, the sidebar is only 48px wide, but the combined width of avatar (32px) + button (28px) + padding exceeds this, causing overflow.

## Solution
Restructure the sidebar header to:
1. Stack elements vertically when collapsed (avatar on top, toggle below)
2. Use `flex-col` layout when collapsed instead of horizontal `justify-between`
3. Hide the toggle button in collapsed mode since users can click anywhere on the sidebar header or use the rail to expand

## Files to Change

| File | Change |
|------|--------|
| `src/components/admin/AdminSidebar.tsx` | Fix header layout for collapsed state |
| `src/components/trainer/TrainerSidebar.tsx` | Fix header layout for collapsed state |

## Implementation Details

### Change 1: AdminSidebar Header (Lines 92-115)

Current structure:
```tsx
<div className="flex items-center justify-between px-2 py-2">
  <div className="flex items-center gap-2">
    <div className="...icon...">...</div>
    {!collapsed && <span>Admin Panel</span>}
  </div>
  <Button onClick={toggleSidebar}>...</Button>  {/* Always visible */}
</div>
```

Fixed structure:
```tsx
<div className={cn(
  "flex px-2 py-2",
  collapsed ? "flex-col items-center gap-2" : "items-center justify-between"
)}>
  <div className="flex items-center gap-2">
    <div className="...icon...">...</div>
    {!collapsed && <span>Admin Panel</span>}
  </div>
  {!collapsed && (
    <Button onClick={toggleSidebar}>...</Button>
  )}
</div>
```

Key changes:
- Use `flex-col items-center` when collapsed
- Hide toggle button when collapsed (users can click the sidebar header or use keyboard shortcut `Cmd+B`)
- Keep horizontal `justify-between` layout when expanded

### Change 2: TrainerSidebar Header (Lines 141-175)

Same pattern:
```tsx
<div className={cn(
  "flex px-2 py-2",
  collapsed ? "flex-col items-center gap-2" : "items-center justify-between"
)}>
  <div className={cn(
    "flex items-center",
    collapsed ? "justify-center" : "gap-2"
  )}>
    <Avatar className="h-8 w-8">...</Avatar>
    {!collapsed && (
      <div className="flex flex-col">
        <span>...</span>
        <Badge>...</Badge>
      </div>
    )}
  </div>
  {!collapsed && (
    <Button onClick={toggleSidebar}>...</Button>
  )}
</div>
```

## Visual Comparison

| State | Current Layout | Fixed Layout |
|-------|----------------|--------------|
| Expanded | `[Avatar Name] [Toggle]` | `[Avatar Name] [Toggle]` (same) |
| Collapsed | `[Avatar][Toggle]` (overflow!) | `[Avatar]` (centered, fits) |

## Alternative: Keep Toggle Button Visible

If we want to keep the toggle button visible when collapsed, we could stack vertically:

```tsx
{collapsed ? (
  <div className="flex flex-col items-center gap-2">
    <Avatar />
    <Button onClick={toggleSidebar} />
  </div>
) : (
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-2">
      <Avatar />
      <span>Name</span>
    </div>
    <Button onClick={toggleSidebar} />
  </div>
)}
```

However, hiding the toggle is cleaner since:
- Users can click anywhere on the sidebar to expand
- The keyboard shortcut `Cmd+B` works
- It matches common sidebar patterns (VS Code, Notion, etc.)

## Additional Fix: SidebarFooter

The footer also has a similar layout issue with `justify-between`. When collapsed, we should stack the ThemeToggle and Logout button vertically:

**AdminSidebar Footer (Lines 258-272):**
```tsx
<div className={cn(
  "flex p-2",
  collapsed ? "flex-col items-center gap-2" : "items-center justify-between"
)}>
  <ThemeToggle />
  <Button variant="ghost" size={collapsed ? "icon" : "sm"} onClick={handleLogout}>
    <LogOut className="h-4 w-4" />
    {!collapsed && <span className="ml-2">Logout</span>}
  </Button>
</div>
```

**TrainerSidebar Footer** needs the same treatment.

## Result

After the fix:
- Collapsed sidebar shows only the centered avatar/icon
- All elements fit within the 48px collapsed width
- Toggle functionality preserved via click-anywhere or keyboard shortcut
- Footer actions stack vertically when collapsed

