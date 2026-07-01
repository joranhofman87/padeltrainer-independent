# Audit brief — the rebooking flow from the PLAYER's perspective

**Date:** 2026-07-01
**Audience:** Codex (second reviewer) — run this same audit independently.
**Scope:** The player experience of *rebooking* (an academy re-invites a finished cycle's players to a new round; a player claims + pays during the priority window before spots open to others). This brief audits it **from the authenticated player's point of view**, not the academy's.

This brief was grounded by a fresh 7-touchpoint code map (2026-07-01). Preliminary findings are included per section so you can confirm or refute them; **treat every "GAP" below as a hypothesis to verify against source, not a settled fact.**

---

## The owner's required player experience (the spec to audit against)

1. Player **receives the rebook email**; can click **YES (rebook) or NO**.
2. Player must **pay for the FULL cycle**.
3. After receiving the email, the player should **also see the invite INSIDE THE APP** (not only via the email link).
4. After paying, the player should **see the invoice in their app**.
5. Player can say **"continue with the SAME people" or "OTHERS are joining"**; for others, **name + email + phone** must be captured.
6. Player should **see the booked slots/sessions in their account**.

---

## LOCKED decisions (owner, 2026-07-01) — the target behavior to audit against

The audit below flagged 5 product decisions. The owner has now answered them; **audit against these targets** (several imply code changes, listed as "→ CHANGE"):

1. **Every rebook is FULL cycle price** — individual/single rebooks too, not just the group path. → CHANGE: remove the ÷headcount split on the individual/deferred rebook path (`create-rebook-invoice` / `auto-create-invoice` / `create-mollie-payment`).
2. **Flow is email-link-driven; NO login required to respond or pay.** YES → straight to checkout for the full cycle; NO → records decline. **Store which button was clicked**, even if they abandon checkout after YES. → CHANGE: persist the accept/decline intent on the claim *on landing* (today only a completed accept or an explicit decline is stored; a YES-then-abandon leaves no trace).
3. **No in-app roster editor needed** — the roster editor ("same or different people") lives on the token/checkout page only. The logged-in dashboard card stays Keep/Release. (So the earlier "email link should route into the app" gap is intentionally NOT a requirement.)
4. **New-member capture is MANDATORY: first name, last name, email, phone.** → CHANGE: make last name + email + phone required in `AddGroupMemberFields` AND `create_rebook_group_guest` (today only first name is required).
5. **Guests need only email + payment.** In-app visibility is a post-hoc convenience: a guest who wants to see their invoice/slots **claims an account by signing up with their email**. → AUDIT FOCUS: the guest→account link (`link_guest_data_to_profile`) must reliably surface the rebook **invoice + slots** after signup (flagged below as a silent-failure risk).

Net: the primary rebook flow is **entirely email-link + checkout, no login**. The in-app surfaces (dashboard card, invoices, bookings) are for players who have (or later claim) an account.

---

## Personas to test (the gaps are persona-specific — test all five)

| # | Persona | How they enter | Has app login? |
|---|---|---|---|
| P1 | **Registered player, single claim** (no group) | email token OR dashboard card | yes |
| P2 | **Registered player = group "captain"** (rebooks the whole group) | email token OR dashboard card | yes |
| P3 | **Kept group member** (captain re-booked them) | email + notified | yes (if account) |
| P4 | **Newly-added person** (captain adds them, name/email/phone) | created as a guest | **no account** |
| P5 | **Guest-only invitee** (original invitee has no account) | email token only | **no account** |

---

## The flow as currently built (map)

```
academy sends invites ─▶ send-priority-claim-invitation (edge fn)
                              │  YES → /:lang/claim/:token?intent=accept
                              │  NO  → /:lang/claim/:token?intent=decline
                              ▼
                        PriorityClaim.tsx  (token-gated, NO login required)
                          ├─ get_priority_claim_by_token (SECURITY DEFINER)
                          ├─ rules consent gate (RichTextConsent)
                          ├─ single: accept → acceptClaimAndStartPayment / decline
                          └─ group:  RebookGroupEditor + AddGroupMemberFields
                                        → create_rebook_group_guest / rebook_group_apply

  IN PARALLEL (logged-in only):
      PlayerDashboard ─▶ PlayerRebookCard ─▶ get_my_pending_priority_claims (SECURITY DEFINER)
                          └─ Keep / Release ONLY  (no roster editor)

  PAY:
      upfront (Mollie)  → create-mollie-payment ─▶ mollie-webhook confirms
      upfront (no Mollie)→ create-rebook-invoice / create-group-rebook-invoice → /pay/:token
      deferred (default) → NO invoice at accept; minted at cycle start by cron
                          └─ auto-create-invoice writes invoices.player_id

  SEE RESULTS (logged-in):
      /app/player/invoices → PlayerInvoicesTab (invoices.eq player_id, neq draft)
      /app/bookings        → PlayerBookings (playerBookings.ts + get_my_linked_guest_bookings)
      /app/agenda          → PlayerAgenda
```

Key tables: `slot_priority_claims` (status, claim_token, player_id|guest_player_id, rebook_group_id, invited_at, responded_at, rules_accepted_at, booked_by_*), `bookings`, `invoices` (player_id, guest_player_id, booking_ids, rebook_group_id, status). Payment mode lives in `cycles.settings` (`rebook_payment_mode`, `rebook_strict_mollie`).

---

## Requirement 1 — receives email, clicks YES/NO

**Touchpoints:** `supabase/functions/send-priority-claim-invitation/index.ts`, `send-rebook-reminder/index.ts`, `src/pages/PriorityClaim.tsx`, route `/:lang/claim/:token` (`src/components/DomainRouter.tsx`), RPC `get_priority_claim_by_token` (`supabase/migrations/20260626100000_rebook_group_captain.sql`).

**Checks:**
- Send test invites to P1–P5; confirm each resolves the correct email (profiles.email for registered, guest_players.email for guests) in Resend logs.
- Email HTML `<a href>` = language-prefixed `/:lang/claim/:token` with `?intent=accept` / `?intent=decline`; landing page pre-highlights the matched button (PriorityClaim reads `intent`).
- `invited_at` is stamped only when NULL (no double-send); resend=false skips already-invited claims.
- Academy custom message is HTML-escaped (inject `<script>` → renders as entities).
- Window expiry: a claim past `priority_window_ends_at` → `evaluatePriorityClaimResponse` returns `window_expired`; page shows "reservation period ended", no accept/decline buttons.
- Reminders (`send-rebook-reminder`) are academy-manager-only (non-manager → 403) and scoped to the requested cycle's claims only.

**Expected:** YES/NO both work for every persona from the email.
**Known-risk / GAPs to confirm:**
- **[MED] Forwardable token** — `/claim/:token` has no auth/IP binding/throttle; a forwarded email lets a third party accept/decline the original player's spot. Confirm whether this is acceptable.
- **[LOW] Reminders are manual only** — no automatic non-responder reminder; player never re-nudged unless the academy acts.

---

## Requirement 2 — pay for the FULL cycle

**Touchpoints:** `src/pages/PriorityClaim.tsx`, `src/lib/priorityClaims.ts` (`acceptClaimAndStartPayment`), `create-mollie-payment`, `create-rebook-invoice`, `create-group-rebook-invoice`, `auto-create-invoice`; RPCs `respond_to_priority_claim`, `book_slot_for_payment`.

**Checks:**
- **UPFRONT** charges the FULL cyclus total (`computeCyclusTotalFromSlots`, price_per_session × sessions), server-authoritative (submit a bogus `clientAmount` → ignored).
- **GROUP** upfront mints **one** invoice at the full court price for the captain (no `splitAmongPlayers`); teammates added post-payment ride the same invoice (unique partial index on `invoices.rebook_group_id`).
- Multi-slot cycle → accepting one slot auto-accepts the sibling weeks and bundles them into **one** checkout.
- **STRICT** mode (`rebook_strict_mollie`): if Mollie can't start, the just-created hold is **released** (no seat held, no bank fallback). Non-strict: seat held, invoice fallback minted (`upfront_invoiced`).

**⚠️ Open product question (flag to owner):**
- **[DESIGN] "Full cycle" vs the default `deferred_split` mode.** The **default** payment mode invoices each player their **split share** (÷ headcount) at cycle start — *not* the full price. Only the **group-captain** path and **upfront** mode charge the full court price. **Codex must confirm which behavior the owner wants for a single/individual rebook**, and whether the default should be full-price. (This mirrors an earlier decision that the *group* path is always full-price; the *individual/deferred* path is where split still lives.)
- **[MED] Split divisor timing** — for deferred_split, the divisor is computed at *invoice/checkout* time, not frozen at accept; adding/removing members between accept and cycle-start changes each player's amount. Confirm this is intended.

---

## Requirement 3 — see the invite INSIDE THE APP

**Touchpoints:** `src/components/dashboard/PlayerRebookCard.tsx`, `src/pages/PlayerDashboard.tsx`, `getMyPendingPriorityClaims` (`src/lib/priorityClaims.ts`), RPC `get_my_pending_priority_claims` (`supabase/migrations/20260703120000_*.sql`), test `src/test/myPendingPriorityClaims.test.ts`.

**Checks:**
- Log in as P1/P2 with a pending claim → `PlayerRebookCard` renders on the dashboard with matching slot details, price, payment-mode copy, and Keep/Release.
- A weekly series collapses to **one** card (not N), showing "Every [weekday] at [time] · N sessions · term total".
- Linked-guest visibility: a `guest_player_id` claim linked to an account (via `guest_players.linked_profile_id`) surfaces on the account-holder's dashboard through the RPC (not just the `player_id=self` path).
- RPC-missing fallback: mock PGRST202 → card still renders via the legacy `player_id` select.

**Expected:** The pending invite is visible in-app for logged-in players (P1/P2, and P3 if linked).
**Known-risk / GAPs to confirm:**
- **[HIGH] The email link never routes into the app.** Even when a player is logged in, the email link lands on the anonymous `/:lang/claim/:token` page — no session continuity, no "you're in your app" context. Requirement #3 is met *only* by the separate dashboard card, which is **pull-only** (no push/badge/toast when an invite arrives). Confirm whether the owner considers the dashboard card sufficient, or wants the email link to deep-link into an authenticated in-app view.
- **[MED] Guests (P4/P5) have no in-app surface at all** — no account → no dashboard → email token is their only channel.
- **[LOW] Low discoverability** — no header badge / nav indicator; the player must scroll to the card.

---

## Requirement 4 — see the invoice in the app after paying

**Touchpoints:** `src/pages/PlayerInvoicesPage.tsx`, `src/components/player/PlayerInvoicesTab.tsx`, `create-rebook-invoice`, `create-group-rebook-invoice`, `auto-create-invoice`; `invoices` table + RLS "Players can view their own non-draft invoices".

**Checks:**
- Every rebook payment inserts `invoices` with `player_id` = the paying player's `profile.id` (NOT null) and `status='sent'` (passes the `.neq('status','draft')` filter).
- P1/P2 pay → navigate to `/app/player/invoices` → the rebook invoice appears within seconds, correct full amount, `booking_ids` covering the cycle's slots.
- RLS: as a *different* authenticated user, `SELECT invoices WHERE player_id = <peer>` returns nothing.

**Expected:** For registered upfront payers (P1/P2) the paid invoice appears in-app.
**Known-risk / GAPs to confirm:**
- **[MED/HIGH] Deferred_split** creates **no invoice at accept** — it's minted later by the cycle-start cron. So a deferred player sees **no invoice in-app until the cycle begins**. Confirm the owner accepts this, or wants an immediate "reserved / to be invoiced" record.
- **[HIGH] Guests (P4/P5) never see the invoice in-app** — RLS keys on `player_id`; guest invoices (`guest_player_id`) are payable only via the tokenized `/pay/:token` link.
- **[QUESTION] Immediate vs webhook-confirmed** — verify whether the invoice/paid state shows right after the Mollie redirect or only once `mollie-webhook` confirms. Test the redirect-back timing.

---

## Requirement 5 — same people or others joining (capture name + email + phone)

**Touchpoints:** `src/components/cycles/RebookGroupEditor.tsx`, `AddGroupMemberFields.tsx`, `src/pages/PriorityClaim.tsx`, RPCs `get_rebook_group_by_token`, `create_rebook_group_guest`, `rebook_group_apply` / `rebook_group_manage` (`supabase/migrations/20260626100000_*.sql`, `20260626110000_*.sql`).

**Checks:**
- Group claim on the token page → `RebookGroupEditor` renders: keep/remove existing, add new. New-member capture: **first name required; last name, email, phone optional** — trace to `create_rebook_group_guest` (`IF v_first IS NULL THEN RAISE`).
- Add-new dedups by email within academy/trainer scope (returns the existing guest if the email matches).
- `rebook_group_apply`: removed members' pending claims → declined; kept → booked; new guests → one booking + claim per slot, `booked_by`=captain; **captain is always force-kept**; capacity check `>= max_participants` under the per-slot advisory lock.
- Single (non-group) claim: verify the UI shows **only** accept/decline.

**Expected:** The "same or different people" + new-person capture works on the token page for P2.
**Known-risk / GAPs to confirm (these are the biggest player-experience gaps):**
- **[HIGH] Roster editor is NOT reachable in-app.** `PlayerRebookCard` only offers **Keep / Release** — no roster management. A logged-in player **cannot** do the "same-or-different people / add new members" flow from the app; they must use the **email token link**. So requirement #5 is not satisfiable in-app today. Verify (grep `PlayerRebookCard.tsx` for `setGroupMode`/`roster` → expect none).
- **[HIGH] Single-player (non-group) claims never offer the "same or different people" choice at all** — only accept/decline. Confirm whether a solo rebooker should be able to add others (which would create a group).
- **[LOW] Owner requirement says name+email+phone "must be provided" for new people, but the RPC requires only first name** (last/email/phone optional). Confirm whether email + phone should be **mandatory** for new members (they currently aren't).

---

## Requirement 6 — see the booked slots in the account

**Touchpoints:** `src/pages/PlayerBookings.tsx`, `PlayerAgenda.tsx`, `src/lib/playerBookings.ts` (`fetchPlayerBookings`, `fetchUpcomingPlayerBookings`, `fetchLinkedGuestBookingRows`), RPCs `get_my_linked_guest_bookings`, `get_my_paid_booking_ids`, automation `link_guest_data_to_profile`.

**Checks (run per persona):**
- **P2 captain:** `/app/bookings` + `/app/agenda` show own sessions with correct status + payment status; cancel available.
- **P3 kept member:** sessions appear (via `link_guest_data_to_profile`); if surfaced as a linked-guest, cancel is hidden; payment status matches the paid invoice.
- **P4 newly-added guest, later signs up with same email:** after signup, `link_guest_data_to_profile` moves guest bookings to `player_id` → they appear in `/app/bookings` + `/app/invoices`.
- **P4/P5 with no account:** sessions do **not** appear in-app (RLS); only `GuestBookingSuccess` via email token.

**Expected:** Registered personas see their rebooked+paid sessions.
**Known-risk / GAPs to confirm:**
- **[HIGH] Invoice linked-guest coverage** — `PlayerInvoicesTab` queries only `player_id`; there is no linked-guest RPC for **invoices** (unlike bookings). If `link_guest_data_to_profile` fails or a guest invoice lacks `guest_player_id`, the player won't see that invoice. Verify the automation's reliability + backfill.
- **[MED] Linked-guest payment status** depends on `get_my_paid_booking_ids`; if that RPC isn't deployed (PGRST202), a paid guest booking can silently show as "pending".
- **[MED] Newly-added guest (P4) sees nothing in-app** until they create an account AND the link automation runs.
- **[LOW] No "who rebooked you" context** in `/app/bookings` — the `booked_by_captain_name` shown on the token page is absent from the in-app bookings view; a kept member sees the session but not that their captain booked it.

---

## Cross-cutting things to verify

- **Consent gate integrity:** rules come from the SECURITY DEFINER payload (`get_priority_claim_by_token`), so the gate can't silently fail-open; but confirm `isBlankRichTextHtml()` normalizes null / `<p></p>` / whitespace correctly, and that consent (`rules_accepted_at`) is recorded **before** the accept RPC. `recordRebookRulesConsent` is best-effort (2.5s timeout) and must never block payment.
- **Idempotency / double-response:** re-accepting or re-declining a `claimed`/`declined` claim → RPC returns `already_responded`; UI shows the settled state, not an error.
- **Capacity vs live holds (Codex F5, just shipped):** the group RPCs now count live `payment_pending` holds — confirm the deployed prod definitions include the hold clause.
- **Payment routing (Codex F3, just shipped):** multi-academy trainer slot payments route to the slot's academy on both charge + confirm — confirm live.
- **State loss on reload:** on the token page, accept/decline state is client-only; reloading before the redirect fires reverts to the buttons (the dashboard card recovers via query refetch, the token page does not).

---

## How to run this audit

1. **Read-only first** (no prod mutations): read the touchpoint files, the two group-rebook migrations, and the `cycles.settings` payment-mode keys; confirm/refute each GAP against source.
2. **Live read** via the anon publishable key at `https://ficwbdrzefmblkbkomzw.supabase.co` for reference tenant **RL Padel Performance**: inspect a real rebook cycle's `slot_priority_claims`, `rebook_payment_mode`, and windows.
3. **E2E per persona** (test tenant only): drive P1–P5 through email → (app card) → accept/roster → pay → invoice → bookings, asserting the "Expected" line in each section.
4. **Report** as: per-requirement PASS/PARTIAL/FAIL, each GAP confirmed/refuted with file:line, and a clear list of the **product decisions** the owner must make (full-price-vs-split, email-link-into-app, in-app roster editing, guest in-app visibility, mandatory email+phone for new members).

**Do NOT** (during the audit): deploy functions, apply migrations, invoke booking/payment edge functions against live data, send emails, create payments, or mutate production.

---

## Implementation plan (post-audit, owner-approved 2026-07-01)

Both this audit and Codex's independent audit (main @ e5796262) agree. Codex's confirmed-good list validates the foundation (F5 hold-aware capacity, webhook/payment idempotency, `invited_at` double-send guard, dashboard pending-claim surface). The gaps below are the work; each is mapped to an owner decision.

### Slice A — No-login rebook payment (KEYSTONE; owner #1 + #2; Codex P1) — money-path
**Problem:** the upfront rebook payment requires an authenticated player who owns the booking (`create-mollie-payment` / `create-rebook-invoice` gate on `booking.player_id === caller`), so a logged-out or guest-keyed player who clicks YES is marked "reserved" then hits `upfront_unavailable` — no way to pay. The owner's flow is email → checkout → pay full cycle, **no login**.
**Build:** YES → a **token-gated** (`claim_token`, no auth) mint of a **full-cycle** rebook invoice (guest-keyed when no account) → redirect to the existing `/pay/:token` (`PublicInvoicePay` → `create-invoice-payment` → `mollie-webhook`). Group path gets the token-gated variant of `create-group-rebook-invoice`. **Full price by construction** (owner #1 — remove the ÷headcount split on the rebook path; do NOT double-charge the fallback). Reuses the just-hardened guest pay-first stack (incl. F3 recipient routing + F5 capacity). Adversarial money-path verify + Codex second-look on the design before building.

### Slice B — Store the YES/NO click on landing (owner #2; Codex P3) — low-risk
Persist the accept/decline intent on `slot_priority_claims` the moment the player lands (not only on completed accept / explicit decline), so a "clicked YES then abandoned checkout" is visible.

### Slice C — Mandatory new-member fields (owner #4; Codex P1) — low-risk
Require first + last + **email + phone** in `AddGroupMemberFields.tsx` AND `create_rebook_group_guest` (migration). Every member then has an email, so `send-rebook-group-confirmation` never skips anyone.

### Slice D — Guest sees invoice + slots after signup (owner #5; Codex P2) — medium (after A)
Make `PlayerInvoicesTab` linked-guest-aware (mirror the bookings' linked-guest RPC) and confirm `link_guest_data_to_profile` surfaces the rebook invoice post-signup. Depends on how A shapes guest-keyed rebook invoices.

### Out of scope (owner #3)
In-app roster editor — the token/checkout page stays its home; the logged-in dashboard card remains Keep/Release.

### Sequencing
B + C first (independent, low-risk, close two P1/P3 items) → A designed carefully + Codex re-audit of the money-path design before build → D after A.

