

# Fix Academy Directory Visibility and Profile Link

## Problems Found

1. **Academy not showing in directory**: Your academy "Jorans academy" has `is_public = false` in the database, even though you set `subscription_status` to `active` via the admin panel. The public view (`academy_profiles_public`) filters on `is_public = true`, so it's excluded from the directory listing.

2. **"View profile" link doesn't work**: The dashboard opens the public profile page, which also queries the `academy_profiles_public` view. Since `is_public` is false, the page finds no data and shows nothing/error.

**Root cause**: Setting subscription to "active" in the admin panel does not automatically flip `is_public` to `true`. These are managed as separate flags.

## Fix

### 1. Data fix — set `is_public = true` for "Jorans academy"
Update the database record directly.

### 2. Code fix — Use `getMarketingUrl` for the "View profile" link
The dashboard currently uses `window.open(\`/${lang}/academies/${slug}\`)` which constructs a path manually. It should use `getMarketingUrl` (from `@/lib/domains`) to generate the correct full URL, consistent with how other share links work (e.g., `CycleCard`).

| File | Change |
|---|---|
| `src/pages/academy/AcademyDashboard.tsx` (line ~308-311) | Import `getMarketingUrl` and use it: `getMarketingUrl(\`academies/${slug}\`, lang)` |

### 3. Code fix — Dashboard "View profile" should work even for non-public academies
The profile link is for the academy owner to preview their own page. It should work regardless of `is_public` status. Update `getAcademyBySlug` in `src/lib/academy.ts` to also allow access when the user is an academy manager, OR provide a separate preview function that queries the base `academy_profiles` table instead of the public view.

**Simpler approach**: Add an optional `preview` query param. When present, `AcademyPublicProfile` fetches from `academy_profiles` directly (with auth check) instead of the public view. The dashboard link adds `?preview=true`.

