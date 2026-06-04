import { test, expect } from '@playwright/test';

test.describe('Smoke', () => {
  test('homepage loads', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    expect(response!.ok()).toBeTruthy();
    await expect(page.locator('body')).toBeVisible();
  });
});
