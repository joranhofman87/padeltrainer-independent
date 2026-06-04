# P0 hardening — PR-1 to PR-4 (deploy notes)

**Deployed:** ficwb `ficwbdrzefmblkbkomzw` (commit `54943d23`)  
**Scope:** backup-database auth, invoice player UPDATE guard, create-invoice-payment token auth, get-booking-invoice ownership.

---

## PR summary

| PR | Change |
|----|--------|
| PR-1 | `backup-database` — service role or admin JWT only (anon key rejected) |
| PR-2 | `protect_invoice_financial_columns_for_players` trigger on `invoices` |
| PR-3 | `create-invoice-payment` — requires `publicToken`; frontend passes token from `/pay/:token` |
| PR-4 | `get-booking-invoice` — JWT + booking player / trainer / academy manager / admin |

---

## Known edge case (acceptable for this PR)

If the logged-in **trainer** or **academy** user is also `invoice.player_id`, the player invoice protection trigger may block financial invoice edits (save line items, mark paid, cancel, due date, etc.) with `players_may_only_update_billing_fields` or `invoice_locked`.

This is **acceptable for PR-2** and does not block the main security goal (players cannot mutate financial columns via client RLS).

**Follow-up:** Exempt invoice owner roles (trainer on `trainer_id`, academy manager on `academy_profile_id`, admin) **before** applying the player guard. Track in [padeltrainer-independent#1](https://github.com/joranhofman87/padeltrainer-independent/issues/1).

---

## Post-deploy ops

- Rotate **backup cron** off anon key → `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (or admin JWT).
- Smoke tests: `scripts/security/p0_pr1_pr4_verification.sql`
