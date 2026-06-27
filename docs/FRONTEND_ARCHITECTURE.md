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

## Known architecture debt (tracked)

1. ~~**Academy/club reuse trainer components directly**~~ ✅ **RESOLVED (2026-06).** The
   cross-role `no-restricted-imports` baseline is now **0** — every academy/club/player
   page is structurally barred from importing `components/trainer`, and the guardrail
   keeps it there. The shared pieces were relocated to neutral folders (move-as-is):
   player dialogs (`AddPlayerDialog`/`AddPlayerForm`/`ImportPlayersDialog`) →
   `components/players`; `UnpaidBookingsCard` → `components/dashboard`; `AddSlotDialog`
   → `components/slots`; `BookForPlayerDialog`/`InlineBookPlayer`/`InlineEditBooking` →
   `components/booking`; `TrainerCalendarGrid` + `CalendarSlotCard` + `DayViewSlotCard`
   → `components/agenda`; `InvoiceEmailDialog` → `components/invoices`. Those neutral
   folders import **no** `components/trainer` anything.
2. **Parallel role variants that should share a base** — ~~`TrainerPlayerDetailsCard`
   vs `AcademyPlayerDetailsCard`~~ ✅ now share `components/players/PlayerDetailsCard`
   (+ `PlayerRemoveCard`), thin role wrappers injecting the role-specific writer/copy.
   **Still split:** `TrainerInvoiceSettingsCard` vs `AcademyInvoiceSettingsCard` (a
   shared `InvoiceSettingsCardBase` exists — finish routing both through it);
   `TrainerPageHeader` vs the generic `PageHeader`.
3. **Fat pages** — `EditProfile` (~1140 lines), `AcademyPlayers` (~1120),
   `TrainerPlayerDetail` (~1000) inline large amounts of JSX/logic that should be
   extracted into components. Extract opportunistically when you touch them.

> **Other guards (besides role isolation):** date fields must use
> `components/ui/date-input-field` (`DateInputField`), never a raw `<Input type="date">`
> — enforced by a `no-restricted-syntax` lint rule. List/table pages should use
> `components/ui/list-page-shell` (`ListPageShell` + `ListPageState`) — see
> UI_COMPONENT_STANDARDS.

## Relocating a shared component to a neutral folder (the recipe)

Debt #1 was burned all the way down with this recipe (baseline now 0). Reuse it for any
future relocation, and for finishing debt #2.

**Canonical role = academy.** Academy is the most-developed and most-tested surface, so
its behaviour is the source of truth. For a component academy already renders out of
`components/trainer`, **relocating it to a neutral folder is behaviour-preserving for
academy** (only the import path changes); trainer renders the same component, unchanged.

**Rules for each relocation slice**
- **Relocate as-is.** `git mv` the component to a neutral folder and repoint importers —
  do **not** generalise/rename in the same step (that's what risks changing academy).
  Generalisation, if ever needed, is a separate later PR.
- Move a component **with its cluster**: if it relatively-imports siblings, those move
  together. Type-only deps can instead repoint to the canonical type module (e.g.
  `BookedPlayer`/`SlotWithBookings` → `@/lib/slotTypes`), decoupling the consumer from
  the component entirely.
- A neutral folder is **unrestricted** by the role-isolation rule, so a moved component
  importing back into `components/trainer` won't fail lint — but it's a residual
  coupling. Move its trainer-side deps too (or repoint type-only ones to a `lib` module)
  so the neutral folder is genuinely trainer-free.
- After the move: `git add -A`, then **verify `git diff --cached --stat` shows the
  importer repoints — not just the `git mv` rename.** A partial `git add` that lists the
  pre-move path aborts and stages only the rename; the build passes locally (the repoints
  are still in your working tree) but `main` breaks. Then `npm run lint` →
  `npm run lint:prune` → `npm run build` → `npx tsc --noEmit` → `grep` that no
  `@/components/trainer` imports remain in the moved files' consumers.

**Remaining (debt #2):** route `Trainer/AcademyInvoiceSettingsCard` through the existing
`InvoiceSettingsCardBase` (academy canonical → trainer converges → needs trainer-side
testing). `AcademySidebar`/`AcademyLayout` vs the trainer equivalents are *legitimately*
role-specific chrome — leave them split.

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
