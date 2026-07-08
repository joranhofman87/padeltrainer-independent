import { defineConfig, devices } from '@playwright/test';

/**
 * LOCAL-stack E2E config (npm run e2e:local). Runs the e2e/local/** specs against the app in
 * `dev:e2e` mode, which loads .env.e2e → the local Supabase stack (supabase start). Kept separate
 * from playwright.config.ts so the shared/CI run (which targets remote) never touches these, and
 * these never accidentally hit production. Requires `supabase start` + `npm run db:seed:local`.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: 'e2e/local',
  testMatch: ['**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev:e2e',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
