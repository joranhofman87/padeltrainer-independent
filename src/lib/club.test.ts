import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: vi.fn() },
    functions: { invoke: vi.fn() },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { supabase } from '@/lib/supabaseClient';
import { claimClub } from './club';

/**
 * claim-club-profile creates club_profiles with is_verified=true (see edge function).
 * Existing unverified clubs with managers are backfilled via migration
 * 20260530150000_backfill_club_profiles_verified_with_managers.sql.
 */
describe('claimClub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes claim-club-profile edge function when authenticated', async () => {
    (supabase.auth.getSession as Mock).mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
    });
    (supabase.functions.invoke as Mock).mockResolvedValue({
      data: { success: true, clubProfileId: 'club-1' },
      error: null,
    });

    const result = await claimClub(
      'loc-1',
      'user-1',
      'club@example.com',
      '+31612345678',
      'Owner',
    );

    expect(supabase.functions.invoke).toHaveBeenCalledWith('claim-club-profile', {
      body: {
        locationId: 'loc-1',
        contactEmail: 'club@example.com',
        phone: '+31612345678',
        description: 'Owner',
      },
    });
    expect(result).toEqual({ success: true, clubProfileId: 'club-1', error: null });
  });

  it('returns error when not authenticated', async () => {
    (supabase.auth.getSession as Mock).mockResolvedValue({ data: { session: null } });

    const result = await claimClub('loc-1', 'user-1', 'club@example.com');

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/authenticated/i);
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it('surfaces edge function error payload', async () => {
    (supabase.auth.getSession as Mock).mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
    });
    (supabase.functions.invoke as Mock).mockResolvedValue({
      data: { error: 'This location has already been claimed' },
      error: null,
    });

    const result = await claimClub('loc-1', 'user-1', 'club@example.com');

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('This location has already been claimed');
  });
});
