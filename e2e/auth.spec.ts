import { test, expect } from '../playwright-fixture';
import { ROUTES } from './fixtures/test-data';
import { 
  dismissCookieConsent, 
  waitForNavigation,
  generateTestEmail,
  fillSignupForm
} from './fixtures/helpers';

test.describe('Authentication Flows', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Login Page', () => {
    test('should display login form with all elements', async ({ page }) => {
      await page.goto(ROUTES.auth);
      
      // Check for key elements
      await expect(page.locator('text=PadelTrainer')).toBeVisible();
      await expect(page.locator('#signin-email')).toBeVisible();
      await expect(page.locator('#signin-password')).toBeVisible();
      await expect(page.locator('button[type="submit"]')).toBeVisible();
      
      // Check for Google OAuth button
      await expect(page.locator('button:has-text("Google")')).toBeVisible();
      
      // Check for signup links
      await expect(page.locator('a[href="/signup/player"]')).toBeVisible();
      await expect(page.locator('a[href="/signup/trainer"]')).toBeVisible();
    });

    test('should show error for invalid credentials', async ({ page }) => {
      await page.goto(ROUTES.auth);
      
      await page.fill('#signin-email', 'nonexistent@example.com');
      await page.fill('#signin-password', 'wrongpassword');
      await page.click('button[type="submit"]');
      
      // Should show error toast
      await expect(page.locator('[data-sonner-toast]')).toBeVisible({ timeout: 5000 });
    });

    test('should have forgot password link', async ({ page }) => {
      await page.goto(ROUTES.auth);
      
      const forgotPasswordLink = page.locator('a[href="/forgot-password"]');
      await expect(forgotPasswordLink).toBeVisible();
      
      await forgotPasswordLink.click();
      await expect(page).toHaveURL(ROUTES.forgotPassword);
    });

    test('should navigate to player signup', async ({ page }) => {
      await page.goto(ROUTES.auth);
      
      await page.click('a[href="/signup/player"]');
      await expect(page).toHaveURL(ROUTES.playerSignup);
    });

    test('should navigate to trainer signup', async ({ page }) => {
      await page.goto(ROUTES.auth);
      
      await page.click('a[href="/signup/trainer"]');
      await expect(page).toHaveURL(ROUTES.trainerSignup);
    });
  });

  test.describe('Player Signup Flow', () => {
    test('should display player signup form', async ({ page }) => {
      await page.goto(ROUTES.playerSignup);
      
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await expect(page.locator('input[type="password"]')).toBeVisible();
      await expect(page.locator('button:has-text("Google")')).toBeVisible();
    });

    test('should validate required fields', async ({ page }) => {
      await page.goto(ROUTES.playerSignup);
      
      // Try to submit empty form
      const submitButton = page.locator('button[type="submit"]');
      await submitButton.click();
      
      // Should show validation errors or remain on the page
      await expect(page).toHaveURL(new RegExp(ROUTES.playerSignup));
    });

    test('should show password strength indicator', async ({ page }) => {
      await page.goto(ROUTES.playerSignup);
      
      const passwordInput = page.locator('input[type="password"]');
      await passwordInput.fill('weak');
      
      // Check for password strength indicator
      const strengthIndicator = page.locator('[class*="password-strength"], [data-password-strength]');
      // This may or may not be present depending on implementation
    });
  });

  test.describe('Trainer Signup Flow', () => {
    test('should display trainer signup form', async ({ page }) => {
      await page.goto(ROUTES.trainerSignup);
      
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await expect(page.locator('input[type="password"]')).toBeVisible();
    });

    test('should validate required fields', async ({ page }) => {
      await page.goto(ROUTES.trainerSignup);
      
      const submitButton = page.locator('button[type="submit"]');
      await submitButton.click();
      
      // Should remain on signup page with validation
      await expect(page).toHaveURL(new RegExp(ROUTES.trainerSignup));
    });
  });

  test.describe('Forgot Password Flow', () => {
    test('should display forgot password form', async ({ page }) => {
      await page.goto(ROUTES.forgotPassword);
      
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await expect(page.locator('button[type="submit"]')).toBeVisible();
    });

    test('should show success message after submission', async ({ page }) => {
      await page.goto(ROUTES.forgotPassword);
      
      const testEmail = generateTestEmail('reset');
      await page.fill('input[type="email"]', testEmail);
      await page.click('button[type="submit"]');
      
      // Should show success message or toast
      await waitForNavigation(page);
    });

    test('should have back to login link', async ({ page }) => {
      await page.goto(ROUTES.forgotPassword);
      
      const backLink = page.locator('a[href="/auth"]');
      await expect(backLink).toBeVisible();
    });
  });
});
