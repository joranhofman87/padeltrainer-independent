# Frontend architecture

How the React/TypeScript frontend is organised, and the rules that keep it
scalable as we add roles, pages, and (AI-assisted) contributors. The headline
rule — **role folders must not import each other** — is enforced in CI by an
ESLint guardrail, so this isn't just convention.

Related docs: [UI_COMPONENT_STANDARDS.md](./UI_COMPONENT_STANDARDS.md) (when/how to
build shared components), [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) (visual tokens),
[SCHEDULING_ARCHITECTURE.md](./SCHEDULING_ARCHITECTURE.md) (academy-first scheduling
boundary), [LINTING.md](./LINTING.md) (the shrink-only lint baseline).

## TL;DR (read this before editing a page)

1. **Pages are thin wrappers.** A page wires data + role context to shared
   components. Business logic and reusable UI belong in components/hooks/lib, not
   inlined in a page.
2. **Put shared things in shared places.** UI primitives → `components/ui`.
   Cross-role business components → a neutral domain folder (`components/invoices`,
   `components/players`, `components/cycles`, `components/slots`, `components/locations`,
   `components/booking`, `components/profiles`, `components/reviews`). Shared
   logic/types → `lib/`. Shared stateful behaviour → `hooks/`.
3. **Role folders are private.** `components/{trainer,academy,club,player}` and
   `pages/{trainer,academy,club}` may use shared/neutral code freely but **must not
   import another role's folder**. This is CI-enforced (see below).
4. **One feature exists for several roles → make it shared.** If trainer *and*
   academy both need it, it goes in a neutral folder and each role page is a thin
   consumer — never a copy-paste per role.
