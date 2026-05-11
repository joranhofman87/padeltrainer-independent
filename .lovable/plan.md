## Address audit items 7–10

Four independent fixes, ordered by risk.

### 7. Fix broken admin-bypass check in `impersonate-user`

`supabase/functions/impersonate-user/index.ts` queries `user_roles` for the **target** user with `.single()`, which throws when the target has more than one role row (multi-role users are common: trainer + player, etc.). When it throws, `targetRoleData` is `undefined` and the admin-impersonation block is skipped — meaning an admin who *also* has another role can still be impersonated.

**Fix:** mirror the (already-correct) caller check directly above:

```ts
const { data: targetAdminRows } = await supabaseAdmin
  .from("user_roles")
  .select("role")
  .eq("user_id", target_user_id)
  .eq("role", "admin")
  .limit(1);

if (targetAdminRows && targetAdminRows.length > 0) { ...block... }
```

### 8. Verify anonymous read surface on `profiles` and `profile_videos`

No code change yet — just confirm the live RLS state. I'll run two reads via `supabase--read_query` simulating an anonymous JWT (or via `curl` with the anon key) against both tables and report which columns/rows come back. If anything sensitive (email, phone, knltb_number, location) leaks, file a follow-up migration that:
- replaces direct anon SELECT on `profiles` with `SELECT ... USING (false)` and routes public callers through the existing `profiles_public` view, and
- audits `profile_videos` (likely fine — intentionally public).

I'll deliver the audit report to you in chat; migration only happens if leakage is found and only after you approve it.

### 9. Lock CORS on sensitive edge functions to app origins

Today every function returns `Access-Control-Allow-Origin: *`. For admin/privileged functions that's unnecessarily permissive.

**Plan:**
- Add a small helper `supabase/functions/_shared/cors.ts` exporting `buildCorsHeaders(req, { restricted?: boolean })`. When `restricted: true`, it echoes the request `Origin` only if it matches a whitelist (`https://padeltrainer.lovable.app`, `https://*.lovable.app` preview, custom domain if any), else falls back to the first whitelisted origin. Public functions keep `*`.
- Apply `restricted: true` to the admin/privileged functions: `impersonate-user`, `admin-reset-password`, `admin-*`, plus the 12 functions hardened in the previous round (`generate-blog-article`, `translate-blog-article`, `process-blog-queue`, `auto-create-invoice`, `backfill-invoices`, `split-invoice`, `enrich-clubs`, `geocode-locations`, `fetch-location-logos`, `rls-smoke-test`).
- Public functions (Mollie webhooks, public lookups, sitemap, render-page, etc.) keep `*`.

Out of scope: changing `verify_jwt` (already addressed via in-code guards).

### 10. Re-enable TypeScript strict null checks (wave 1)

Full strict mode would surface thousands of errors across 192 files using `any`. We'll do this in waves, starting with `strictNullChecks` only as the audit recommends.

**Wave 1 plan:**
- Flip `strictNullChecks: true` (and only that) in `tsconfig.json` and `tsconfig.app.json`.
- Run `tsc --noEmit` to enumerate errors.
- Fix the resulting errors file-by-file: most will be `obj.foo` where `foo` is `T | null/undefined` — adding `?.`, nullish guards, or narrowing with early returns.
- Keep `noImplicitAny: false`, `strict: false`, `noUnusedLocals: false` for now. Future waves (separate tasks) tackle `noImplicitAny`, then full `strict`.

If error count is huge (>200 files), I'll pause and report numbers before mass-editing.

### Order of execution
1. #7 (one-line edge function fix, deploy).
2. #9 (CORS helper + apply to admin functions, deploy).
3. #8 (verification scan, no edits unless leakage found).
4. #10 (strictNullChecks wave — likely the longest; report scope before bulk fixes).