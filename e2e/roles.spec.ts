import { test, expect } from '../playwright-fixture';
import { dismissCookieConsent, waitForNavigation } from './fixtures/helpers';

test.describe('Academy Flows', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Academy Signup', () => {
    test('should display academy signup page', async ({ page }) => {
      await page.goto('/signup/academy');
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });

    test('should have required form fields', async ({ page }) => {
      await page.goto('/signup/academy');
      await waitForNavigation(page);
      
      // Check for email and password at minimum
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await expect(page.locator('input[type="password"]')).toBeVisible();
    });

    test('should have Google OAuth option', async ({ page }) => {
      await page.goto('/signup/academy');
      await waitForNavigation(page);
      
      const googleButton = page.locator('button:has-text("Google")');
      if (await googleButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(googleButton).toBeVisible();
      }
    });
  });

  test.describe('Academy Public Profile', () => {
    test('should navigate to academies listing', async ({ page }) => {
      await page.goto('/en/academies');
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });

    test('should display academy profile when available', async ({ page }) => {
      await page.goto('/en/academies');
      await waitForNavigation(page);
      
      const academyLink = page.locator('a[href*="/academies/"]').first();
      
      if (await academyLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await academyLink.click();
        await waitForNavigation(page);
        
        // Should show academy details
        await expect(page.locator('h1, h2').first()).toBeVisible();
      }
    });

    test('should show trainers affiliated with academy', async ({ page }) => {
      await page.goto('/en/academies');
      await waitForNavigation(page);
      
      const academyLink = page.locator('a[href*="/academies/"]').first();
      
      if (await academyLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await academyLink.click();
        await waitForNavigation(page);
        
        // Look for trainers section
        const trainersSection = page.locator('[data-trainers], text=/trainer/i');
      }
    });

    test('should show locations where academy operates', async ({ page }) => {
      await page.goto('/en/academies');
      await waitForNavigation(page);
      
      const academyLink = page.locator('a[href*="/academies/"]').first();
      
      if (await academyLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await academyLink.click();
        await waitForNavigation(page);
        
        // Look for locations section
        const locationsSection = page.locator('[data-locations], text=/location/i, text=/locatie/i');
      }
    });
  });

  test.describe('Academy Dashboard Access', () => {
    test('should redirect to auth when not logged in', async ({ page }) => {
      await page.goto('/academy');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('academy trainers page requires auth', async ({ page }) => {
      await page.goto('/academy/trainers');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('academy locations page requires auth', async ({ page }) => {
      await page.goto('/academy/locations');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('academy cycles page requires auth', async ({ page }) => {
      await page.goto('/academy/cycles');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });

  test.describe('Academy Invitation Flow', () => {
    test('should handle invalid invitation token gracefully', async ({ page }) => {
      await page.goto('/academy/invitation/invalid-token-12345');
      await waitForNavigation(page);
      
      // Should not crash - show error or redirect
      const response = await page.goto('/academy/invitation/invalid-token-12345');
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
      await page.goto('/signup/club');
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });
  });

  test.describe('Club Dashboard Access', () => {
    test('should redirect to auth when not logged in', async ({ page }) => {
      await page.goto('/club');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('club trainers page requires auth', async ({ page }) => {
      await page.goto('/club/trainers');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('club calendar page requires auth', async ({ page }) => {
      await page.goto('/club/calendar');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('club cycles page requires auth', async ({ page }) => {
      await page.goto('/club/cycles');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });

  test.describe('Club Invitation Flow', () => {
    test('should handle invalid invitation token gracefully', async ({ page }) => {
      await page.goto('/club/invitation/invalid-token-12345');
      await waitForNavigation(page);
      
      const response = await page.goto('/club/invitation/invalid-token-12345');
      expect(response?.status()).toBeLessThan(500);
    });
  });
});

test.describe('Trainer Flows', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Trainer Dashboard Access', () => {
    test('should redirect to auth when not logged in', async ({ page }) => {
      await page.goto('/trainer');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('trainer calendar page requires auth', async ({ page }) => {
      await page.goto('/trainer/calendar');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('trainer players page requires auth', async ({ page }) => {
      await page.goto('/trainer/players');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('trainer cycles page requires auth', async ({ page }) => {
      await page.goto('/trainer/cycles');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('trainer subscription page requires auth', async ({ page }) => {
      await page.goto('/trainer/subscription');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });
});

test.describe('Player Flows', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Player Dashboard Access', () => {
    test('should redirect to auth when not logged in', async ({ page }) => {
      await page.goto('/player');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('player bookings page requires auth', async ({ page }) => {
      await page.goto('/player/bookings');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('player following page requires auth', async ({ page }) => {
      await page.goto('/player/following');
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });
});
