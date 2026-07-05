# ADR 0007 — Edge functions as the backend boundary

Status: **Accepted** (in force; ~96 functions)
Date: 2026-07-02 (recording a decision already load-bearing in the codebase)

## Context

The product is a static React SPA (Vite → Vercel) with a Supabase backend. It needs
privileged server work that must not run in the browser: cross-tenant operations, money
moves (Mollie charge creation + webhook writeback), service-role reads/writes that bypass
RLS, admin actions, and atomic multi-row invariants. Postgres RLS covers per-tenant reads,
but it cannot express "create a Mollie charge", "flip every booking in a group to paid
atomically", or "export/backup", and the SPA cannot be trusted with a service-role key.

## Decision

All privileged / cross-tenant / money / service-role work lives **server-side**, as either:

- a **Supabase Deno edge function** under `supabase/functions/*`, or
- a **`SECURITY DEFINER` RPC** for atomic, invariant-critical DB operations.

Edge functions run with **`verify_jwt = false`** and **self-authenticate in code** via
[`_shared/auth.ts`](../../supabase/functions/_shared/auth.ts) (`requireUser` calls the real
`auth.getUser`; `requireServiceRole` does a timing-safe compare against the real service-role
key — [`_shared/service-role-auth.ts`](../../supabase/functions/_shared/service-role-auth.ts)).
The SPA **never holds a service-role key**; it reaches privileged work only by invoking an
edge function or an RPC.

## Alternatives considered

- **A dedicated Node/server backend** — more infrastructure to run and secure, duplicates the
  Supabase auth/session model; rejected as unnecessary for a Supabase-native app.
- **Service-role key in a server-rendered layer** — there is no trusted server render tier
  (static SPA on Vercel); shipping the key anywhere the client can reach it is disqualifying.
- **RLS-only** — insufficient for cross-tenant ops, external side effects (Mollie/Resend), and
  atomic multi-row money invariants.

## Consequences

- `verify_jwt = false` means **the platform does not gate these functions** — each is
  responsible for its own authN/authZ. A bug here is a real breach: the fixed P0 (a forged,
  unsigned `service_role` JWT accepted by a claims-only check) lived exactly at this boundary.
  The `check:edge-config` CI gate enforces the deliberate `verify_jwt` allowlist.
- **Edge functions and migrations do not auto-deploy** (only the frontend does, via Vercel);
  the owner applies them manually. Every edge-fn/migration change must degrade gracefully
  against un-migrated prod. See [`../deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md`](../deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md).
- **Only `supabase/functions/_shared/*` is unit-tested + CI-covered**; a function's `index.ts`
  is not deno-checked in CI (a known gap — see [`../technical-debt/QUALITY_GATES_BACKLOG.md`](../technical-debt/QUALITY_GATES_BACKLOG.md)).
  Therefore: **put testable logic in `_shared/`** and keep `index.ts` thin.

Related: [`../ARCHITECTURE_BOUNDARIES.md`](../ARCHITECTURE_BOUNDARIES.md),
[ADR-0003](./0003-mutation-boundary-facades.md).
