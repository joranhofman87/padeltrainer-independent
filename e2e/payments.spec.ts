import { test, expect } from "@playwright/test";

test.describe("Payment Flow - Public Invoice Page", () => {
  // Use a known public invoice URL pattern
  const baseUrl = "/nl/academies/rl-padel-performance/pay";

  test("should show Pay button when Mollie is connected", async ({ page }) => {
    // Navigate to a public invoice page (we intercept the edge function to simulate connected Mollie)
    await page.route("**/functions/v1/get-public-invoice", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "test-invoice-id",
          invoice_number: "INV-TEST-001",
          total: 50.0,
          subtotal: 41.32,
          vat_amount: 8.68,
          vat_rate: 21,
          player_name: "Test Player",
          player_email: "test@example.com",
          invoice_date: "2025-01-15",
          due_date: "2025-01-29",
          status: "sent",
          hasMollieAccount: true,
          line_items: [
            { description: "Padel training", quantity: 1, unit_price: 50.0, total: 50.0 },
          ],
          academy: {
            name: "Test Academy",
            slug: "test-academy",
            logo_url: null,
            iban: "NL00TEST0000000000",
            bic: "TESTNL2A",
            kvk_number: "12345678",
            btw_number: "NL123456789B01",
            business_name: "Test Academy B.V.",
            business_address: "Teststraat 1, Amsterdam",
            invoice_banner_color: "#1a365d",
            payment_terms_days: 14,
          },
        }),
      });
    });

    await page.goto(`${baseUrl}/test-token`);
    await page.waitForLoadState("networkidle");

    // Pay button should be visible
    const payButton = page.locator('button:has-text("Betaal")');
    await expect(payButton).toBeVisible();

    // Bank details should NOT be visible when Mollie is connected
    await expect(page.locator('text=NL00TEST0000000000')).not.toBeVisible();
  });

  test("should show bank details when Mollie is NOT connected", async ({ page }) => {
    await page.route("**/functions/v1/get-public-invoice", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "test-invoice-id",
          invoice_number: "INV-TEST-002",
          total: 50.0,
          subtotal: 41.32,
          vat_amount: 8.68,
          vat_rate: 21,
          player_name: "Test Player",
          player_email: "test@example.com",
          invoice_date: "2025-01-15",
          due_date: "2025-01-29",
          status: "sent",
          hasMollieAccount: false,
          line_items: [
            { description: "Padel training", quantity: 1, unit_price: 50.0, total: 50.0 },
          ],
          academy: {
            name: "Test Academy",
            slug: "test-academy",
            logo_url: null,
            iban: "NL00TEST0000000000",
            bic: "TESTNL2A",
            kvk_number: "12345678",
            btw_number: "NL123456789B01",
            business_name: "Test Academy B.V.",
            business_address: "Teststraat 1, Amsterdam",
            invoice_banner_color: "#1a365d",
            payment_terms_days: 14,
          },
        }),
      });
    });

    await page.goto(`${baseUrl}/test-token-2`);
    await page.waitForLoadState("networkidle");

    // Pay button should NOT be visible
    const payButton = page.locator('button:has-text("Betaal")');
    await expect(payButton).not.toBeVisible();

    // Bank details SHOULD be visible
    await expect(page.locator('text=NL00TEST0000000000')).toBeVisible();
  });

  test("should handle payment error gracefully and reset button", async ({ page }) => {
    await page.route("**/functions/v1/get-public-invoice", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "test-invoice-id",
          invoice_number: "INV-TEST-003",
          total: 50.0,
          subtotal: 41.32,
          vat_amount: 8.68,
          vat_rate: 21,
          player_name: "Test Player",
          player_email: "test@example.com",
          invoice_date: "2025-01-15",
          due_date: "2025-01-29",
          status: "sent",
          hasMollieAccount: true,
          line_items: [
            { description: "Padel training", quantity: 1, unit_price: 50.0, total: 50.0 },
          ],
          academy: {
            name: "Test Academy",
            slug: "test-academy",
            logo_url: null,
            iban: "NL00TEST0000000000",
            bic: "TESTNL2A",
            kvk_number: "12345678",
            btw_number: "NL123456789B01",
            business_name: "Test Academy B.V.",
            business_address: "Teststraat 1, Amsterdam",
            invoice_banner_color: "#1a365d",
            payment_terms_days: 14,
          },
        }),
      });
    });

    // Mock the payment creation to fail
    await page.route("**/functions/v1/create-invoice-payment", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "missing_mollie_profile", message: "Payment profile not configured." }),
      });
    });

    await page.goto(`${baseUrl}/test-token-3`);
    await page.waitForLoadState("networkidle");

    const payButton = page.locator('button:has-text("Betaal")');
    await expect(payButton).toBeVisible();

    // Click pay
    await payButton.click();

    // Button should reset (not stay stuck on "Redirecting...")
    await expect(payButton).toBeVisible({ timeout: 10000 });
    await expect(payButton).not.toHaveText("Redirecting...");

    // Toast error should appear
    await expect(page.locator('[data-sonner-toast]')).toBeVisible({ timeout: 5000 });
  });

  test("should show success state on paid invoice", async ({ page }) => {
    await page.route("**/functions/v1/get-public-invoice", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "test-invoice-id",
          invoice_number: "INV-TEST-004",
          total: 50.0,
          subtotal: 41.32,
          vat_amount: 8.68,
          vat_rate: 21,
          player_name: "Test Player",
          player_email: "test@example.com",
          invoice_date: "2025-01-15",
          due_date: "2025-01-29",
          status: "paid",
          paid_at: "2025-01-16T10:00:00Z",
          hasMollieAccount: true,
          line_items: [
            { description: "Padel training", quantity: 1, unit_price: 50.0, total: 50.0 },
          ],
          academy: {
            name: "Test Academy",
            slug: "test-academy",
            logo_url: null,
            iban: "NL00TEST0000000000",
            bic: "TESTNL2A",
            kvk_number: "12345678",
            btw_number: "NL123456789B01",
            business_name: "Test Academy B.V.",
            business_address: "Teststraat 1, Amsterdam",
            invoice_banner_color: "#1a365d",
            payment_terms_days: 14,
          },
        }),
      });
    });

    await page.goto(`${baseUrl}/test-token-4`);
    await page.waitForLoadState("networkidle");

    // Pay button should NOT be visible on paid invoice
    const payButton = page.locator('button:has-text("Betaal")');
    await expect(payButton).not.toBeVisible();
  });
});
