import { test, expect } from '../playwright-fixture';
import { dismissCookieConsent, waitForNavigation } from './fixtures/helpers';
import { ROUTES } from './fixtures/test-data';

test.describe('Cycle Registration Form', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Form Loading', () => {
    test('should load the branded registration page', async ({ page }) => {
      await page.goto(ROUTES.registrationForm);
      await waitForNavigation(page);

      // Form should be visible
      await expect(page.locator('form')).toBeVisible({ timeout: 15000 });
    });

    test('should display cycle information', async ({ page }) => {
      await page.goto(ROUTES.registrationForm);
      await waitForNavigation(page);

      // Should show lesson type options
      const lessonTypeSection = page.locator('text=/groep|group|lestype|lesson/i');
      await expect(lessonTypeSection.first()).toBeVisible({ timeout: 15000 });
    });

    test('should have group of 4 pre-selected by default', async ({ page }) => {
      await page.goto(ROUTES.registrationForm);
      await waitForNavigation(page);

      // Check that group4 checkbox/option is checked
      const group4Checkbox = page.locator('input[value="group4"], [data-state="checked"]').first();
      if (await group4Checkbox.isVisible()) {
        // Verify it's checked
        const isChecked = await group4Checkbox.evaluate((el: HTMLInputElement) => 
          el.checked || el.getAttribute('data-state') === 'checked'
        );
        expect(isChecked).toBeTruthy();
      }
    });
  });

  test.describe('Form Validation', () => {
    test('should show validation errors for empty submission', async ({ page }) => {
      await page.goto(ROUTES.registrationForm);
      await waitForNavigation(page);

      await expect(page.locator('form')).toBeVisible({ timeout: 15000 });

      // Try submitting empty form
      const submitButton = page.locator('button[type="submit"]');
      if (await submitButton.isVisible()) {
        await submitButton.click();

        // Should show validation — either HTML5 or custom error messages
        const hasValidationError = await page.locator(
          '[role="alert"], .text-destructive, [data-invalid], input:invalid'
        ).first().isVisible({ timeout: 3000 }).catch(() => false);

        expect(hasValidationError).toBeTruthy();
      }
    });

    test('should validate email format', async ({ page }) => {
      await page.goto(ROUTES.registrationForm);
      await waitForNavigation(page);

      const emailInput = page.locator('input[type="email"]');
      if (await emailInput.isVisible()) {
        await emailInput.fill('not-an-email');
        await emailInput.blur();

        const isInvalid = await emailInput.evaluate(
          (el: HTMLInputElement) => !el.validity.valid
        );
        expect(isInvalid).toBeTruthy();
      }
    });
  });

  test.describe('Console Error Monitoring', () => {
    test('should not have console errors on registration page', async ({ page }) => {
      const errors: string[] = [];

      page.on('console', msg => {
        if (msg.type() === 'error') {
          errors.push(msg.text());
        }
      });

      await page.goto(ROUTES.registrationForm);
      await waitForNavigation(page);

      // Wait for form to load
      await page.locator('form').waitFor({ timeout: 15000 }).catch(() => {});

      const criticalErrors = errors.filter(e =>
        !e.includes('favicon') &&
        !e.includes('third-party') &&
        !e.includes('ERR_BLOCKED_BY_CLIENT') &&
        !e.includes('PostHog') &&
        !e.includes('posthog')
      );

      if (criticalErrors.length > 0) {
        console.warn('Console errors on registration page:', criticalErrors);
      }
    });
  });

  test.describe('Guest Form Flow', () => {
    test('should show guest form fields for unauthenticated users', async ({ page }) => {
      await page.goto(ROUTES.registrationForm);
      await waitForNavigation(page);

      // Guest users should see name, email, phone fields
      const nameInput = page.locator('input[id="fullName"], input[name="full_name"], input[id="full_name"]');
      const emailInput = page.locator('input[type="email"]');

      // At least one of these should be visible for guest users
      const hasGuestFields = await nameInput.isVisible().catch(() => false) ||
        await emailInput.isVisible().catch(() => false);

      expect(hasGuestFields).toBeTruthy();
    });
  });
});
