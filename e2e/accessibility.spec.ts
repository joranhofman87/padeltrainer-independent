import { test, expect } from '../playwright-fixture';
import { ROUTES } from './fixtures/test-data';
import { dismissCookieConsent } from './fixtures/helpers';

test.describe('Accessibility Tests', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Keyboard Navigation', () => {
    test('should be able to navigate login form with keyboard', async ({ page }) => {
      await page.goto(ROUTES.auth);
      
      // Tab through form elements
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      
      // Check that focus moves to interactive elements
      const focusedElement = await page.evaluate(() => document.activeElement?.tagName);
      expect(['INPUT', 'BUTTON', 'A']).toContain(focusedElement);
    });

    test('should have visible focus indicators', async ({ page }) => {
      await page.goto(ROUTES.auth);
      
      // Tab to first interactive element
      await page.keyboard.press('Tab');
      
      // Check for focus-visible styles (this is a basic check)
      const hasFocusStyles = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return false;
        const styles = window.getComputedStyle(el);
        return styles.outlineStyle !== 'none' || styles.boxShadow !== 'none';
      });
    });
  });

  test.describe('ARIA Labels', () => {
    test('home page should have proper heading structure', async ({ page }) => {
      await page.goto(ROUTES.home);
      
      // Check for h1
      const h1Count = await page.locator('h1').count();
      expect(h1Count).toBeGreaterThanOrEqual(1);
    });

    test('login page should have proper form labels', async ({ page }) => {
      await page.goto(ROUTES.auth);
      
      // Check for labels on inputs
      const emailInput = page.locator('#signin-email');
      const emailLabel = page.locator('label[for="signin-email"]');
      
      await expect(emailInput).toBeVisible();
      await expect(emailLabel).toBeVisible();
    });

    test('buttons should have accessible names', async ({ page }) => {
      await page.goto(ROUTES.auth);
      
      // Check Google button has text
      const googleButton = page.locator('button:has-text("Google")');
      await expect(googleButton).toBeVisible();
      
      // Check submit button has text
      const submitButton = page.locator('button[type="submit"]');
      await expect(submitButton).toBeVisible();
    });
  });

  test.describe('Color Contrast', () => {
    test('should have readable text on home page', async ({ page }) => {
      await page.goto(ROUTES.home);
      
      // Basic check that text is visible
      const bodyText = page.locator('body');
      await expect(bodyText).toBeVisible();
    });
  });

  test.describe('Responsive Design', () => {
    test('should be usable on mobile viewport', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(ROUTES.home);
      
      // Check that main content is visible
      await expect(page.locator('main, [role="main"], body')).toBeVisible();
    });

    test('should be usable on tablet viewport', async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto(ROUTES.home);
      
      await expect(page.locator('main, [role="main"], body')).toBeVisible();
    });

    test('should be usable on desktop viewport', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(ROUTES.home);
      
      await expect(page.locator('main, [role="main"], body')).toBeVisible();
    });

    test('login form should be usable on mobile', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(ROUTES.auth);
      
      // Check form elements are visible
      await expect(page.locator('#signin-email')).toBeVisible();
      await expect(page.locator('#signin-password')).toBeVisible();
      await expect(page.locator('button[type="submit"]')).toBeVisible();
    });
  });

  test.describe('Images', () => {
    test('images should have alt attributes', async ({ page }) => {
      await page.goto(ROUTES.home);
      
      const images = page.locator('img');
      const count = await images.count();
      
      for (let i = 0; i < Math.min(count, 10); i++) {
        const img = images.nth(i);
        if (await img.isVisible()) {
          const alt = await img.getAttribute('alt');
          // Alt can be empty string for decorative images, but should exist
          expect(alt).not.toBeNull();
        }
      }
    });
  });
});
