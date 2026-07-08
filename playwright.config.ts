import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  // Discover Playwright specs in both ./e2e and ./tests. Previously testDir was
  // './tests', so the CI commands that pass explicit e2e/*.spec.ts paths matched
  // ZERO tests (silent no-op). testMatch scopes discovery to those two dirs so
  // the vitest unit tests under src/ are never picked up.
  testDir: '.',
  testMatch: ['e2e/**/*.spec.ts', 'tests/**/*.spec.ts'],
  // e2e/local/** are LOCAL-stack specs (need `supabase start` + seed) — never run them in the
  // default/CI run (which targets remote). They have their own config: playwright.local.config.ts.
  testIgnore: ['**/e2e/local/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
