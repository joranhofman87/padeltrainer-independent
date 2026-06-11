import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const localRules = require("./eslint-rules/index.cjs");

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
);
