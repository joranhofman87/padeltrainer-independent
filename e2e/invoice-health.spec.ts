import { test, expect } from '@playwright/test';

// Fail fast — never fall back to a hardcoded (old ppkbhd) project. Set these in the
// e2e workflow env, pointing at the current ficwb project (or a disposable test one).
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set for the invoice-health check.');
}

test.describe('Invoice Health Check', () => {
  test('invoice-health-check returns a valid response', async ({ request }) => {
    const response = await request.fetch(
      `${SUPABASE_URL}/functions/v1/invoice-health-check`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey': SUPABASE_ANON_KEY,
        },
      }
    );

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('checked_at');
    expect(['healthy', 'anomalies_found']).toContain(body.status);

    if (body.anomalies) {
      for (const anomaly of body.anomalies) {
        expect(anomaly).toHaveProperty('check');
        expect(anomaly).toHaveProperty('count');
        expect(anomaly.count).toBeGreaterThan(0);
      }
    }
  });
});
