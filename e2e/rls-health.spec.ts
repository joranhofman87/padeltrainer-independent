import { test, expect } from '@playwright/test';

// Fail fast — never fall back to a hardcoded (old ppkbhd) project. Set these in the
// e2e workflow env, pointing at the current ficwb project (or a disposable test one).
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set for the RLS-health check.');
}

test.describe('RLS Recursion Health Check', () => {
  test('no infinite recursion detected in critical tables', async ({ request }) => {
    const response = await request.fetch(
      `${SUPABASE_URL}/functions/v1/rls-smoke-test`,
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
    expect(body.status).toBe('healthy');

    // Assert no table has recursion
    for (const result of body.results) {
      expect(
        result.error?.includes('infinite recursion') ?? false,
        `Table "${result.table}" has infinite recursion: ${result.error}`
      ).toBe(false);
    }
  });
});
