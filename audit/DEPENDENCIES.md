# Dependency-vuln posture (pre-scale)

`npm audit` flags 32 advisories. This is the triage — what was fixed, and why the rest
are accepted for now. The rule: **fix anything reachable in the production runtime; defer
dev/build-time tooling that never ships and whose only fix breaks the build.**

## Fixed (production runtime)
- **react-router-dom / react-router 7.13 → 7.17** (in-range) — the only user-facing-runtime
  HIGH advisories: stored XSS, CSRF via PUT/PATCH, and DoS. The one that genuinely mattered.
- **protobufjs → ^7.6.3** (override) — the lone CRITICAL (arbitrary code exec / prototype
  injection), pulled in transitively via `posthog-js → @opentelemetry/exporter-logs-otlp-http`.

Build + all 1538 tests green after both.

## Accepted for now (not in the production bundle)
Verified each remaining HIGH is **not** reachable from the shipped frontend:
- **vite, rollup, esbuild, glob, picomatch, flatted** — build/test tooling only. `npm audit fix`
  bumps vite→rollup and triggers the known npm optional-dep desync (`Cannot find module
  '@rollup/rollup-darwin-arm64'`), breaking the build — not worth it for code that never runs
  in production. The vite advisories are dev-server path-traversal (local dev only).
- **lodash@4.17.21** — already the latest/patched version; the advisory has no further fix.
- **ws@8.19.0, form-data@4.0.5** — dev-only (`jsdom → vitest`) and already past the patched
  version; the flag is a stale/transitive path.

## Deferred (needs a dedicated pass)
- **@vercel/node chain** (`undici`, `minimatch`, `path-to-regexp`, `@vercel/build-utils`,
  `@vercel/python-analysis`) — the Vercel **serverless** runtime for `api/cron/*`. Server-side,
  controlled outbound calls (to Supabase), so low real-world risk. npm's suggested fix is a
  `@vercel/node@4` **downgrade** (from the current 5.x), which would regress the runtime — so
  this needs a deliberate major-version bump + a test pass over every `api/` function, not a
  blind `audit fix --force`. Tracked as future work.

## How to re-check
`npm audit` for the list; `npm audit --json | …` to split runtime vs dev. Never run
`npm audit fix` / `--force` here — it desyncs rollup. Use targeted `npm update <pkg>` (in-range)
or a package.json `overrides` entry for leaf deps instead, and verify the build after each.
