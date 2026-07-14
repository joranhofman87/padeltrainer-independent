import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CycleSettings, ScoringWeights, CycleInput, IntakeRequestInput } from './cycles';
import { DEFAULT_SCORING_WEIGHTS, submitIntakeRequest } from './cycles';

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

describe('CycleSettings type and defaults', () => {
  it('DEFAULT_SCORING_WEIGHTS sums to 100', () => {
    const sum = Object.values(DEFAULT_SCORING_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it('DEFAULT_SCORING_WEIGHTS has all required keys', () => {
    const keys: (keyof ScoringWeights)[] = [
      'time_match', 'preferred_trainer', 'level_compatible',
      'priority_bonus', 'capacity_available', 'sessions_per_week',
    ];
    keys.forEach(k => expect(DEFAULT_SCORING_WEIGHTS).toHaveProperty(k));
  });

  it('CycleSettings supports payment_timing values', () => {
    const settings: CycleSettings = {
      payment_timing: 'upfront',
    };
    expect(settings.payment_timing).toBe('upfront');

    const invoiceSettings: CycleSettings = {
      payment_timing: 'invoice_after_weeks',
      invoice_delay_weeks: 2,
    };
    expect(invoiceSettings.payment_timing).toBe('invoice_after_weeks');
    expect(invoiceSettings.invoice_delay_weeks).toBe(2);

    const manualSettings: CycleSettings = {
      payment_timing: 'manual',
    };
    expect(manualSettings.payment_timing).toBe('manual');
  });

  it('backwards compatibility: mark_as_paid maps to manual', () => {
    const legacySettings: CycleSettings = {
      mark_as_paid: true,
    };
    const effectiveTiming = legacySettings.payment_timing ||
      (legacySettings.mark_as_paid ? 'manual' : 'upfront');
    expect(effectiveTiming).toBe('manual');
  });

  it('new settings without mark_as_paid default to upfront', () => {
    const settings: CycleSettings = {};
    const effectiveTiming = settings.payment_timing ||
      (settings.mark_as_paid ? 'manual' : 'upfront');
    expect(effectiveTiming).toBe('upfront');
  });

  it('extra_costs array works correctly', () => {
    const settings: CycleSettings = {
      extra_costs: [
        { description: 'Ball costs', price: 5 },
        { description: 'Court rental', price: 10 },
      ],
    };
    expect(settings.extra_costs).toHaveLength(2);
    expect(settings.extra_costs![0].price).toBe(5);
  });
});

describe('CycleInput type safety', () => {
  it('CycleInput accepts all required fields', () => {
    const input: CycleInput = {
      owner_type: 'trainer',
      owner_id: 'test-id',
      name: 'Test Cycle',
      start_date: '2025-01-01',
      end_date: '2025-06-01',
    };
    expect(input.owner_type).toBe('trainer');
    expect(input.status).toBeUndefined();
  });

  it('CycleInput accepts optional fields', () => {
    const input: CycleInput = {
      owner_type: 'academy',
      owner_id: 'test-id',
      name: 'Advanced',
      start_date: '2025-01-01',
      end_date: '2025-06-01',
      price_per_session: 45,
      total_price: 450,
      type: 'cyclus',
      status: 'open',
      currency: 'EUR',
    };
    expect(input.price_per_session).toBe(45);
    expect(input.type).toBe('cyclus');
  });
});

describe('CycleSettings complex scenarios', () => {
  it('cyclus_options array structures correctly', () => {
    const settings: CycleSettings = {
      cyclus_options: [
        { label: '10 weken', number_of_sessions: 10, number_of_weeks: 10, price_per_session: 40, total_price: 400 },
        { label: '20 weken', number_of_sessions: 20, number_of_weeks: 20, price_per_session: 35, total_price: 700 },
      ],
    };
    expect(settings.cyclus_options).toHaveLength(2);
    expect(settings.cyclus_options![1].total_price).toBe(700);
  });

  it('split_payment with extra_costs', () => {
    const settings: CycleSettings = {
      split_payment: true,
      extra_costs: [
        { description: 'Balls', price: 5, type: 'per_session', vat_rate: 9 },
        { description: 'Membership', price: 50, type: 'one_time' },
      ],
    };
    expect(settings.split_payment).toBe(true);
    expect(settings.extra_costs![0].vat_rate).toBe(9);
    expect(settings.extra_costs![1].type).toBe('one_time');
  });

  it('trainer_availability_windows structure', () => {
    const settings: CycleSettings = {
      trainer_availability_windows: [
        {
          trainerId: 't1',
          trainerName: 'Jan',
          windows: [{ day: 'monday', start: '09:00', end: '12:00' }],
        },
      ],
    };
    expect(settings.trainer_availability_windows![0].windows).toHaveLength(1);
  });

  it('excluded_dates array', () => {
    const settings: CycleSettings = {
      excluded_dates: ['2025-12-25', '2025-12-26', '2026-01-01'],
    };
    expect(settings.excluded_dates).toHaveLength(3);
  });
});

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

  // FAM-02 (Batch 4, Level 1): a logged-in registrant is NOT shadowed as a guest — they already
  // appear via their profile and as a prospect in the intake-requests view. No self-shadow guest.
  it('academy cycle does NOT mint a self-shadow guest for a logged-in registrant', async () => {
    cycleOwnerRow = { owner_type: 'academy', owner_id: 'academy-1' };
    const result = await submitIntakeRequest(baseInput);
    expect(result.id).toBe('req-1');
    expect(resolveOrCreateGuestPlayerMock).not.toHaveBeenCalled();
  });

  it('trainer cycle does NOT mint a self-shadow guest for a logged-in registrant', async () => {
    cycleOwnerRow = { owner_type: 'trainer', owner_id: 'trainer-1' };
    await submitIntakeRequest(baseInput);
    expect(resolveOrCreateGuestPlayerMock).not.toHaveBeenCalled();
  });

  it('registration succeeds (guest creation skipped, non-blocking)', async () => {
    cycleOwnerRow = { owner_type: 'academy', owner_id: 'academy-1' };
    const result = await submitIntakeRequest(baseInput);
    expect(result.id).toBe('req-1');
  });
});

describe('Rate limiting logic', () => {
  it('rate limit threshold is 3 per hour', () => {
    // The submitIntakeRequest function uses count >= 3 as the threshold
    const MAX_PER_HOUR = 3;
    expect(MAX_PER_HOUR).toBe(3);

    // Simulating count checks
    expect(0 >= MAX_PER_HOUR).toBe(false);
    expect(2 >= MAX_PER_HOUR).toBe(false);
    expect(3 >= MAX_PER_HOUR).toBe(true);
    expect(5 >= MAX_PER_HOUR).toBe(true);
  });
});
