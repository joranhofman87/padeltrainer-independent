# Short links

Purpose: the end-to-end map of padeltrainer's branded short-link primitive (`padeltrainer.ai/s/<code>`) — schema, resolver, client seams, the two-systems distinction, and the invariants that keep it from silently breaking.

Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-14

Related: [`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md), [`REGISTRATION_DECOUPLE_PLAN.md`](./REGISTRATION_DECOUPLE_PLAN.md), [`COMPONENT_PATTERN_REGISTRY.md`](./COMPONENT_PATTERN_REGISTRY.md).

---

## TL;DR

- **What:** a generic, entity-agnostic `code → target_path` map on our OWN domain. Sharing a
  registration form yields `padeltrainer.ai/s/<code>` → 301 → the registration form. Keeps
  backlink/SEO equity on-domain (no external shortener).
- **Why on our domain:** a 301 consolidates link equity to the destination; both the short link and its
  target live on padeltrainer.ai.
- **Scales because it's immutable:** a code's target never changes, so the Cloudflare Worker caches the
  301 at the edge — a viral link never touches origin/DB after the first hit; a miss is a single
  primary-key read.

## Two DISTINCT short-link systems (do not confuse)

| | NEW generic `/s/<code>` | OLD profile `/t/:slug`, `/a/:slug` |
|---|---|---|
| For | any entity (registrations first) | trainer / academy **public profiles** only |
| Backing | `short_links` table + `resolve_short_link` RPC | `slug_redirects` + `resolve_public_handle` RPC |
| Code | random base62(7) | human-readable name slug |
| Resolver | Cloudflare Worker `/s/` branch → HTTP 301 | client `ShortLinkRedirect` (`DomainRouter.tsx`) → `<Navigate>` |
| Build | `getShortUrl(code)` (`lib/domains.ts`) | `getTrainerShortUrl` / `getAcademyShortUrl` (`lib/domains.ts`) |

The profile links were deliberately **not** migrated onto `short_links` — a readable slug is better for a
public profile than a random code, and they already work. **For a NEW surface that needs a short link,
use the `/s/` system** (`getOrCreateShortLink`); reserve `/t/` `/a/` for the existing profile flows.

## Data layer — `supabase/migrations/20260825100000_short_links.sql` (+ `…110000_…revoke_anon.sql`)

- **`public.short_links`**: `code` PK (base62/7) · `target_path` (denormalized, immutable — the value
  the redirect serves) · polymorphic `target_type` / `target_id` / `target_params` · `permanent`
  (301 vs 302). `UNIQUE (target_type, target_id, target_path)` is the idempotency key. **RLS ON, no
  policies** — the table is unreachable directly; the RPCs below are the entire surface.
- **RPCs** (all `SET search_path = public`):
  - `get_or_create_short_link(...)` — idempotent mint, `SECURITY DEFINER`, **`authenticated` only**
    (see the grant gotcha below), open-redirect-guarded (rejects non-`/` and `//` targets),
    insert-retry on code collision.
  - `resolve_short_link(code) → (target_path, permanent)` — `STABLE`, **no writes** (keeps the redirect
    edge-cacheable), granted `anon` (the Worker calls it with the anon key).
  - `get_short_codes(type, ids[]) → (target_id, code)` — batch reverse lookup for admin listings
    (RLS blocks direct table reads), `authenticated` only.
- **Eager mint for registrations:** an `AFTER INSERT` trigger (`registrations_mint_short_link`,
  best-effort — a mint failure never blocks the insert) + a one-time backfill. So every form has a
  code and the admin listing (`listRegistrationCycles`) joins it onto `Cycle.short_code` → copy/QR are
  synchronous (no runtime RPC).

## ⚠ Supabase default-privileges grant gotcha

Supabase's `ALTER DEFAULT PRIVILEGES` auto-grants `EXECUTE` on every new `public` function to `anon`.
So `REVOKE ALL … FROM public` does **not** lock a function down — anon keeps its explicit grant. To make
any `SECURITY DEFINER` function authenticated-only you MUST `REVOKE EXECUTE … FROM anon, PUBLIC`
explicitly (migration `…110000` did this after an anon-mint hole shipped). **Verify new public RPCs as
anon post-deploy:** `curl .../rest/v1/rpc/<fn>` with the anon key. RLS-no-policies protects TABLES;
function EXECUTE grants are a separate gate.

## Resolver — Cloudflare Worker (`docs/cloudflare-worker.js`)

The `/s/<code>` branch (before the bot check): Cloudflare Cache API + a 301 (302 if `permanent=false`)
to `target_path`, resolved via the `resolve_short_link` RPC (PostgREST base derived from
`RENDER_FUNCTION_URL` → no new Worker env var). A miss → short-lived `noindex` 404. Crawlers follow the
301 and get the per-form OG from `render-page` at the destination. Deployed separately with
`npx wrangler@<version> deploy` (**not** the Vercel/Supabase deploy). Client fallback route `/s/:code`
in `DomainRouter.tsx` covers dev/preview where no Worker fronts the SPA.

## Client seams

- `src/lib/domains.ts` — `getShortUrl(code)` (pure).
- `src/lib/shortLinks.ts` — `getOrCreateShortLink`, `getShortCodesByTarget` (resilient: empty map on
  error), `registrationShortTargetPath`.
- `src/lib/cycleRegistrationUrl.ts` — **`shareUrlForRegistration(shortCode, cycleId, ownerType,
  ownerSlug?, lang?)`** — the SINGLE source that decides `short_code ? /s/ : long URL`. Every share
  surface calls this; do not re-derive the branch inline.
- Copy UI: `useCopyToClipboard()` hook (`src/hooks/`) is the one clipboard implementation (secure-context
  + execCommand fallback); `<CopyLinkButton>` (`src/components/ui/`) is the standalone button on it.
  Share surfaces: `CyclesTable` (academy+club list), `AcademyCycleDetail`, `CycleCard` (trainer list),
  `RegistrationQrDialog`.

## Invariants (guarded)

1. **SQL code charset/length ⊆ Worker regex.** `gen_short_code`'s alphabet+length must stay inside the
   Worker's `^/s/([0-9A-Za-z]{4,16})$`, or new links 404 at the edge. Guarded by
   `src/test/shortLinkContract.test.ts` (reads both files).
2. **`resolve_short_link` never writes** — a per-click counter would break edge caching. Analytics, if
   ever added, go off the hot path (PostHog / Worker logs).
3. **Mint is `authenticated`-only** (grant gotcha above). Resolve is `anon`.
4. `rehearse-short-links.ts` (auto-discovered by `run-all-rehearsals.mjs`) is the DB-layer guard —
   idempotency, collision retry, open-redirect guard, grants, best-effort trigger.

## Deploy order (4 targets)

DB migrate (`supabase db push`) → deploy `render-page` → Vercel (frontend) → `npx wrangler@<ver> deploy`.
