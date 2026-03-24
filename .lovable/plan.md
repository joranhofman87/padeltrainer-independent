

# Fix: Admin Academies List Truncated at 1,000 Rows

## Problem
There are **3,712 academies** in the database, but the `useAdminAcademies` query in `src/hooks/useAdminData.ts` has no explicit limit. Supabase defaults to returning only **1,000 rows**. Since results are ordered by `created_at DESC`, only the newest 1,000 academies appear. RL Performance Academy (and ~2,700 others) are invisible in the admin panel.

## Solution

### Option A: Server-side search (recommended)
Fetching all 3,712 rows client-side is wasteful and will only get worse. Instead, implement server-side filtering:

**File: `src/hooks/useAdminData.ts`** — `useAdminAcademies`
- Accept `searchQuery` and `statusFilter` as parameters
- Apply `.ilike()` filters on `name`, `contact_email`, `slug` server-side
- Apply status filters server-side
- Keep `.limit(100)` with pagination support
- Add `keepPreviousData: true` for smooth UX

**File: `src/pages/admin/AdminAcademies.tsx`**
- Debounce the search input (300ms)
- Pass `searchQuery` and `statusFilter` to `useAdminAcademies`
- Remove client-side `filteredAcademies` logic (now handled server-side)
- Add simple pagination (Next/Previous buttons)

### What changes
- `useAdminAcademies(searchQuery, statusFilter)` — query with server-side filters, limit 100, with pagination
- `AdminAcademies.tsx` — debounced search, pass filters to hook, add pagination controls
- Search will now find any academy across all 3,712+ records

### Files
- `src/hooks/useAdminData.ts` — Refactor `useAdminAcademies` to accept filters and paginate
- `src/pages/admin/AdminAcademies.tsx` — Wire up debounced search and pagination UI

