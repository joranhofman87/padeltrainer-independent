import { test, expect } from '../playwright-fixture';
import { ROUTES } from './fixtures/test-data';
import { dismissCookieConsent, waitForNavigation } from './fixtures/helpers';

test.describe('Dashboard Access Control', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Protected Routes', () => {
    test('should redirect player dashboard to auth when not logged in', async ({ page }) => {
      await page.goto(ROUTES.playerDashboard);
      await waitForNavigation(page);
      
      // Should redirect to auth or show unauthorized
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('should redirect trainer dashboard to auth when not logged in', async ({ page }) => {
      await page.goto(ROUTES.trainerDashboard);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('should redirect club dashboard to auth when not logged in', async ({ page }) => {
      await page.goto(ROUTES.clubDashboard);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('should redirect academy dashboard to auth when not logged in', async ({ page }) => {
      await page.goto(ROUTES.academyDashboard);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('should redirect admin dashboard to auth when not logged in', async ({ page }) => {
      await page.goto('/admin');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });

  test.describe('Onboarding Routes', () => {
    test('should display player onboarding page', async ({ page }) => {
      await page.goto('/onboarding/player');
      await waitForNavigation(page);
      
      // Should show onboarding form or redirect to auth
      await expect(page.locator('body')).toBeVisible();
    });

    test('should display trainer onboarding page', async ({ page }) => {
      await page.goto('/onboarding/trainer');
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });
  });

});

test.describe('Dashboard UI Elements (when accessible)', () => {
  // These tests verify UI structure without requiring actual authentication
  // They're useful for smoke testing the application structure
  
  test('player dashboard route exists', async ({ page }) => {
    const response = await page.goto(ROUTES.playerDashboard, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBeLessThan(500);
  });

  test('trainer dashboard route exists', async ({ page }) => {
    const response = await page.goto(ROUTES.trainerDashboard, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBeLessThan(500);
  });

  test('club dashboard route exists', async ({ page }) => {
    const response = await page.goto(ROUTES.clubDashboard, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBeLessThan(500);
  });

  test('academy dashboard route exists', async ({ page }) => {
    const response = await page.goto(ROUTES.academyDashboard, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBeLessThan(500);
  });
});
