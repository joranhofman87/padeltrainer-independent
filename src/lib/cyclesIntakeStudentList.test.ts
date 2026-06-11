import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IntakeRequestInput } from './cycles';
import { submitIntakeRequest } from './cycles';

const resolveOrCreateGuestPlayerMock = vi.fn();

vi.mock('@/lib/playerResolve', () => ({
  resolveOrCreateGuestPlayer: (...args: unknown[]) => resolveOrCreateGuestPlayerMock(...args),
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
  if (table === 'cycles') {
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
    resolveOrCreateGuestPlayerMock.mockResolvedValue('guest-1');
  });

  it('academy cycle resolves the applicant into an academy-scoped guest player', async () => {
    cycleOwnerRow = { owner_type: 'academy', owner_id: 'academy-1' };
    await submitIntakeRequest(baseInput);
    expect(resolveOrCreateGuestPlayerMock).toHaveBeenCalledTimes(1);
    expect(resolveOrCreateGuestPlayerMock).toHaveBeenCalledWith({
      scope: { kind: 'academy', academyProfileId: 'academy-1' },
      fullName: 'Jan Jansen',
      email: 'jan@test.com',
      phone: '+31612345678',
      skillRating: 6.5,
      ratingSystem: 'knltb',
      birthDate: '1990-05-01',
      linkedProfileId: 'profile-1',
      source: 'cycle_registration',
      hasTrained: false,
      patchExistingEmptyFields: true,
    });
  });

  it('trainer cycle resolves the applicant into a trainer-scoped guest player', async () => {
    cycleOwnerRow = { owner_type: 'trainer', owner_id: 'trainer-1' };
    await submitIntakeRequest(baseInput);
    expect(resolveOrCreateGuestPlayerMock).toHaveBeenCalledTimes(1);
    expect(resolveOrCreateGuestPlayerMock.mock.calls[0][0]).toMatchObject({
      scope: { kind: 'trainer', trainerId: 'trainer-1' },
      source: 'cycle_registration',
      patchExistingEmptyFields: true,
    });
  });

  it('registration still succeeds when the resolver fails (non-blocking)', async () => {
    cycleOwnerRow = { owner_type: 'academy', owner_id: 'academy-1' };
    resolveOrCreateGuestPlayerMock.mockResolvedValue(null);
    const result = await submitIntakeRequest(baseInput);
    expect(result.id).toBe('req-1');
  });
});
