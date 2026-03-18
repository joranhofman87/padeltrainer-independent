

## Import Data Pipeline Edge Function (Temporary)

### Overview
Create a temporary admin-only edge function `import-pipeline-data` that pulls locations and academies from the data pipeline project. **This feature is designed to be removed after the import is complete.**

### Edge Function: `supabase/functions/import-pipeline-data/index.ts`

**Auth**: Admin-only via `getClaims()` + `is_admin()` check.

**Flow**:
1. Accept `{ dry_run?: boolean }` body
2. **Phase 1 — Locations**: Paginate source API (`resource: "locations"`, limit 200). For each record: skip if `city` is null/empty, skip if `slug` exists in `locations`, map fields and INSERT
3. **Phase 2 — Academies**: Paginate source API (`resource: "academies"`, limit 200). Skip if `slug` exists in `academy_profiles`, map fields (including `social_links.facebook` → `social_facebook`, etc.), INSERT
4. **Phase 3 — Link**: For each academy with `_linked_club_id`, match to location via source internal ID, INSERT into `academy_locations` (skip duplicates)
5. Return summary: `{ inserted_locations, inserted_academies, linked, skipped_duplicate, skipped_invalid, total_source, dry_run }`

**Source API auth**: Hardcoded anon key for the pipeline project.

**Safety**: INSERT-only, no UPDATE/DELETE, dedup by slug, skip invalid records, dry_run mode.

### Admin helper in `src/lib/admin.ts`
Add `importPipelineData(options)` function to invoke the edge function.

### Cleanup plan
After successful import, remove:
- `supabase/functions/import-pipeline-data/` directory
- `[functions.import-pipeline-data]` from `supabase/config.toml`
- `importPipelineData()` from `src/lib/admin.ts`

### Files to create/modify
- **Create** `supabase/functions/import-pipeline-data/index.ts`
- **Modify** `supabase/config.toml` — add function entry
- **Modify** `src/lib/admin.ts` — add helper function

