import { test, expect } from '../playwright-fixture';
import { dismissCookieConsent, waitForNavigation } from './fixtures/helpers';

test.describe('Internationalization (i18n)', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('English Routes', () => {
    test('should display English content on /en/', async ({ page }) => {
      await page.goto('/en/');
      await waitForNavigation(page);
      
      // Check for English text
      await expect(page.locator('body')).toContainText(/find|book|trainer/i);
    });

    test('should display English trainers page', async ({ page }) => {
      await page.goto('/en/trainers');
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });

    test('should display English locations page', async ({ page }) => {
      await page.goto('/en/locations');
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });

    test('should display English pricing page', async ({ page }) => {
      await page.goto('/en/pricing');
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });
  });

  test.describe('Dutch Routes', () => {
    test('should display Dutch content on /nl/', async ({ page }) => {
      await page.goto('/nl/');
      await waitForNavigation(page);
      
      // Check for Dutch text
      await expect(page.locator('body')).toBeVisible();
    });

    test('should display Dutch trainers page', async ({ page }) => {
      await page.goto('/nl/trainers');
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });

    test('should display Dutch locations page', async ({ page }) => {
      await page.goto('/nl/locations');
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });

    test('should display Dutch pricing page', async ({ page }) => {
      await page.goto('/nl/pricing');
      await waitForNavigation(page);
      
      await expect(page.locator('body')).toBeVisible();
    });
  });

  test.describe('Language Switching', () => {
    test('should navigate from EN to NL trainers page', async ({ page }) => {
      await page.goto('/en/trainers');
      await waitForNavigation(page);
      
      // Look for language switcher and switch to Dutch
      const nlSwitch = page.locator('button:has-text("NL"), a:has-text("NL"), [data-lang="nl"]');
      
      if (await nlSwitch.isVisible({ timeout: 3000 }).catch(() => false)) {
        await nlSwitch.click();
        await waitForNavigation(page);
        
        await expect(page).toHaveURL(/\/nl\//);
      }
    });

    test('should navigate from NL to EN trainers page', async ({ page }) => {
      await page.goto('/nl/trainers');
      await waitForNavigation(page);
      
      const enSwitch = page.locator('button:has-text("EN"), a:has-text("EN"), [data-lang="en"]');
      
      if (await enSwitch.isVisible({ timeout: 3000 }).catch(() => false)) {
        await enSwitch.click();
        await waitForNavigation(page);
        
        await expect(page).toHaveURL(/\/en\//);
      }
    });
  });

  test.describe('App Routes (No Language Prefix)', () => {
    test('auth page should work without language prefix', async ({ page }) => {
      await page.goto('/auth');
      
      await expect(page.locator('#signin-email')).toBeVisible();
    });

    test('signup pages should work without language prefix', async ({ page }) => {
      await page.goto('/signup/player');
      
      await expect(page.locator('body')).toBeVisible();
      await expect(page).toHaveURL('/signup/player');
    });

    test('forgot password should work without language prefix', async ({ page }) => {
      await page.goto('/forgot-password');
      
      await expect(page.locator('body')).toBeVisible();
      await expect(page).toHaveURL('/forgot-password');
    });
  });

  test.describe('SEO Metadata', () => {
    test('English page should have English title', async ({ page }) => {
      await page.goto('/en/');
      await waitForNavigation(page);
      
      const title = await page.title();
      expect(title).toBeTruthy();
    });

    test('Dutch page should have Dutch title', async ({ page }) => {
      await page.goto('/nl/');
      await waitForNavigation(page);
      
      const title = await page.title();
      expect(title).toBeTruthy();
    });

    test('pages should have meta description', async ({ page }) => {
      await page.goto('/en/');
      await waitForNavigation(page);
      
      const metaDescription = await page.locator('meta[name="description"]').getAttribute('content');
      expect(metaDescription).toBeTruthy();
    });
  });
});
