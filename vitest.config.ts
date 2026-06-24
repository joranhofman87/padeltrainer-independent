import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Default 5000ms flakes under parallel pool load (e.g. AdminSidebar.test passes in
    // ~1.5s isolated but timed out at 5s in CI). Headroom keeps the go/no-go gate
    // deterministic.
    testTimeout: 15000,
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