5. **Changing a role-specific page? Check the other roles first** (see
   [Process rule](#process-rule-check-all-roles)).

## Directory layout

```
src/
  components/
    ui/            # design-system primitives (button, card, dialog, table, …) — role-agnostic
    <neutral>/     # cross-role business components, grouped by domain:
                   #   invoices, players (plural = shared!), cycles, slots,
                   #   locations, booking, profiles, reviews, sponsors, home, auth, email
    trainer/       # ROLE: trainer-only components
    academy/       # ROLE: academy-only components
    club/          # ROLE: club-only components
    player/        # ROLE: player-only components (singular!)
    admin/         # internal/ops components
  pages/
    trainer/  academy/  club/   # ROLE pages
    marketing/  admin/  onboarding/
    <root>/        # auth, booking, registration, public + player pages
  hooks/           # shared stateful behaviour (useAuth, useTableSort, useDebouncedValue, …)
  lib/             # shared logic + types (pricing, invoiceSync, slotTypes, domains, …)
  integrations/    # generated Supabase client + types
  i18n/            # locales (en, nl) — keys must stay in parity (scripts/check-i18n-parity.ts)
```

> **`player` vs `players`** — `components/player` (singular) is the player **role**
> folder and is private. `components/players` (plural) is **shared** player-management
> UI (tags, notes, merge) used by trainer + academy + admin. The guardrail restricts
> `player/**` but never `players/**`.

## The layers (and what may import what)

| Layer | Folder | May import from |
|---|---|---|
| Primitives | `components/ui` | other `ui`, `lib`, `hooks` |
| Neutral / domain | `components/<neutral>` | `ui`, other neutral, `lib`, `hooks` |
| Role components | `components/<role>` | `ui`, neutral, `lib`, `hooks` — **not** other roles |
| Role pages | `pages/<role>` | its own role's components, `ui`, neutral, `lib`, `hooks` — **not** other roles |
| Logic | `lib`, `hooks` | `lib`, `hooks` (no React components) |

Dependencies point **downward** (pages → role/neutral components → ui → lib). They
never point sideways between roles.

## Role isolation (CI-enforced)

A role's `components/` and `pages/` folders **must not import another role's**
`components/` or `pages/` folders. Cross-role coupling makes one role's UI silently
depend on another's internals — the single biggest cause of "I edited the trainer
page and the academy page broke," and the easiest mistake for an AI assistant
editing one role in isolation.

Enforced by `no-restricted-imports` blocks in [`eslint.config.js`](../eslint.config.js)
(role-scoped `files` overrides), gated by `npm run lint` in CI. A forbidden import
fails the build with a message pointing back here.

**When you need code in more than one role**, don't reach across — lift it:
- Pure UI with no role logic → `components/ui`.
- Business component used by ≥2 roles → a neutral domain folder
  (`components/invoices`, `components/slots`, …). The role page passes role-specific
  bits (labels, submit handler, query keys) in as props/slots.
- Types or pure functions → `lib/` (e.g. `lib/slotTypes.ts` holds the slot view
  types shared by every calendar surface).
- Stateful behaviour → `hooks/`.

## Process rule: check all roles

Trainer, academy, club, and player frequently mirror each other. **Before changing
a role-specific page or component, check whether the other roles have an equivalent**
that should change too (or that already diverged). A fix applied to only
`TrainerInvoices` when `AcademyInvoices` has the same bug is half a fix.

Practical checks:
- `grep` the symbol/behaviour across `pages/{trainer,academy,club}` and
  `components/{trainer,academy,club,player}`.
- If you're duplicating JSX/logic into a second role, stop and lift it to a neutral
  folder instead (that's the whole point of the layering).

## Known architecture debt (tracked, not fixed here)

These are real and intentionally **not** addressed in the doc/guardrail PR — they're
larger refactors. The guardrail freezes them (no *new* instances) and they burn down
over time via `npm run lint:prune`.

1. **Academy/club reuse trainer components directly** — the existing cross-role
   imports, baselined in `eslint-suppressions.json` (`no-restricted-imports`):
   - `pages/academy/AcademyCalendar` → trainer `AddSlotDialog`, `BookForPlayerDialog`, `DeleteSlotDialog`
   - `pages/academy/AcademyCreateSlot` → trainer `AddSlotDialog`, `SlotLocationPicker`
   - `pages/academy/AcademyDashboard` → trainer `UnpaidBookingsCard`, `dashboard/DashboardActivityList`
   - ~~`pages/academy/AcademyInvoices` → trainer `InvoiceEmailDialog`~~ ✅ resolved (slice 1 — `InvoiceEmailDialog` moved to `components/invoices/`)
   - `pages/academy/AcademyPlayers` → trainer `AddPlayerDialog`, `AddPlayerForm`, `ImportPlayersDialog`
   - `pages/academy/AcademySlotDetail` → trainer `InlineBookPlayer`, `InlineEditBooking`
   - `pages/club/ClubCalendar` → trainer `TrainerCalendarGrid`

   **Burn-down:** move each of these into a neutral folder (most are slot/booking/player
   dialogs → `components/slots`, `components/booking`, or `components/players`), repoint
   trainer + academy/club importers, then `npm run lint:prune` to shrink the baseline.
2. **Parallel role variants that should share a base** — `TrainerPlayerDetailsCard`
   vs `AcademyPlayerDetailsCard`; `TrainerInvoiceSettingsCard` vs
   `AcademyInvoiceSettingsCard` (a shared `InvoiceSettingsCardBase` already exists —
   finish routing both through it); `TrainerPageHeader` vs the generic `PageHeader`.
3. **Fat pages** — `EditProfile` (~1140 lines), `AcademyPlayers` (~1120),
   `TrainerPlayerDetail` (~1000) inline large amounts of JSX/logic that should be
   extracted into components. Extract opportunistically when you touch them.

## Consolidation roadmap (burning down the cross-role debt)

How we turn debt item #1 into shared components, one focused PR at a time.

**Canonical role = academy.** Academy is the most-developed and most-tested surface,
so its behaviour is the source of truth. For the debt-#1 components this is *free*:
academy doesn't have its own copy — it already renders trainer's component — so
**relocating the component to a neutral folder is behaviour-preserving for academy**
(only the import path changes). Trainer renders the same component too, so it's
unchanged as well.

**Rules for each relocation slice**
- **Relocate as-is.** `git mv` the component to a neutral folder and repoint
  importers — do **not** generalise/rename in the same step (that's what risks
  changing academy). Generalisation, if ever needed, is a separate later PR.
- Move a component **with its cluster**: if it relatively-imports siblings, those
  move together (or it stays put until they can).
- After the move: `npm run lint` → `npm run lint:prune` (shrinks the baseline) →
  `npm run build` → `npx vitest run` → confirm `tsc` adds no new errors vs `main` →
  `grep` that no `@/components/trainer` imports remain in the moved files' consumers.

**Sequenced slices** (easiest/most-isolated first):

1. **Self-contained singles** (no sibling deps — pure single-file moves):
   - `InvoiceEmailDialog` → `components/invoices/` — clears `AcademyInvoices` fully. ✅ **done (slice 1)**
   - `SlotLocationPicker` → `components/slots/`
   - `UnpaidBookingsCard` → `components/booking/`
   - `dashboard/DashboardActivityList` → a shared dashboard home — clears `AcademyDashboard` (with `UnpaidBookingsCard`)
2. **Player-dialog cluster** → `components/players/`: `AddPlayerDialog` +
   `AddPlayerForm` (circular) + `ImportPlayersDialog`. Higher churn — `AddPlayerDialog`
   is a ~15-importer hub, including the **neutral** `InvoiceCustomerSection` (so this
   also fixes a neutral→trainer leak). Move the cluster together. Clears `AcademyPlayers`.
3. **Slot/booking cluster** (largest) → `components/slots/` + `components/booking/`:
   the slot dialogs (`AddSlotDialog`, `DeleteSlotDialog`, `BookForPlayerDialog`,
   `InlineBookPlayer`, `InlineEditBooking`) and `TrainerCalendarGrid` all depend on
   `CalendarSlotCard` (447 lines) + `DayViewSlotCard` + `GuestPlayerSlotCombobox`, so
   those hubs move with them as one cluster. Clears `AcademyCalendar`,
   `AcademyCreateSlot`, `AcademySlotDetail`, `ClubCalendar`.
4. **Divergent variants** (debt #2 — academy canonical, **trainer converges → trainer
   changes, needs trainer-side testing**): `Trainer/AcademyPlayerDetailsCard`,
   `Trainer/AcademyInvoiceSettingsCard` (finish routing both through the existing
   `InvoiceSettingsCardBase`). `AcademySidebar`/`AcademyLayout` vs the trainer
   equivalents are *legitimately* role-specific chrome — leave them split.

## See also

- [UI_COMPONENT_STANDARDS.md](./UI_COMPONENT_STANDARDS.md) — when to extract a shared
  component, the props/slot pattern, and the shared invoice/player examples.
- [DOMAIN_MODEL.md](./DOMAIN_MODEL.md) — the entity map (registrations/cycles/slots/bookings/
  invoices) + the canonical write boundaries + money/data invariants.
- [EXTENDING_THE_DOMAIN.md](./EXTENDING_THE_DOMAIN.md) — the playbook + PR checklist + critical-flow
  test matrix for changing the scheduling/money domain safely.
- [adr/](./adr/) — Architecture Decision Records (the *why* behind the registrations/cycles split,
  slot-as-price-truth, the mutation-boundary facades, and rebooking).
- [AGENTS.md](../AGENTS.md) — the short version of these rules for AI assistants.
