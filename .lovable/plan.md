# A11y cleanup (items 19–21)

## #19 — 195 icon-only buttons missing `aria-label`

Two-track approach: enforce going forward, fix the worst offenders now.

**Track A: ESLint rule (build-time guarantee)**
- Add a local ESLint plugin at `eslint-rules/button-icon-aria-label.js`. Custom rule that flags any JSX `<Button …>` (or aliased import) where:
  - `size="icon"` is set, AND
  - none of `aria-label`, `aria-labelledby`, `title` is set, AND
  - the button has no readable text child (only an icon component / SVG).
- Wire into `eslint.config.js`: register the local plugin, set rule to `error`. Build will fail on regressions.
- Also extend the rule to catch `IconButton` / `<button …>` usages with the same heuristic so we don't just push the violations one level down.

**Track B: First-wave fixes (manual, the patterns that repeat hundreds of times)**

195 violations cluster into ~5 patterns. Fix the patterns, not the file list.

1. Back-arrow header buttons (~80 instances): `<Button variant="ghost" size="icon" onClick={() => navigate(-1 | "/trainer" | …)}><ArrowLeft …/></Button>`. Add `aria-label={t('common.back')}`. Add the `common.back` key to `en.json` if not present, mirror to nl/de/fr/es/it.
2. Calendar prev/next chevrons (~30 instances). `aria-label={t('common.previous')}` / `t('common.next')`.
3. Close (X) buttons in dialogs/sheets/banners that don't already use the shadcn `<DialogClose>` (which already labels itself). `aria-label={t('common.close')}`.
4. Row-action menu triggers (`<MoreVertical />`, `<MoreHorizontal />`): `aria-label={t('common.actions')}`.
5. Add/remove row buttons (the `<Plus />` / `<Minus />` / `<Trash2 />` in editors): `aria-label={t('common.add')}` / `t('common.remove')` / `t('common.delete')`.

After the wave, run `bun run lint` — if any violations remain (one-offs that don't fit the patterns), fix them inline. Then the rule stays at `error`.

**Out of scope:** retrofitting `aria-label` for non-icon buttons that happen to wrap only an icon (a separate, smaller cleanup); changing button visuals.

## #20 — Missing alt attribute on `<img>`

Only one offender currently:
- `src/pages/TrainerProfile.tsx:535` — academy logo `<img>` with no `alt`. Set `alt={trainerAcademy.name || ''}`.

Also worth a tiny preventive add: an ESLint rule via `eslint-plugin-jsx-a11y` (`alt-text`). Lighter than writing it ourselves. Add `eslint-plugin-jsx-a11y` and turn on `jsx-a11y/alt-text` plus `jsx-a11y/anchor-has-content` (and report-only on the rest of `recommended` so we don't drown in warnings on day one).

## #21 — Axe accessibility tests on top routes

- Install `@axe-core/playwright`.
- Extend `e2e/accessibility.spec.ts` with a new `Axe Audit` block that loops the top 10 public routes and runs `AxeBuilder({ page }).withTags(['wcag2a','wcag2aa']).analyze()`. Fail on any `serious`/`critical` violation; allow `moderate`/`minor` to surface as warnings (logged, not failing) for now to keep CI green while we burn down the backlog.
- Top 10 routes (from `e2e/fixtures/test-data.ts` ROUTES + most-trafficked marketing pages): `/`, `/trainers`, `/locations`, `/academies`, `/blog`, `/pricing`, `/about`, `/learn`, `/playground`, `/auth`. Confirm exact list against `ROUTES` during implementation.
- Skip authenticated routes for now — they need fixture login, deferred to a follow-up.

## Order

1. #20 — one-line fix + plugin install.
2. #21 — install + spec extension; gives us a measuring tape.
3. #19 — ESLint rule; then first-wave fixes; then flip rule to `error`.

## Open question

For the i18n keys used in #19 (`common.back`, `common.previous`, `common.next`, `common.close`, `common.actions`, `common.add`, `common.remove`, `common.delete`): these likely already exist in EN — we'll reuse if so. If any are missing in non-en locales, the i18n parity check (added in the previous round) will flag them; we'll add the missing translations as part of this change. Confirming you're OK with that approach (no separate "translate everything" step).
