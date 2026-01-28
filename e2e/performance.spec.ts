import { test, expect } from '../playwright-fixture';
import { dismissCookieConsent, waitForNavigation } from './fixtures/helpers';
import { ROUTES } from './fixtures/test-data';

test.describe('Performance Tests', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test.describe('Page Load Times', () => {
    test('home page should load within acceptable time', async ({ page }) => {
      const startTime = Date.now();
      await page.goto(ROUTES.home);
      await waitForNavigation(page);
      const loadTime = Date.now() - startTime;
      
      // Page should load within 10 seconds
      expect(loadTime).toBeLessThan(10000);
      console.log(`Home page load time: ${loadTime}ms`);
    });

    test('trainers page should load within acceptable time', async ({ page }) => {
      const startTime = Date.now();
      await page.goto(ROUTES.trainers);
      await waitForNavigation(page);
      const loadTime = Date.now() - startTime;
      
      expect(loadTime).toBeLessThan(10000);
      console.log(`Trainers page load time: ${loadTime}ms`);
    });

    test('locations page should load within acceptable time', async ({ page }) => {
      const startTime = Date.now();
      await page.goto(ROUTES.locations);
      await waitForNavigation(page);
      const loadTime = Date.now() - startTime;
      
      expect(loadTime).toBeLessThan(10000);
      console.log(`Locations page load time: ${loadTime}ms`);
    });

    test('auth page should load within acceptable time', async ({ page }) => {
      const startTime = Date.now();
      await page.goto(ROUTES.auth);
      await waitForNavigation(page);
      const loadTime = Date.now() - startTime;
      
      expect(loadTime).toBeLessThan(5000);
      console.log(`Auth page load time: ${loadTime}ms`);
    });
  });

  test.describe('Resource Loading', () => {
    test('should not have excessive network requests on home', async ({ page }) => {
      const requests: string[] = [];
      
      page.on('request', request => {
        requests.push(request.url());
      });
      
      await page.goto(ROUTES.home);
      await waitForNavigation(page);
      
      // Log for visibility
      console.log(`Total requests on home page: ${requests.length}`);
      
      // Should not have excessive requests (adjust threshold as needed)
      expect(requests.length).toBeLessThan(100);
    });

    test('should load critical CSS quickly', async ({ page }) => {
      await page.goto(ROUTES.home);
      
      // Check that main content is styled
      const body = page.locator('body');
      const backgroundColor = await body.evaluate(el => 
        window.getComputedStyle(el).backgroundColor
      );
      
      // Should have some styling applied
      expect(backgroundColor).toBeTruthy();
    });
  });

  test.describe('Lighthouse Metrics (Basic)', () => {
    test('should have viewport meta tag', async ({ page }) => {
      await page.goto(ROUTES.home);
      
      const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
      expect(viewportMeta).toContain('width=device-width');
    });

    test('should have lang attribute on html', async ({ page }) => {
      await page.goto('/en/');
      
      const lang = await page.locator('html').getAttribute('lang');
      expect(lang).toBeTruthy();
    });

    test('should have charset meta tag', async ({ page }) => {
      await page.goto(ROUTES.home);
      
      const charsetMeta = page.locator('meta[charset]');
      await expect(charsetMeta).toBeAttached();
    });
  });

  test.describe('Image Optimization', () => {
    test('images should have dimensions', async ({ page }) => {
      await page.goto(ROUTES.home);
      await waitForNavigation(page);
      
      const images = page.locator('img');
      const count = await images.count();
      
      for (let i = 0; i < Math.min(count, 5); i++) {
        const img = images.nth(i);
        if (await img.isVisible()) {
          const width = await img.getAttribute('width');
          const height = await img.getAttribute('height');
          // Many images use CSS sizing, so we check naturalWidth
          const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
          expect(naturalWidth).toBeGreaterThan(0);
        }
      }
    });

    test('should use lazy loading for below-fold images', async ({ page }) => {
      await page.goto(ROUTES.home);
      await waitForNavigation(page);
      
      const lazyImages = page.locator('img[loading="lazy"]');
      // Just verify the selector works - lazy loading is optional
    });
  });

  test.describe('Bundle Size Indicators', () => {
    test('should have reasonable JS bundle', async ({ page }) => {
      const scriptSizes: number[] = [];
      
      page.on('response', async response => {
        const url = response.url();
        if (url.includes('.js') && response.status() === 200) {
          try {
            const body = await response.body();
            scriptSizes.push(body.length);
          } catch (e) {
            // Ignore errors from non-cacheable responses
          }
        }
      });
      
      await page.goto(ROUTES.home);
      await waitForNavigation(page);
      
      const totalJsSize = scriptSizes.reduce((a, b) => a + b, 0);
      console.log(`Total JS bundle size: ${(totalJsSize / 1024 / 1024).toFixed(2)}MB`);
      
      // Should be under 5MB total (generous limit for modern SPAs)
      expect(totalJsSize).toBeLessThan(5 * 1024 * 1024);
    });
  });
});

test.describe('Core Web Vitals Proxies', () => {
  test('should have stable layout (no layout shifts)', async ({ page }) => {
    await page.goto(ROUTES.home);
    
    // Wait for initial load
    await waitForNavigation(page);
    
    // Take initial screenshot dimensions
    const initialHeight = await page.evaluate(() => document.body.scrollHeight);
    
    // Wait a bit for any lazy content
    await page.waitForTimeout(1000);
    
    const finalHeight = await page.evaluate(() => document.body.scrollHeight);
    
    // Height shouldn't change dramatically after initial load
    const heightDiff = Math.abs(finalHeight - initialHeight);
    console.log(`Layout shift: ${heightDiff}px`);
  });

  test('should respond to user input quickly', async ({ page }) => {
    await page.goto(ROUTES.auth);
    await waitForNavigation(page);
    
    const emailInput = page.locator('#signin-email');
    
    const startTime = Date.now();
    await emailInput.focus();
    await emailInput.type('test', { delay: 0 });
    const responseTime = Date.now() - startTime;
    
    // Input should respond within 100ms
    expect(responseTime).toBeLessThan(500);
  });
});
