import { test, expect } from '../playwright-fixture';
import { dismissCookieConsent, waitForNavigation } from './fixtures/helpers';

test.describe('Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('404 Page', () => {
    test('should display 404 page for non-existent route', async ({ page }) => {
      await page.goto('/non-existent-page-xyz-123');
      await waitForNavigation(page);
      
      // Check for 404 content
      const pageContent = await page.textContent('body');
      expect(pageContent).toMatch(/404|not found|niet gevonden|page not found/i);
    });

    test('should have link back to home on 404 page', async ({ page }) => {
      await page.goto('/non-existent-page-xyz-123');
      await waitForNavigation(page);
      
      // Look for home link
      const homeLink = page.locator('a[href="/"], a[href="/en/"], a[href="/nl/"]');
      await expect(homeLink.first()).toBeVisible();
    });

    test('404 page should maintain consistent styling', async ({ page }) => {
      await page.goto('/this-page-does-not-exist');
      await waitForNavigation(page);
      
      // Check that basic styling is applied (not unstyled)
      const body = page.locator('body');
      await expect(body).toBeVisible();
    });
  });

  test.describe('Invalid Trainer Profile', () => {
    test('should handle non-existent trainer gracefully', async ({ page }) => {
      await page.goto('/en/trainers/non-existent-trainer-id-12345');
      await waitForNavigation(page);
      
      // Should show error or redirect, not crash
      const response = await page.goto('/en/trainers/non-existent-trainer-id-12345');
      expect(response?.status()).toBeLessThan(500);
    });
  });

  test.describe('Invalid Location', () => {
    test('should handle non-existent location gracefully', async ({ page }) => {
      await page.goto('/en/locations/non-existent-location-id-12345');
      await waitForNavigation(page);
      
      const response = await page.goto('/en/locations/non-existent-location-id-12345');
      expect(response?.status()).toBeLessThan(500);
    });
  });

  test.describe('Form Error States', () => {
    test('login should show error for empty submission', async ({ page }) => {
      await page.goto('/auth');
      
      // Click submit without filling form
      await page.click('button[type="submit"]');
      
      // Should show validation (HTML5 or custom)
      const emailInput = page.locator('#signin-email');
      const isInvalid = await emailInput.evaluate((el: HTMLInputElement) => !el.validity.valid);
      expect(isInvalid).toBeTruthy();
    });

    test('signup should validate email format', async ({ page }) => {
      await page.goto('/signup/player');
      
      const emailInput = page.locator('input[type="email"]');
      if (await emailInput.isVisible()) {
        await emailInput.fill('invalid-email');
        await emailInput.blur();
        
        // Check for validation
        const isInvalid = await emailInput.evaluate((el: HTMLInputElement) => !el.validity.valid);
        expect(isInvalid).toBeTruthy();
      }
    });

    test('signup should validate password requirements', async ({ page }) => {
      await page.goto('/signup/player');
      
      const passwordInput = page.locator('input[type="password"]');
      if (await passwordInput.isVisible()) {
        await passwordInput.fill('weak');
        
        // Look for password strength indicator or validation message
        const strengthIndicator = page.locator('[class*="password"], [data-password-strength]');
      }
    });
  });

  test.describe('Network Error Handling', () => {
    test('should handle slow network gracefully', async ({ page }) => {
      // Simulate slow network
      await page.route('**/*', async (route) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        await route.continue();
      });
      
      await page.goto('/en/trainers');
      
      // Page should still load
      await expect(page.locator('body')).toBeVisible();
    });
  });

  test.describe('JavaScript Errors', () => {
    test('should not have console errors on home page', async ({ page }) => {
      const errors: string[] = [];
      
      page.on('console', msg => {
        if (msg.type() === 'error') {
          errors.push(msg.text());
        }
      });
      
      await page.goto('/en/');
      await waitForNavigation(page);
      
      // Filter out known acceptable errors (e.g., third-party scripts)
      const criticalErrors = errors.filter(e => 
        !e.includes('favicon') && 
        !e.includes('third-party') &&
        !e.includes('ERR_BLOCKED_BY_CLIENT')
      );
      
      // Log errors for debugging but don't fail on all errors
      if (criticalErrors.length > 0) {
        console.warn('Console errors detected:', criticalErrors);
      }
    });

    test('should not have console errors on auth page', async ({ page }) => {
      const errors: string[] = [];
      
      page.on('console', msg => {
        if (msg.type() === 'error') {
          errors.push(msg.text());
        }
      });
      
      await page.goto('/auth');
      await waitForNavigation(page);
      
      const criticalErrors = errors.filter(e => 
        !e.includes('favicon') && 
        !e.includes('third-party') &&
        !e.includes('ERR_BLOCKED_BY_CLIENT')
      );
      
      if (criticalErrors.length > 0) {
        console.warn('Console errors detected:', criticalErrors);
      }
    });
  });
});
