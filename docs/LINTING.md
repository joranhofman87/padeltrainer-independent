# Linting & the shrink-only baseline

ESLint runs in CI (`.github/workflows/test.yml` → `lint` job) and is a hard gate.
Every rule is an **error**. To keep the build green while a large pre-existing
debt is paid down gradually, the historical violations are captured in
**`eslint-suppressions.json`** — a *baseline* that can only shrink.

## What this means day to day

| You do… | Result |
| --- | --- |
| Write code with a **new** lint violation | ❌ CI fails — fix it. |
| **Fix** a violation that's in the baseline | ❌ CI fails with "unused suppressions" until you prune (see below). |
| Touch a file but leave its suppressed debt | ✅ Fine — baseline unchanged. |

The asymmetry is the point: new debt is blocked, old debt only decreases.

## Commands

```bash
npm run lint          # what CI runs — fails on new violations or stale suppressions
npm run lint:fix      # auto-fix the autofixable rules
npm run lint:prune    # after fixing baseline violations: rewrite the baseline smaller, then commit it
```

Typical fix flow:

```bash
# 1. remove some `any`s / fix an effect's deps in a file
npm run lint:prune    # shrinks eslint-suppressions.json to match
git add -p eslint-suppressions.json <your files>
git commit
```

## The baseline today

`eslint-suppressions.json` holds three categories (all being paid down):

- `@typescript-eslint/no-explicit-any` — replace `any` with real types.
- `react-hooks/exhaustive-deps` — add the missing dep, or `// eslint-disable-next-line`
  **with a one-line reason** if the omission is deliberate (e.g. run-once effects).
- `react-refresh/only-export-components` — move non-component exports to their own module.

Everything else (unused vars, empty blocks, a11y on icon buttons, etc.) is already
at zero and stays there because the rules are errors with no suppressions.

## Regenerating (rare)

If the baseline ever gets out of sync, `npm run lint:baseline` re-captures the
current state. Only do this intentionally — it can *grow* the baseline, which
defeats the ratchet. Prefer `lint:prune`.
