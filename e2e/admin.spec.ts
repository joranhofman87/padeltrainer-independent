import { test, expect } from '../playwright-fixture';
import { dismissCookieConsent, waitForNavigation } from './fixtures/helpers';
import { ROUTES, ADMIN_ROUTES } from './fixtures/test-data';

test.describe('Admin Panel', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Admin Access Control', () => {
    test('should redirect to auth when not logged in', async ({ page }) => {
      await page.goto(ROUTES.admin);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });

    test('all admin routes should redirect to auth when not logged in', async ({ page }) => {
      for (const route of ADMIN_ROUTES) {
        await page.goto(route);
        await waitForNavigation(page);
        
        const currentUrl = page.url();
        expect(currentUrl).toMatch(/auth|login|unauthorized/i);
      }
    });

    test('admin routes should not return 500 errors', async ({ page }) => {
      for (const route of ADMIN_ROUTES) {
        const response = await page.goto(route);
        expect(response?.status()).toBeLessThan(500);
      }
    });
  });

  test.describe('Admin Users Page', () => {
    test('users page requires auth', async ({ page }) => {
      await page.goto(ROUTES.adminUsers);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });

  test.describe('Admin Trainers Page', () => {
    test('trainers page requires auth', async ({ page }) => {
      await page.goto(ROUTES.adminTrainers);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });

  test.describe('Admin Clubs Page', () => {
    test('clubs page requires auth', async ({ page }) => {
      await page.goto(ROUTES.adminClubs);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });

  test.describe('Admin Academies Page', () => {
    test('academies page requires auth', async ({ page }) => {
      await page.goto(ROUTES.adminAcademies);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });

  test.describe('Admin Locations Page', () => {
    test('locations page requires auth', async ({ page }) => {
      await page.goto(ROUTES.adminLocations);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });

  test.describe('Admin Certifications Page', () => {
    test('certifications page requires auth', async ({ page }) => {
      await page.goto(ROUTES.adminCertifications);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });

  test.describe('Admin Club Claims Page', () => {
    test('club claims page requires auth', async ({ page }) => {
      await page.goto(ROUTES.adminClubClaims);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });

  test.describe('Admin Pricing Page', () => {
    test('pricing page requires auth', async ({ page }) => {
      await page.goto(ROUTES.adminPricing);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });

  test.describe('Admin Rating Systems Page', () => {
    test('rating systems page requires auth', async ({ page }) => {
      await page.goto(ROUTES.adminRatingSystems);
      await waitForNavigation(page);
      
      const currentUrl = page.url();
      expect(currentUrl).toMatch(/auth|login|unauthorized/i);
    });
  });
});
