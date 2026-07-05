# ADR 0006 — Invoice / public-token payment links

Status: **Accepted** (in force)
Date: 2026-07-02 (recording a decision already load-bearing in the codebase)

## Context

Many payers are not logged-in users: guest players without accounts, parents paying for a
child, or a bookkeeper an academy forwards an invoice to. They still must be able to pay an
invoice online and receive the PDF. Requiring a Supabase session for every payer would exclude
the majority of the real payment flow.

## Decision

An invoice is payable by an **unauthenticated** party via a **public, opaque token URL**
(`/pay/:token`) served by the `get-public-invoice` / `create-invoice-payment` edge functions
and the `PublicInvoicePay` page. The token flow **reuses the same Mollie stack** as an
authenticated payment: create payment → `mollie-webhook` confirmation → PDF generation. No
login is required; the token is the capability.

## Alternatives considered

- **Require login to pay** — excludes guests/forwarded payers, i.e. most real payments.
- **Email a PDF only, pay offline** — loses online payment + automatic reconciliation.
- **A second, parallel guest payment stack** — duplicates the Mollie charge/webhook/PDF logic
  and its invariants; rejected in favour of one shared stack keyed differently by entry point.

## Consequences

- The token is a **bearer capability**: it must be high-entropy and must expose **only** the
  invoice's intended public fields (never cross-tenant or internal columns) — see the
  "public tokens expose only intended data" rule in [`../INVARIANTS.md`](../INVARIANTS.md).
- **`/pay/:token` is deliberately NOT language-prefixed.** A locale prefix (`/nl/pay/...`)
  404s — a known, easy-to-reintroduce gotcha; the public pay route lives outside the i18n
  router on purpose.
- Charge-org == confirm-org still holds: the public path resolves the same connected Mollie
  account the webhook confirms against ([ADR-0002](./0002-slot-is-price-source-of-truth.md),
  and the P1-9 academy-routing fix).
- One Mollie stack serves both authenticated and public payments, so money-path changes must
  be validated against **both** entry points.

Related: [`../payments/PAYMENT_FLOW_MAP.md`](../payments/PAYMENT_FLOW_MAP.md), [ADR-0007](./0007-edge-functions-as-backend-boundary.md).
