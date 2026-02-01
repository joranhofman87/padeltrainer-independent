
# Add "My Profile" to Trainer Sidebar Menu

## Overview
Add a "My Profile" menu item at the top of the trainer dashboard sidebar, right after the user info header and before the Dashboard link.

## Change Summary

| File | Action | Description |
|------|--------|-------------|
| `src/components/trainer/TrainerSidebar.tsx` | Modify | Add "My Profile" menu item after header |
| `src/i18n/locales/en/trainer.json` | Modify | Add `nav.myProfile` translation key |
| `src/i18n/locales/nl/trainer.json` | Modify | Add `nav.myProfile` translation key |

## Implementation Details

### 1. TrainerSidebar.tsx Changes

Add the `User` icon import from lucide-react (already available in the file), then add a new menu item right before the Dashboard item:

```tsx
{/* My Profile - First item after header */}
<SidebarMenuItem>
  <SidebarMenuButton asChild tooltip={t("nav.myProfile")}>
    <NavLink
      to="/trainer/profile"
      className="flex items-center gap-2"
      activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
    >
      <User className="h-4 w-4" />
      {!collapsed && <span>{t("nav.myProfile")}</span>}
    </NavLink>
  </SidebarMenuButton>
</SidebarMenuItem>

{/* Dashboard */}
<SidebarMenuItem>
  ...
</SidebarMenuItem>
```

### 2. i18n Updates

**English (`en/trainer.json`):**
```json
{
  "nav": {
    "myProfile": "My Profile",
    ...
  }
}
```

**Dutch (`nl/trainer.json`):**
```json
{
  "nav": {
    "myProfile": "Mijn Profiel",
    ...
  }
}
```

## Sidebar Menu Order After Change

```text
+----------------------------------+
| [Avatar] Trainer Name            |
| 🟠 Trainer Badge                 |
+----------------------------------+
| 👤 My Profile           ← NEW    |
| 📊 Dashboard                     |
+----------------------------------+
| 👥 Players ▼                     |
| 📅 Schedule ▼                    |
| 📋 Registration ▼                |
| 🏠 My Clubs ▼                    |
| 💼 Business ▼                    |
+----------------------------------+
```

## Route Mapping

| Menu Item | Route | Icon |
|-----------|-------|------|
| My Profile | `/trainer/profile` | User |

This route already exists in `DomainRouter.tsx` and maps to the `EditProfile` component.
