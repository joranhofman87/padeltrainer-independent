import { Page, expect } from '@playwright/test';
import { ROUTES } from './test-data';

/**
 * Helper function to wait for navigation to complete
 */
export async function waitForNavigation(page: Page, timeout = 10000) {
  await page.waitForLoadState('networkidle', { timeout });
}

/**
 * Helper to fill login form and submit
 */
export async function login(page: Page, email: string, password: string) {
  await page.goto(ROUTES.auth);
  await page.waitForSelector('#signin-email');

  await page.fill('#signin-email', email);
  await page.fill('#signin-password', password);
  await page.click('button[type="submit"]');

  await waitForNavigation(page);
}

/**
 * Helper to fill signup form
 */
export async function fillSignupForm(
  page: Page,
  fullName: string,
  email: string,
  password: string,
  phone?: string
) {
  await page.fill('input[id="fullName"], input[name="fullName"]', fullName);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  if (phone) {
    const phoneInput = page.locator('input[type="tel"], input[id="phone"]');
    if (await phoneInput.isVisible()) {
      await phoneInput.fill(phone);
    }
  }
}

/**
 * Helper to check if element contains text
 */
export async function expectTextContent(page: Page, selector: string, text: string) {
  await expect(page.locator(selector)).toContainText(text);
}

/**
 * Helper to click and wait for navigation
 */
export async function clickAndWait(page: Page, selector: string) {
  await page.click(selector);
  await waitForNavigation(page);
}

/**
 * Helper to check if user is redirected to a dashboard
 */
export async function expectDashboardRedirect(page: Page, role: 'player' | 'trainer' | 'club' | 'academy' | 'admin') {
  const dashboardRoutes = {
    player: '/app/player',
    trainer: '/app/trainer',
    club: '/app/club',
    academy: '/app/academy',
    admin: '/app/admin',
  };

  await expect(page).toHaveURL(new RegExp(dashboardRoutes[role]));
}

/**
 * Helper to dismiss cookie consent if present (no-op since cookie banner was removed)
 */
export async function dismissCookieConsent(_page: Page) {
  // Cookie consent banner has been removed (cookieless PostHog).
  // Kept as a no-op so existing tests don't break.
}

/**
 * Helper to wait for toast notification
 */
export async function expectToast(page: Page, message: string) {
  await expect(page.locator('[data-sonner-toast]')).toContainText(message, { timeout: 5000 });
}

/**
 * Generate unique email for tests
 */
export function generateTestEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(7)}@test.example.com`;
}
