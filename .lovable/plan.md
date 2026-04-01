

# Add Guest Players Overview & Stats to Admin Panel

## Summary
Create a new **Guest Players** admin page showing all registrations (from `guest_players` table), and add registration/conversion stats to the admin dashboard.

## Changes

### 1. New page: `src/pages/admin/AdminGuestPlayers.tsx`
A searchable, filterable table of all guest players with columns:
- **Name** | **Email** | **Phone** | **Rating** | **Trainer** (via `trainer_id` → `trainer_profiles`) | **Academy** (via `academy_profile_id`) | **Source** | **Status** (converted if `linked_profile_id` is set, trained if `has_trained`) | **Created**

**Filters:**
- Search by name/email
- Filter by status: All / Not converted / Converted (has `linked_profile_id`)
- Filter by source: all / `manual_registration` / `intake` / etc.

Uses service-role via RPC or direct query (admin RLS policy already covers this via `is_admin`).

### 2. Route & Sidebar
- **`DomainRouter.tsx`**: Add route `<Route path="guest-players" element={<AdminGuestPlayers />} />`
- **`AdminSidebar.tsx`**: Add "Registrations" item (with `UserPlus` icon) under main nav, linking to `/app/admin/guest-players`

### 3. Dashboard stats — `get-admin-stats/index.ts`
Add guest player metrics to the edge function response:
```
registrations: {
  totalGuests: number,
  convertedToAccount: number,   // linked_profile_id IS NOT NULL
  hasTrained: number,           // has_trained = true
  thisMonth: number,
  lastMonth: number,
}
```

### 4. Dashboard UI — `AdminStatsCards.tsx`
Add a new stats card showing:
- **Total Registrations** (guest players count)
- **Converted** (linked to real account)
- **Monthly trend** (this month vs last month)

## Files Changed

| File | Change |
|------|--------|
| `src/pages/admin/AdminGuestPlayers.tsx` | New page — guest players table with search/filters |
| `src/components/DomainRouter.tsx` | Add route for guest-players |
| `src/components/admin/AdminSidebar.tsx` | Add "Registrations" nav item |
| `supabase/functions/get-admin-stats/index.ts` | Add registration stats queries |
| `src/lib/admin.ts` | Extend `AdminStats` type with registrations |
| `src/components/admin/AdminStatsCards.tsx` | Add registrations stats card |

