import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const localRules = require("./eslint-rules/index.js");

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
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
      }],
      // a11y — keep narrow & noisy-rule-free for now; expand over time.
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/anchor-has-content": "warn",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-role": "error",
      // Custom: icon-only Buttons must have aria-label.
      // Start as 'warn' so the existing 195 occurrences don't break the build;
      // flip to 'error' once the backlog is burned down.
      "local/button-icon-aria-label": "warn",
    },
  },
);
