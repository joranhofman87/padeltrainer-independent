# Dependency security pass — 2026-06-28

Addresses the independent audit finding **P1-2** (`npm audit --omit=dev` red: 17 prod-scope advisories).
No product code logic changed; this is `package.json` (2 direct-dep bumps + 4 `overrides`) + the
regenerated `package-lock.json` + one new sanitization test.

## Fixed — every runtime/browser-shipped vulnerability

| Package | Before | After | Path / why it matters |
|---|---|---|---|
| `dompurify` | 3.4.7 | **3.4.8** | direct; runtime sanitizer behind `SafeHtml` (still flagged — see residuals) |
| `posthog-js` | 1.342.1 | **1.381.0** | direct; the bump **drops the vulnerable `@opentelemetry/*` chain** entirely (8 advisories gone) |
| `ws` | 8.19.0 | **8.21.0** (override) | transitive via `@supabase/supabase-js` realtime (runtime) — uninit-memory / DoS |
| `lodash` | 4.17.21 | **4.18.1** (override) | transitive via `recharts` (runtime) |
| `picomatch` | 2.3.1 | **2.3.2** (override) | transitive; ReDoS — single-major in tree, safe to pin |
| `yaml` | 2.6.0 | **2.9.0** (override) | transitive; stack-overflow — single-major in tree, safe to pin |

`npm audit --omit=dev`: **17 → 4**. Verified: `tsc` 0, `eslint` 0, full `vitest` 1853 pass (incl. the new
`src/test/safeHtml.test.tsx`), `build` OK.

## Residuals (documented, accepted) — 4 remaining, none browser-shipped at runtime

1. **`dompurify` (moderate, DIRECT)** — `3.4.8` is the **latest published** version; the three flagged
   advisories (Trusted-Types output mode survives `clearConfig`; `SAFE_FOR_TEMPLATES` `<template>`
   bypass; `ALLOWED_ATTR` pollution via persistent `setConfig`/hooks) are fixed only in an
   as-yet-unpublished `>3.4.10`. **Risk acceptance:** the sole runtime consumer is
   `src/components/ui/SafeHtml.tsx`, which calls `DOMPurify.sanitize(html, { ADD_TAGS, ADD_ATTR })`
   with an **inline per-call config** and uses **none** of the vulnerable features — no Trusted-Types
   output mode, no `SAFE_FOR_TEMPLATES`, no persistent `setConfig`/`addHook`. The exploit preconditions
   are absent. `src/test/safeHtml.test.tsx` pins the actual sanitization contract (script / `onerror` /
   `javascript:` stripped) so a future bump is guarded. **Action when fixed upstream:** bump dompurify.
2. **`glob` / `minimatch` / `brace-expansion` (high/moderate, transitive)** — reached only via **dev
   tooling**: `@vercel/nft` (build-time module tracing, under `@vercel/node`) and `@typescript-eslint`
   (lint). They are glob/pattern libraries that run at **build/lint time against the developer's own
   config**, and are **not bundled into the browser app** — they never process untrusted user input at
   runtime, so the ReDoS/glob advisories are not exploitable here. A blanket `overrides` is unsafe
   because newer majors of these coexist in the tree (e.g. `@vercel/nft` uses `glob@13`). **Action:**
   clears on a future tooling-major bump of `@vercel/node` / `@typescript-eslint` (separate PR).

## Follow-up (not in this PR)
- Tooling-major bump PR for `@vercel/node` + `@typescript-eslint` to clear the 3 build/lint residuals.
- Re-bump `dompurify` once `>3.4.10` is published.
