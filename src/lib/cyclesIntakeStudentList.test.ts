import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IntakeRequestInput } from './cycles';
import { submitIntakeRequest } from './cycles';

const ensureRosterTwinMock = vi.fn();

vi.mock('@/lib/playerResolve', () => ({
  ensureRosterTwinForRegisteredPlayer: (...args: unknown[]) => ensureRosterTwinMock(...args),
}));

let cycleOwnerRow: { owner_type: string; owner_id: string } = {
  owner_type: 'academy',
  owner_id: 'academy-1',
};

const supabaseFromMock = vi.fn((table: string) => {
  if (table === 'intake_requests') {
    return {
      select: () => ({
        eq: () => ({
          gte: () => Promise.resolve({ count: 0 }),
        }),
      }),
      insert: (payload: Record<string, unknown>) => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: 'req-1', ...payload }, error: null }),
        }),
      }),
    };
  }
  if (table === 'registrations') {
    // submitIntakeRequest resolves the form owner from the registration (decouple).
    return {
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: cycleOwnerRow, error: null }),
        }),
      }),
    };
  }
  // follower tables (trainer_followers / club_followers / academy_followers)
  return {
    upsert: () => Promise.resolve({ error: null }),
  };
});

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: (...args: unknown[]) => supabaseFromMock(...(args as [string])) },
}));

describe('submitIntakeRequest -> addToStudentList', () => {
  const baseInput: IntakeRequestInput = {
    cycle_id: 'cycle-1',
    player_id: 'profile-1',
    full_name: 'Jan Jansen',
    email: 'jan@test.com',
    phone: '+31612345678',
    birth_date: '1990-05-01',
    rating: 6.5,
    rating_system: 'knltb',
    lesson_types: ['group4'],
    preferred_days: ['monday'],
    preferred_time_windows: [{ day: 'monday', start: '18:00', end: '20:00' }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ensureRosterTwinMock.mockResolvedValue({ personId: 'person-1' });
  });

  // FAM-02 (Batch 4, Level 1): a logged-in registrant is NOT shadowed as a guest — they already
  // appear via their profile and as a prospect in the intake-requests view. No self-shadow guest.
  it('academy cycle does NOT mint a self-shadow guest for a logged-in registrant', async () => {
    cycleOwnerRow = { owner_type: 'academy', owner_id: 'academy-1' };
    const result = await submitIntakeRequest(baseInput);
    expect(result.id).toBe('req-1');
    expect(ensureRosterTwinMock).not.toHaveBeenCalled();
  });

  it('trainer cycle does NOT mint a self-shadow guest for a logged-in registrant', async () => {
    cycleOwnerRow = { owner_type: 'trainer', owner_id: 'trainer-1' };
    await submitIntakeRequest(baseInput);
    expect(ensureRosterTwinMock).not.toHaveBeenCalled();
  });

  it('registration succeeds (guest creation skipped, non-blocking)', async () => {
    cycleOwnerRow = { owner_type: 'academy', owner_id: 'academy-1' };
    const result = await submitIntakeRequest(baseInput);
    expect(result.id).toBe('req-1');
  });
});
