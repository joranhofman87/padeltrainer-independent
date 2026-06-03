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
import { createAcademy } from './academy';

describe('createAcademy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes create-academy-profile edge function when authenticated', async () => {
    (supabase.auth.getSession as Mock).mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
    });
    (supabase.functions.invoke as Mock).mockResolvedValue({
      data: { success: true, academyId: 'academy-1' },
      error: null,
    });

    const result = await createAcademy('Padel Pro', 'user-1', 'info@test.com', 'About', 'NL');

    expect(supabase.functions.invoke).toHaveBeenCalledWith('create-academy-profile', {
      body: expect.objectContaining({
        name: 'Padel Pro',
        contactEmail: 'info@test.com',
        description: 'About',
        country: 'NL',
      }),
    });
    expect(result).toEqual({ success: true, academyId: 'academy-1', error: null });
  });

  it('returns error when not authenticated', async () => {
    (supabase.auth.getSession as Mock).mockResolvedValue({ data: { session: null } });

    const result = await createAcademy('Padel Pro', 'user-1');

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/authenticated/i);
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it('surfaces edge function error payload', async () => {
    (supabase.auth.getSession as Mock).mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
    });
    (supabase.functions.invoke as Mock).mockResolvedValue({
      data: { error: 'Academy name is required' },
      error: null,
    });

    const result = await createAcademy('', 'user-1');

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Academy name is required');
  });
});
