## Goal

Lighten the academy sidebar by grouping **Profile**, **Locations**, **Trainers**, and the existing **Settings** entry into a single collapsible **Settings** section.

## Resulting nav order

1. Dashboard
2. Players
3. Schedule
4. Registrations
5. Invoices
6. **Settings** (collapsible)
   - Profile
   - Locations
   - Trainers
   - General (current `/app/academy/settings`)

Top-level Profile, Locations, Trainers, and Settings entries are removed (they live inside the new group instead).

## UX details

- Use the existing shadcn `Collapsible` + `SidebarMenuSub` / `SidebarMenuSubItem` pattern already used in `TrainerSidebar`, `ClubSidebar`, and `AdminSidebar` — no new primitives.
- The Settings group auto-opens when the active route is `/app/academy/profile`, `/app/academy/locations`, `/app/academy/trainers`, or `/app/academy/settings`.
- Chevron toggles on click; persists open/closed via local component state for the session.
- **Collapsed sidebar:** the Settings parent shows the gear icon with a tooltip; clicking it expands the sidebar and opens the group (matching how other role sidebars handle this).
- Sub-items each keep their own icon (`User`, `MapPin`, `GraduationCap`, `Settings`) so they stay scannable.
- Active sub-item gets the same `bg-sidebar-accent` highlight currently used.

## Out of scope

- Trainer / Club / Player / Admin sidebars (the request is academy-specific; "Trainers" sub-item only exists in academy).
- Renaming any pages or moving routes — URLs stay the same.
- Footer (ProfileSwitcher, theme, subscription, logout) stays unchanged.

## Files to touch

- `src/components/academy/AcademySidebar.tsx`
