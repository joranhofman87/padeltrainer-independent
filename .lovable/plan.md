
# Fix Trainer Sidebar Profile Link

## Problem
The "My Profile" link in the trainer sidebar goes to `/trainer/profile`, but this route renders the EditProfile page inside the TrainerLayout, causing layout conflicts. The EditProfile page has its own header and full-screen layout.

## Solution
Change the sidebar link to use the existing legacy route `/profile/edit` that works correctly.

## Changes Required

### 1. Update TrainerSidebar.tsx
Change the NavLink destination from `/trainer/profile` to `/profile/edit`:

```tsx
<NavLink
  to="/profile/edit"
  className="flex items-center gap-2"
  activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
>
```

### 2. Clean up unused route (optional)
Remove the newly added `/trainer/profile` route from DomainRouter.tsx since it's not needed (the legacy `/profile/edit` route serves this purpose).

---

## Why This Approach?

| Option | Pros | Cons |
|--------|------|------|
| **Use `/profile/edit` (recommended)** | Already works; consistent with other pages (Settings, Dashboard) | Leaves the trainer layout temporarily |
| Refactor EditProfile to work in TrainerLayout | Keeps user in layout | Large refactor; EditProfile is shared by players too |

The `/profile/edit` route is already used by:
- TrainerSettings page
- TrainerDashboard setup steps
- PlayerDashboard

Using the same route keeps navigation consistent across the application.
