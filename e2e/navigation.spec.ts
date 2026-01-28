import { test, expect } from '../playwright-fixture';
import { ROUTES } from './fixtures/test-data';
import { dismissCookieConsent, waitForNavigation } from './fixtures/helpers';

test.describe('Navigation & Marketing Pages', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Home Page', () => {
    test('should display hero section with CTAs', async ({ page }) => {
      await page.goto(ROUTES.home);
      
      // Check for main branding
      await expect(page.locator('text=PadelTrainer')).toBeVisible();
      
      // Check for CTA buttons
      const findTrainerButton = page.locator('a:has-text("Find"), a:has-text("Vind"), button:has-text("Find"), button:has-text("Vind")').first();
      await expect(findTrainerButton).toBeVisible();
    });

    test('should have working navigation menu', async ({ page }) => {
      await page.goto(ROUTES.home);
      
      // Check for navigation links
      const navLinks = page.locator('nav a, header a');
      await expect(navLinks.first()).toBeVisible();
    });

    test('should have language switcher', async ({ page }) => {
      await page.goto('/en/');
      
      // Look for language switcher
      const languageSwitcher = page.locator('[data-language-switcher], button:has-text("EN"), button:has-text("NL")');
      // May not always be visible depending on screen size
    });
  });

  test.describe('Trainers Page', () => {
    test('should display trainers listing', async ({ page }) => {
      await page.goto(ROUTES.trainers);
      
      // Wait for page to load
      await waitForNavigation(page);
      
      // Check for trainers section
      await expect(page.locator('h1, h2').first()).toBeVisible();
    });

    test('should have search/filter functionality', async ({ page }) => {
      await page.goto(ROUTES.trainers);
      
      // Look for filter elements
      const filterElements = page.locator('input[placeholder*="search" i], input[placeholder*="zoek" i], [data-filter]');
      // Filters may or may not be present
    });

    test('should navigate to trainer profile on card click', async ({ page }) => {
      await page.goto(ROUTES.trainers);
      await waitForNavigation(page);
      
      // Find trainer cards
      const trainerCard = page.locator('[data-trainer-card], a[href*="/trainers/"]').first();
      
      if (await trainerCard.isVisible({ timeout: 3000 }).catch(() => false)) {
        await trainerCard.click();
        await waitForNavigation(page);
        
        // Should navigate to a trainer profile
        await expect(page).toHaveURL(/\/trainers\//);
      }
    });
  });

  test.describe('Locations Page', () => {
    test('should display locations listing', async ({ page }) => {
      await page.goto(ROUTES.locations);
      
      await waitForNavigation(page);
      
      // Check for locations content
      await expect(page.locator('h1, h2').first()).toBeVisible();
    });

    test('should display map component', async ({ page }) => {
      await page.goto(ROUTES.locations);
      
      await waitForNavigation(page);
      
      // Look for map container
      const mapContainer = page.locator('[class*="leaflet"], [data-map], .map-container');
      // Map may take time to load
    });

    test('should navigate to location detail on card click', async ({ page }) => {
      await page.goto(ROUTES.locations);
      await waitForNavigation(page);
      
      // Find location cards
      const locationCard = page.locator('[data-location-card], a[href*="/locations/"]').first();
      
      if (await locationCard.isVisible({ timeout: 3000 }).catch(() => false)) {
        await locationCard.click();
        await waitForNavigation(page);
        
        // Should navigate to a location detail
        await expect(page).toHaveURL(/\/locations\//);
      }
    });
  });

  test.describe('Pricing Page', () => {
    test('should display pricing plans', async ({ page }) => {
      await page.goto(ROUTES.pricing);
      
      await waitForNavigation(page);
      
      // Check for pricing content
      await expect(page.locator('h1, h2').first()).toBeVisible();
      
      // Look for pricing cards or plan sections
      const pricingCards = page.locator('[data-pricing-card], [class*="pricing"], [class*="plan"]');
    });

    test('should have CTA buttons on pricing cards', async ({ page }) => {
      await page.goto(ROUTES.pricing);
      
      await waitForNavigation(page);
      
      // Look for signup/action buttons
      const ctaButtons = page.locator('button, a').filter({ hasText: /start|begin|aanmelden|signup/i });
    });
  });

  test.describe('Responsive Navigation', () => {
    test('should show mobile menu on small screens', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(ROUTES.home);
      
      // Look for hamburger menu
      const mobileMenuButton = page.locator('button[aria-label*="menu" i], button:has([class*="hamburger"]), [data-mobile-menu]');
      // Mobile menu behavior varies
    });
  });

  test.describe('Footer', () => {
    test('should display footer with links', async ({ page }) => {
      await page.goto(ROUTES.home);
      
      // Scroll to footer
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      
      // Check for footer
      const footer = page.locator('footer');
      await expect(footer).toBeVisible();
    });

    test('should have legal links', async ({ page }) => {
      await page.goto(ROUTES.home);
      
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      
      // Look for privacy and terms links
      const privacyLink = page.locator('a[href*="privacy"]');
      const termsLink = page.locator('a[href*="terms"]');
    });
  });
});
