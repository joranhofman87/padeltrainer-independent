
# QA Plan: Priority Rebooking System

Acting as QA manager. I'll perform a structured review of the new feature (bulk-copy slots + priority claims + token-based player flow + fill-rate stats), document findings, and add automated tests where they bring real value.

## 1. Static review (read-only, produces a report)

I will audit, file-by-file, and produce a written QA report covering:

- **Migration `20260506...sql`**
  - `slot_priority_claims` schema, indexes, RLS, triggers
  - `get_priority_claim_by_token` / `respond_to_priority_claim` RPCs (SECURITY DEFINER, search_path, GRANTs to anon)
  - Window expiry logic and idempotency (unique indexes per slot+player / slot+guest)
- **`src/lib/priorityClaims.ts`**
  - Bulk-copy field parity vs `availability_slots` (looking for missing columns vs source slot)
  - Idempotency via `priority_source_slot_id`
  - Sequential inserts inside a loop (N+1) — flag for follow-up if needed
  - Token RPC wrappers
- **`BulkCopySlotsWizard`, `PriorityClaimsSection`, `CycleFillRateCard`**
  - Required props, error states, empty states, i18n keys vs locale files
  - Owner-type parity (trainer vs academy)
- **`PriorityClaim.tsx`** page
  - `noindex`, expired window, already-responded, declined states
  - Redirect URL to `/app/book/:trainerId?slot=...&claim=...`
- **Visibility parity** in `BookLesson.tsx`, `TrainerOpenSlots.tsx`, `AcademyPublicOpenSlots.tsx`
  - Confirm filter respects `priority_window_ends_at` AND token bypass
- **Routing/SEO**
  - `/claim/:token` route registered, `robots.txt` disallow
  - Confirm not in `scripts/generate-sitemap.ts` / `public/llms.txt` / Cloudflare worker
- **`send-priority-claim-invitation` edge function**
  - AuthN check, service-role bypass, email payload, `invited_at` write-back, test-mode flag
- **`mollie-webhook` integration**
  - Marking matching claim as `claimed` on payment
- **Security review**
  - Run `supabase--linter`
  - Verify token RPCs do not leak email/PII to anon beyond what's needed

Output: a `QA_REPORT_priority_rebooking.md` summary with severity-ranked findings (blocker / high / medium / low / nit).

## 2. Automated tests (added to repo)

Vitest unit tests (pure logic, no DB) — in line with the project's existing test pattern (`src/lib/*.test.ts`):

- **`src/lib/priorityClaims.test.ts`** — type contracts and helpers:
  - `ClaimStatus` union completeness
  - `BulkCopyInput` shape — defaults and required fields
  - Pure helper for window-end calculation (extract small util `computePriorityWindowEnd(now, days)` from inline math so it's testable)
  - Pure helper for slot offset (extract `applyWeeksOffset(iso, weeks)` and test DST/timezone safety)
  - Token-bypass predicate (extract `shouldHidePrioritySlot({ windowEndsAt, hasPendingPriority, hasReleased, claimToken, claimSlotId, slotId, now })` from the duplicated inline logic in BookLesson / TrainerOpenSlots / AcademyPublicOpenSlots) and unit-test all branches.
- **`src/components/cycles/CycleFillRateCard.test.tsx`** — render with mocked supabase, asserts counts.
- **`src/components/cycles/PriorityClaimsSection.test.tsx`** — empty state + status badges render.

Edge function test (Deno):

- **`supabase/functions/send-priority-claim-invitation/index.test.ts`**
  - 401 without Authorization
  - 400 without `claimIds`/`slotId`
  - 200 with `testEmail` returning `sent` count (mocked Resend)

## 3. Light refactor in service of testability (only if needed for the tests above)

Extract three small pure helpers into `src/lib/priorityClaims.ts` (no behavior change), and update the three consumers (`BookLesson`, `TrainerOpenSlots`, `AcademyPublicOpenSlots`) to call `shouldHidePrioritySlot(...)` so the duplicated logic has one source of truth and is unit-tested.

## 4. Manual smoke test in preview (browser tool)

- Visit `/app/trainer/cycles` and verify the "Bulk copy slots" entry point renders.
- Visit `/claim/invalid-token` and verify the "Link not found" empty state.
- Verify `robots.txt` disallows `/claim/`.

## 5. Deliverable

- `QA_REPORT_priority_rebooking.md` at the repo root (or `/mnt/documents/`)
- New unit + edge tests as listed above
- Small refactor extracting `shouldHidePrioritySlot` for shared visibility logic
- A short summary of findings and recommendations in chat

## What I will NOT do in this pass

- Build full E2E tests for the booking-with-claim flow (requires seeded DB + auth).
- Touch business behavior — only extract pure helpers as already used.
- Re-do i18n or design work.

Approve and I'll execute the QA pass.
