

## Root cause

This is not just “slow” — the workflow is hitting a real bug.

From the current code and your screenshot:

1. **The workflow is looping past the last location sitemap page**
   - `sitemap-locations-6.xml` has only **5 URLs**
   - `page=7` returns **0 URLs**
   - but the shell check fails with:
     `integer expression expected`

2. **Why that happens**
   - In `.github/workflows/sitemap.yml` you have:
     ```bash
     URL_COUNT=$(grep -c '<url>' "$FILE" || echo 0)
     ```
   - When `grep -c` finds zero matches, it prints `0` **and** exits non-zero.
   - Then `|| echo 0` adds a **second** `0`.
   - So `URL_COUNT` becomes effectively `"0\n0"`, and:
     ```bash
     [ "$URL_COUNT" -eq 0 ]
     ```
     throws the error instead of breaking the loop.

3. **Why it also feels very slow**
   - In `supabase/functions/sitemap/index.ts`, `type=locations` fetches **all active locations on every page request**, then slices in memory.
   - So page 1, 2, 3, 4, 5, 6 each repeat the full fetch.
   - That is the main performance cost.

---

## Plan

### 1. Fix the workflow loop bug
Update `.github/workflows/sitemap.yml` so zero-URL pages are handled correctly and the loop stops cleanly.

Preferred approach:
- stop using the “keep requesting until empty” pattern
- parse `public/sitemap.xml` after the index fetch
- determine the exact number of `sitemap-locations-N.xml` and `sitemap-cities-N.xml` files
- fetch only those pages

This is more robust than probing page 7, 8, 9, etc.

### 2. Optimize the location sitemap endpoint
Update `supabase/functions/sitemap/index.ts` so `type=locations`:
- queries only the current page with `.range(...)`
- keeps stable ordering by `slug`
- does **not** fetch all locations for every request

This should remove the repeated full-table fetch on every page.

### 3. Mirror the same logic in the local generator
Update `scripts/generate-sitemap.ts` to match the GitHub workflow behavior:
- use the index to determine exact page counts
- stop relying on “request until empty”

This keeps local generation and CI consistent.

### 4. Keep one defensive fallback
Also harden the workflow shell logic with:
- `set -euo pipefail`
- safe zero handling for `URL_COUNT`

So even if a file is malformed or empty, the workflow fails clearly instead of silently looping.

---

## Expected outcome

After these changes:
- the workflow will stop at the real last page instead of looping forever
- location sitemap generation should become much faster
- errors will fail visibly instead of hanging for 7–14 minutes

---

## File summary

| File | Change |
|---|---|
| `.github/workflows/sitemap.yml` | Fix loop logic; fetch exact page counts from sitemap index; harden shell error handling |
| `supabase/functions/sitemap/index.ts` | Make `type=locations` paginate at query level instead of fetching all rows each time |
| `scripts/generate-sitemap.ts` | Mirror the same exact-page-count logic used in CI |

