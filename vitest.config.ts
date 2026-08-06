import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Default 5000ms flakes under parallel pool load (e.g. AdminSidebar.test passes in
    // ~1.5s isolated but timed out at 5s in CI). Headroom keeps the go/no-go gate
    // deterministic.
    testTimeout: 15000,
    // The pglite suites' beforeAll hooks boot a WASM Postgres AND replay the real person-
    // unification migration chain (up to 7 files) — well past vitest's 10s default under CI
    // pool load, while finishing in ~2s locally. Same headroom rationale as testTimeout.
    hookTimeout: 30000,

    // ── DETERMINISM: the database suites do not share the machine with anything ──────────────
    //
    // 138 test files boot a database: 15 spin a real embedded Postgres (each its own server and
    // data directory) and 123 boot a WASM pglite. Run alongside the ~370 unit files they were
    // starving each other, and the full gate failed on a DIFFERENT file almost every run —
    // notificationDigestStateMachine's 100k-row plan assertion, invoiceSyncPaging's 1000-row page
    // cap, emailDeliverySuppression's backfill. Each passed alone. That is not "flakiness to
    // re-run", it is a gate that cannot tell a regression from a busy laptop, and a gate that
    // cannot do that is not a gate.
    //
    // So they are their own project, run with fileParallelism off, and `npm test` runs the two
    // projects as SEPARATE invocations (see package.json) so the pools cannot overlap at all.
    // Cost: the gate is slower. Worth it — a deterministic slow answer beats a fast maybe.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['**/*.realpg.test.ts', '**/*.pglite.test.ts',
                    'src/test/notificationDigestRealPg.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          include: ['src/**/*.realpg.test.ts', 'src/**/*.pglite.test.ts',
                    'src/test/notificationDigestRealPg.integration.test.ts'],
          // one database at a time. The whole point.
          fileParallelism: false,
          // a serialized suite boots ~138 databases back to back; the per-file work is unchanged
          // but a cold embedded-Postgres start is seconds, so the hook budget goes up with it.
          hookTimeout: 120000,
          testTimeout: 60000,
        },
      },
    ],
    // Hermetic Supabase env: the client module throws at import time without a
    // URL, and CI has no .env since it was untracked (ENV-01). Tests are fully
    // mocked and must never depend on a real project.
    env: {
      VITE_SUPABASE_URL: "https://test-project.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_dummy",
      VITE_SUPABASE_PROJECT_ID: "test-project",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
