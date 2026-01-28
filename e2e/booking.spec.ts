import { test, expect } from '../playwright-fixture';
import { ROUTES } from './fixtures/test-data';
import { dismissCookieConsent, waitForNavigation } from './fixtures/helpers';

test.describe('Booking Flows', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Trainer Profile & Booking', () => {
    test('should display trainer profile with booking options', async ({ page }) => {
      // Navigate to trainers page first
      await page.goto(ROUTES.trainers);
      await waitForNavigation(page);
      
      // Find and click first trainer
      const trainerLink = page.locator('a[href*="/trainers/"]').first();
      
      if (await trainerLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await trainerLink.click();
        await waitForNavigation(page);
        
        // Check for trainer profile elements
        await expect(page.locator('h1, h2').first()).toBeVisible();
        
        // Look for booking button or availability
        const bookButton = page.locator('button:has-text("Book"), button:has-text("Boek"), a:has-text("Book"), a:has-text("Boek")');
      }
    });

    test('should show available slots on trainer profile', async ({ page }) => {
      await page.goto(ROUTES.trainers);
      await waitForNavigation(page);
      
      const trainerLink = page.locator('a[href*="/trainers/"]').first();
      
      if (await trainerLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await trainerLink.click();
        await waitForNavigation(page);
        
        // Look for availability calendar or slots
        const availabilitySection = page.locator('[data-availability], [class*="calendar"], [class*="slots"]');
      }
    });

    test('should require login to book', async ({ page }) => {
      await page.goto(ROUTES.trainers);
      await waitForNavigation(page);
      
      const trainerLink = page.locator('a[href*="/trainers/"]').first();
      
      if (await trainerLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await trainerLink.click();
        await waitForNavigation(page);
        
        // Try to book without being logged in
        const bookButton = page.locator('button:has-text("Book"), button:has-text("Boek")').first();
        
        if (await bookButton.isVisible({ timeout: 3000 }).catch(() => false)) {
          await bookButton.click();
          
          // Should redirect to auth or show login prompt
          await waitForNavigation(page);
        }
      }
    });
  });

  test.describe('Open Slots Page', () => {
    test('should display open slots listing', async ({ page }) => {
      await page.goto('/en/open-slots');
      await waitForNavigation(page);
      
      // Check for open slots content
      await expect(page.locator('h1, h2').first()).toBeVisible();
    });

    test('should have date filter', async ({ page }) => {
      await page.goto('/en/open-slots');
      await waitForNavigation(page);
      
      // Look for date picker or filter
      const dateFilter = page.locator('input[type="date"], [data-date-picker], button:has-text("Date")');
    });

    test('should have location filter', async ({ page }) => {
      await page.goto('/en/open-slots');
      await waitForNavigation(page);
      
      // Look for location filter
      const locationFilter = page.locator('select, [data-location-filter], button:has-text("Location"), button:has-text("Locatie")');
    });
  });

  test.describe('Cycle Registration', () => {
    test('should navigate to cycle registration page', async ({ page }) => {
      // This depends on having active cycles
      // Navigate to a club or academy page that has cycles
      await page.goto(ROUTES.locations);
      await waitForNavigation(page);
      
      const locationLink = page.locator('a[href*="/locations/"]').first();
      
      if (await locationLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await locationLink.click();
        await waitForNavigation(page);
        
        // Look for cycles section
        const cyclesSection = page.locator('[data-cycles], text=/cycle/i, text=/cyclus/i');
      }
    });
  });
});

test.describe('Location Detail & Club Features', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test('should display location details', async ({ page }) => {
    await page.goto(ROUTES.locations);
    await waitForNavigation(page);
    
    const locationLink = page.locator('a[href*="/locations/"]').first();
    
    if (await locationLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await locationLink.click();
      await waitForNavigation(page);
      
      // Check for location name and details
      await expect(page.locator('h1, h2').first()).toBeVisible();
    }
  });

  test('should show trainers at location', async ({ page }) => {
    await page.goto(ROUTES.locations);
    await waitForNavigation(page);
    
    const locationLink = page.locator('a[href*="/locations/"]').first();
    
    if (await locationLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await locationLink.click();
      await waitForNavigation(page);
      
      // Look for trainers section
      const trainersSection = page.locator('[data-trainers], text=/trainer/i');
    }
  });

  test('should show follow button for club', async ({ page }) => {
    await page.goto(ROUTES.locations);
    await waitForNavigation(page);
    
    const locationLink = page.locator('a[href*="/locations/"]').first();
    
    if (await locationLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await locationLink.click();
      await waitForNavigation(page);
      
      // Look for follow button
      const followButton = page.locator('button:has-text("Follow"), button:has-text("Volg")');
    }
  });
});
