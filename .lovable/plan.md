

## Sort Admin Tables by Newest First

### What
Change the default sort order on the Academies, Trainers, and Users admin tables so they sort by creation date (newest first) by default, making it easy to spot new sign-ups.

### Changes

**1. `src/pages/admin/AdminAcademies.tsx` (line 126)**
- Change default sort key from `"name"` to `"created_at"` and add `"desc"` direction

**2. `src/pages/admin/AdminTrainers.tsx` (line 132)**
- Change default sort key from `"_name"` to `"created_at"` and add `"desc"` direction

**3. `src/pages/admin/AdminUsers.tsx`** -- already sorted by `"created_at"` descending, no change needed.

All three tables already have `created_at` as a sortable column, so clicking the header to re-sort will continue to work as before. The only difference is the initial load order.
