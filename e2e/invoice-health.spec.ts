import { test, expect } from '@playwright/test';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://ppkbhdiiqdusdeatgdft.supabase.co';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwa2JoZGlpcWR1c2RlYXRnZGZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0OTk2NDcsImV4cCI6MjA4NDA3NTY0N30.b7rDXbi4FBNc9rREGCCTmip3LVxH03_hm0DQMMyWio0';

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
