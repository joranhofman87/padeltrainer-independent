

## Separate Trainers & Players in Academy Sidebar

### What's changing

The "Team" collapsible group in the academy sidebar currently groups Trainers and Players together. These will be split into two standalone top-level menu items, removing the collapsible wrapper.

### Changes

**`src/components/academy/AcademySidebar.tsx`**

- Remove the `teamOpen` state and the `Collapsible` wrapper around Trainers and Players (lines 68-72, 228-277)
- Replace with two standalone `SidebarMenuItem` entries (same pattern as Dashboard, Profile, and Locations):
  - **Trainers** -- icon: `GraduationCap`, path: `/app/academy/trainers`
  - **Players** -- icon: `Users`, path: `/app/academy/players`
- Place them between Profile and the Schedule group, maintaining the current visual order
- Remove the unused `Users` import conflict (it's used for the Team group icon) and use `GraduationCap` for Trainers and `Users` for Players

### Result

The sidebar order becomes:
1. Dashboard
2. Profile
3. Trainers (standalone)
4. Players (standalone)
5. Schedule (collapsible)
6. Registration (collapsible)
7. Locations
8. Business (collapsible)

