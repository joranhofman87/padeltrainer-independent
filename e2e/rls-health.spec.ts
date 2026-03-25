import { test, expect } from '@playwright/test';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://ppkbhdiiqdusdeatgdft.supabase.co';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwa2JoZGlpcWR1c2RlYXRnZGZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0OTk2NDcsImV4cCI6MjA4NDA3NTY0N30.b7rDXbi4FBNc9rREGCCTmip3LVxH03_hm0DQMMyWio0';

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
