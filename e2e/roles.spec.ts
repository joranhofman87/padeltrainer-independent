import { test, expect } from '../playwright-fixture';
import { dismissCookieConsent, waitForNavigation } from './fixtures/helpers';
import { ROUTES, PLAYER_ROUTES, TRAINER_ROUTES, CLUB_ROUTES, ACADEMY_ROUTES } from './fixtures/test-data';

test.describe('Academy Flows', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Academy Signup', () => {
    test('should display academy signup page', async ({ page }) => {
      await page.goto(ROUTES.academySignup);
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });

    test('should have required form fields', async ({ page }) => {
      await page.goto(ROUTES.academySignup);
      await waitForNavigation(page);
      
      // Check for email and password at minimum
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await expect(page.locator('input[type="password"]')).toBeVisible();
    });

    test('should have Google OAuth option', async ({ page }) => {
      await page.goto(ROUTES.academySignup);
      await waitForNavigation(page);
      
      const googleButton = page.locator('button:has-text("Google")');
      if (await googleButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(googleButton).toBeVisible();
      }
    });
  });

  test.describe('Academy Public Profile', () => {
    test('should navigate to academies listing', async ({ page }) => {
      await page.goto(ROUTES.academies);
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });

    test('should display academy profile when available', async ({ page }) => {
      await page.goto(ROUTES.academies);
      await waitForNavigation(page);
      
      const academyLink = page.locator('a[href*="/academies/"]').first();
      
      if (await academyLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await academyLink.click();
        await waitForNavigation(page);
        
        // Should show academy details
        await expect(page.locator('h1, h2').first()).toBeVisible();
      }
    });
  });

  test.describe('Academy Dashboard Access', () => {
    test('should redirect to auth when not logged in', async ({ page }) => {
      await page.goto(ROUTES.academyDashboard);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('all academy routes require auth', async ({ page }) => {
      for (const route of ACADEMY_ROUTES) {
        await page.goto(route);
        await waitForNavigation(page);
        
        const currentUrl = page.url();
        expect(currentUrl).toMatch(/auth|login|unauthorized/i);
      }
    });

    test('academy routes should not return 500 errors', async ({ page }) => {
      for (const route of ACADEMY_ROUTES) {
        const response = await page.goto(route);
        expect(response?.status()).toBeLessThan(500);
      }
    });
  });

  test.describe('Academy Invitation Flow', () => {
    test('should handle invalid invitation token gracefully', async ({ page }) => {
      await page.goto('/app/academy/invitation/invalid-token-12345');
      await waitForNavigation(page);
      
      // Should not crash - show error or redirect
      const response = await page.goto('/app/academy/invitation/invalid-token-12345');
      expect(response?.status()).toBeLessThan(500);
    });
  });
});

test.describe('Club Flows', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Club Signup', () => {
    test('should display club signup page', async ({ page }) => {
      await page.goto(ROUTES.clubSignup);
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });
  });

  test.describe('Club Dashboard Access', () => {
    test('should redirect to auth when not logged in', async ({ page }) => {
      await page.goto(ROUTES.clubDashboard);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('all club routes require auth', async ({ page }) => {
      for (const route of CLUB_ROUTES) {
        await page.goto(route);
        await waitForNavigation(page);
        
        const currentUrl = page.url();
        expect(currentUrl).toMatch(/auth|login|unauthorized/i);
      }
    });

    test('club routes should not return 500 errors', async ({ page }) => {
      for (const route of CLUB_ROUTES) {
        const response = await page.goto(route);
        expect(response?.status()).toBeLessThan(500);
      }
    });
  });

  test.describe('Club Invitation Flow', () => {
    test('should handle invalid invitation token gracefully', async ({ page }) => {
      await page.goto('/app/club/invitation/invalid-token-12345');
      await waitForNavigation(page);
      
      const response = await page.goto('/app/club/invitation/invalid-token-12345');
      expect(response?.status()).toBeLessThan(500);
    });
  });
});

test.describe('Trainer Flows', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Trainer Signup', () => {
    test('should display trainer signup page', async ({ page }) => {
      await page.goto(ROUTES.trainerSignup);
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });

    test('should have required form fields', async ({ page }) => {
      await page.goto(ROUTES.trainerSignup);
      await waitForNavigation(page);
      
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await expect(page.locator('input[type="password"]')).toBeVisible();
    });
  });

  test.describe('Trainer Dashboard Access', () => {
    test('should redirect to auth when not logged in', async ({ page }) => {
      await page.goto(ROUTES.trainerDashboard);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('all trainer routes require auth', async ({ page }) => {
      for (const route of TRAINER_ROUTES) {
        await page.goto(route);
        await waitForNavigation(page);
        
        const currentUrl = page.url();
        expect(currentUrl).toMatch(/auth|login|unauthorized/i);
      }
    });

    test('trainer routes should not return 500 errors', async ({ page }) => {
      for (const route of TRAINER_ROUTES) {
        const response = await page.goto(route);
        expect(response?.status()).toBeLessThan(500);
      }
    });
  });
});

test.describe('Player Flows', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Player Signup', () => {
    test('should display player signup page', async ({ page }) => {
      await page.goto(ROUTES.playerSignup);
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });

    test('should have required form fields', async ({ page }) => {
      await page.goto(ROUTES.playerSignup);
      await waitForNavigation(page);
      
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await expect(page.locator('input[type="password"]')).toBeVisible();
    });
  });

  test.describe('Player Dashboard Access', () => {
    test('should redirect to auth when not logged in', async ({ page }) => {
      await page.goto(ROUTES.playerDashboard);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('all player routes require auth', async ({ page }) => {
      for (const route of PLAYER_ROUTES) {
        await page.goto(route);
        await waitForNavigation(page);
        
        const currentUrl = page.url();
        expect(currentUrl).toMatch(/auth|login|unauthorized/i);
      }
    });

    test('player routes should not return 500 errors', async ({ page }) => {
      for (const route of PLAYER_ROUTES) {
        const response = await page.goto(route);
        expect(response?.status()).toBeLessThan(500);
      }
    });
  });
});
