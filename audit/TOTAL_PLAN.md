# PadelTrainer — Combined Pre-Scale Hardening Plan (Claude + Codex)

**Date:** 2026-06-24 · Reconciles two independent audits of the same post-#76 `main`.
- **Claude audit:** `audit/PRESCALE_AUDIT_2026-06-24.md` (9 dimensions, 36 agents, P0/P1 adversarially verified)
- **Codex audit:** 7 findings (pasted by owner), baseline commit `0a5dd185` (#76)

---

## 0. Verdict — both audits agree

Both independently concluded: **the money/security/capacity/RLS *runtime* core is well-built (no P0 there)**, but the app is **NOT READY** to invite more users until the launch-blockers are closed. The two passes are **complementary**, not redundant — each caught real blockers the other missed (verified below).

---

## 1. Verification of Codex's new claims (done, read-only)

| Codex finding | Verified? | Note |
|---|---|---|
| **update-user IDOR** (auth by `trainer_profile_id`, update by `target_user_id`, never matched) | ✅ REAL | `supabase/functions/update-user/index.ts` — auth at L74-118 checks the submitted `trainer_profile_id`; update at L192-196 writes `profiles` by the submitted `target_user_id`. No check the two are the same person → a manager can edit any non-admin user's name/phone/bio/rating/avatar. **Genuine P0 Claude missed.** |
| **npm audit: 21 prod vulns (1 crit/7 high/13 mod)** | ✅ REAL | Confirmed exactly. high: react-router (DoS+CSRF), ws (mem disclosure); 1 critical (transitive). `npm audit fix` available. **Claude never ran npm audit — real gap.** |
| **Stale Lovable AI-gateway in 6 edge fns** | ✅ REAL | `enrich-clubs, scrape-academies, translate-blog-article, generate-blog-article, generate-blog-cover, generate-proposals` all call `ai.gateway.lovable.dev`. |
| **index.html preconnects old project + lovable.app** | ✅ REAL | `index.html:14` → `ppkbhdiiqdusdeatgdft.supabase.co`, `:18` → `padeltrainer.lovable.app`. |

---

## 2. How the two audits relate

### 2a. Agreements (same finding, both rank it a blocker)
- **E2E is not a reliable launch gate** — Codex #3 ≈ Claude P1-3/P1-4. Both: not PR-gated, `rls-health.spec.ts` falls back to the **old prod project** when env is missing. Codex adds: **no mobile project**, `ROUTES.home="/"` redirect breaks tests, stale selectors.
- **Observability incomplete** — Codex #5 ≈ Claude P0-4. Both: edge/cron/payment/email failures are not alerted; Sentry not configured. Claude is sharper that the *daily crons fail silently*; Codex frames the broader monitoring decision.
- **Deployment too manual / drift** — Codex #6 ≈ Claude P0-1 + migration-deploy. Codex wants a deploy **manifest/checklist**; Claude found the specific landmine (below).
- **Old Lovable/Supabase residue** — Codex #4 ≈ Claude P2 (legacy key, import-pipeline). Codex is far more specific on *runtime* refs.
- **Build/perf** — Codex #7 ≈ Claude P2. **Cross-confirmation:** Codex's *"163 network requests on the home page"* is the **same Sanity sponsor-banner request flood** Claude found while investigating "errors across the app." Real and shared.

### 2b. Codex caught — Claude missed (ADD to plan)
- **🔴 P0: update-user IDOR** (verified) — cross-user profile write.
- **🔴 P0/P1: 21 prod dependency vulns** (verified) — Claude didn't run `npm audit`.
- **Mobile Playwright** absent — players are mobile-first.
- **Specific stale runtime refs** — `index.html` preconnects, `sitemap.yml` + `generate-sitemap.ts` old URL, 6 Lovable-gateway fns, e2e old-project fallbacks.
- **browserslist DB 12 months stale.**

### 2c. Claude caught — Codex missed (KEEP prominent)
- **🔴 P0: `config.toml` verify_jwt drift** — 22 fns have no config entry → a full `functions deploy` silently **401s the Stripe webhook + og-image/share previews**. Codex's "manual deploy" finding is adjacent but missed this specific disarm.
- **🔴 P0: the money/security CI rehearsals are only *half-wired*.** Codex praised "`db:rehearse:all` passed" as a positive — but only **8 of 28** rehearsals run; the dangerous ones (recalc-split, capacity-locks, invoice-numbering, stripe-idempotency, booking-tier) are **orphaned (run nowhere)**. *Codex's positive signal is exactly what makes this P0 dangerous.*
- **🔴 P0: Deno edge-fn unit tests run in no CI** (cross-tenant invoice access, auth gates) — different from Codex's Playwright gap; both needed.
- **🔴 P0: `send-campaign-emails`** drops recipients mid-run and reports "sent."
- **🔴 P0: email HTML injection** from the public, unauthed `submit-guest-intake` into another academy's inbox.
- **P1:** `backup-database` truncates to ~1000 rows / 15 of ~71 tables (still returns ok); deferred-billing cron drops per-invoice failures; `recalculate-invoices` unbounded platform-wide SELECT; digest/onboarding 24h overflow; Vite↔Deno duplicated pricing/name logic.

### 2d. Corrections / notes
- **`docs/PHASE5_DEPLOYMENT.md` is stale** — lists `enrich-clubs`/`fetch-location-logos` in the cron (Claude removed them in #73) and omits `generate-cycle-commitment-invoices`. Update it.
- Codex's "rehearsal suite is strong" is true *for what runs*; reconcile with Claude P0-2 (it isn't fully wired into CI).

---

## 3. THE TOTAL PLAN

### P0 — must fix before inviting more users
1. **update-user IDOR** *(Codex)* — resolve target user from the managed `trainer_profile_id` server-side; reject if it ≠ `target_user_id`. Tests: manager-updates-own-trainer ✓; manager-pairs-managed-trainer-with-other-user ✗; non-admin-cannot-touch-admin ✓.
2. **Deploy safety** *(Claude+Codex)* — add `verify_jwt=false` config for the 5 public fns (stripe-subscription-webhook, og-image, rating-og-image, get-public-rating, health-check); **CI guard** failing on any `supabase/functions/*` dir without a config entry; start the **deploy manifest/checklist** (changed fns, pending migrations, dry-run, rollback).
3. **Wire the safety net into CI** *(Claude)* — add the 7 orphaned money/capacity rehearsals to `db:rehearse:all` + a "no orphaned rehearsal" guard; add a `deno test` required job for the edge-fn tests (cross-tenant invoice access, `_shared/auth`, mollie-payment-ready).
4. **`send-campaign-emails`** *(Claude)* — time budget + resumable continuation (mirror `notify-followers`); leave un-sent rows `pending`; mark `sent` only when 0 remain.
5. **Observability + alerting** *(Claude+Codex)* — Slack-on-`!allOk` in both crons + dead-man heartbeat; decide prod error monitoring (Sentry vs PostHog-exceptions) and wire edge/cron/payment/email failures to it.
6. **Email HTML escaping** *(Claude)* — `esc()` every registrant-controlled field in `send-email` templates + the shared confirmation composer.
7. **Dependency vulns** *(Codex)* — `npm audit fix` the auto-fixable set; manually bump react-router-dom/ws and the critical transitive; re-run gates; document any accepted exceptions. Target: clean audit or written exception list.

### P1 — before broader rollout
8. **E2E as a real gate** *(Codex+Claude)* — PR-gated smoke (desktop **+ mobile** iPhone/Pixel) over public marketing/auth/invoice/claim + app shells; **fail-fast on missing env, never fall back to the old project**; fix `ROUTES.home` redirect handling; data-testid selectors; non-destructive.
9. **Purge stale runtime refs** *(Codex)* — remove `index.html` old preconnects; repoint `sitemap.yml` + `generate-sitemap.ts`; classify the 6 Lovable-gateway fns (replace the active ones with env-driven config, or retire); remove e2e old-project fallbacks.
10. **Backups** *(Claude)* — fix truncation (paginate + assert row_count vs count(\*)); enumerate tables from `information_schema`; confirm Supabase PITR is the real DR; write + dry-run a restore runbook.
11. **Batch-job correctness** *(Claude)* — per-failure alerting on `generate-cycle-commitment-invoices` + email crons; bound/scope `recalculate-invoices`; move digest/onboarding to hourly pg_cron.
12. **De-duplicate** *(Claude)* — canonical shared module (or CI diff guard) for the Vite↔Deno pricing/name copies; lift trainer/academy invoice pages into a shared hook.

### P2 — after rollout
- **Perf** *(Codex+Claude)*: refresh browserslist; bundle-split the 578kB chunk; make `BannerZone`/topics fail silent (`retry:false` + catch) to kill the ~163-request home flood; dynamic-import warnings.
- **Test hygiene**: bump vitest `testTimeout` (de-flake the gate); behavioral replay for the 2 grep-only RLS migration policies.
- **Cleanup**: standardize toasts on Sonner; finish mobile tables; pay down eslint suppressions; update `PHASE5_DEPLOYMENT.md`; stale pg_cron audit; rotate the legacy source-project anon key + delete `import-pipeline-data`.

### Quick wins (hours, retire big risk)
- `config.toml` verify_jwt stanzas + CI drift guard (most of P0-2).
- Add 7 rehearsals to `db:rehearse:all` (most of P0-3 — they already pass).
- Slack-on-`!allOk` in both crons (big chunk of P0-5).
- `npm audit fix` + re-run gates (subset of P0-7).
- `npx update-browserslist-db@latest`.
- Delete `index.html` stale preconnects; remove hardcoded prod defaults in e2e specs.
- Bump vitest `testTimeout` to ~15000.

---

## 4. Combined gate to re-run after hardening
```
npm ci && npx tsc --noEmit && npm run lint && npm test && npm run db:rehearse:all && npm run build
npm audit --omit=dev --audit-level=moderate          # target: clean or documented
npm run test:edge   # ✅ WIRED — deno edge-fn UNIT tests (_shared/: auth, mollie-payment-ready, names)
npx playwright test --project=chromium --project=<mobile>   # NEW PR gate (P1 #8 — still open)
```

> **P0 #3 deno-test status (wired 2026-06-24):** the required `edge-tests` CI job runs the
> edge-function **unit** tests (`npm run test:edge` → `deno test supabase/functions/_shared/`). The
> function-dir `index.test.ts` files (backup-database, create-invoice-payment, get-booking-invoice,
> render-page, sitemap, send-priority-claim-invitation, generate-proposals) are **integration tests**:
> they `fetch()` a *deployed* function and need `VITE_SUPABASE_*` secrets, so they are NOT in the unit
> gate. They run locally against a deployed env; 4 currently have assertions that have drifted vs the
> hardened deployed functions (auth error shape now `{error:'unauthorized'}`; SEO content) — reconcile
> them in a **deployed-env smoke workflow** alongside the P1 #8 E2E/mobile gate.

**Bottom line:** Two independent audits converged on the same verdict and, between them, found **8 P0s** (3 security/auth/email, 5 reliability/CI/ops) — none in the runtime money core, all in the *machinery that keeps it safe under change*. Closing them (most are 1–2 days, several are quick wins) makes this a confident GO.
