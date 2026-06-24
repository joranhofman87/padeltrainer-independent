import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const localRules = require("./eslint-rules/index.cjs");

// Role-isolation guardrail (see docs/FRONTEND_ARCHITECTURE.md). A role's
// components/pages must NOT import another role's components/pages directly —
// that coupling makes one role's UI silently depend on another's internals and
// is the #1 thing that breaks when an AI edits a single role page. Shared code
// must live in a neutral home (components/ui, components/slots, components/invoices,
// components/players, components/cycles, …), hooks/, or lib/, which are never
// restricted. `players` (plural, shared) is intentionally NOT restricted — only
// `player` (singular, the role) is.
const roleIsolation = (forbidden) => ({
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: forbidden,
          message:
            "Role isolation: don't import another role's components/pages. Lift shared code to a neutral folder (components/ui, components/slots, …), hooks/, or lib/. See docs/FRONTEND_ARCHITECTURE.md.",
        },
      ],
    },
  ],
});

export default tseslint.config(
  { ignores: ["dist", "eslint-rules/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "jsx-a11y": jsxA11y,
      local: localRules,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Every rule below is an error and gated in CI. Pre-existing violations
      // of no-explicit-any / exhaustive-deps / only-export-components are
      // captured in eslint-suppressions.json (a shrink-only baseline) so the
      // build is green today while NEW violations fail. When you fix a
      // suppressed issue, run `npm run lint:prune` and commit the smaller
      // baseline. See CONTRIBUTING / package.json lint scripts.
      "react-hooks/exhaustive-deps": "error",
      "react-refresh/only-export-components": ["error", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
      }],
      // a11y — these categories are fully cleared, so they stay at zero as errors.
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/anchor-has-content": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-role": "error",
      // Custom: icon-only Buttons must have aria-label. Backlog burned down to 0,
      // so this is now an error to keep it there.
      "local/button-icon-aria-label": "error",
    },
  },
  // ── Role-isolation overrides ──────────────────────────────────────────────
  // Each role may import shared/neutral code freely; it may NOT reach into
  // another role's component or page folder. Enforced as an error (CI-gated).
  {
    files: ["src/components/academy/**", "src/pages/academy/**"],
    rules: roleIsolation([
      "@/components/trainer/**", "@/components/club/**", "@/components/player/**",
      "@/pages/trainer/**", "@/pages/club/**",
    ]),
  },
  {
    files: ["src/components/trainer/**", "src/pages/trainer/**"],
    rules: roleIsolation([
      "@/components/academy/**", "@/components/club/**", "@/components/player/**",
      "@/pages/academy/**", "@/pages/club/**",
    ]),
  },
  {
    files: ["src/components/club/**", "src/pages/club/**"],
    rules: roleIsolation([
      "@/components/trainer/**", "@/components/academy/**", "@/components/player/**",
      "@/pages/trainer/**", "@/pages/academy/**",
    ]),
  },
  {
    // Player role has no dedicated pages/ folder (player pages live at src/pages root).
    files: ["src/components/player/**"],
    rules: roleIsolation([
      "@/components/trainer/**", "@/components/academy/**", "@/components/club/**",
      "@/pages/trainer/**", "@/pages/academy/**", "@/pages/club/**",
    ]),
  },
);
