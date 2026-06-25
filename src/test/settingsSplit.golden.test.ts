import { describe, it, expect, vi } from 'vitest';
import {
  FORM_ONLY_SETTING_KEYS,
  TRAINING_ONLY_SETTING_KEYS,
  partitionSettingsByForm,
  SAMPLE_MIXED_SETTINGS,
} from './fixtures/settingsSplit.golden';

// registrationToCycle is pure, but its module pulls in cycles.ts → supabaseClient at import time.
vi.mock('@/lib/supabaseClient', () => ({ supabase: { from: () => ({}) } }));
import { registrationToCycle } from '@/lib/registrations';
import { makeRegistration } from './fixtures/factory';

describe('GOLDEN: registration↔cycle settings split contract', () => {
  it('the FORM-ONLY allowlist is frozen (snapshot — any change must be reviewed)', () => {
    expect([...FORM_ONLY_SETTING_KEYS]).toMatchSnapshot();
  });

  it('form-only and training-only key sets never overlap', () => {
    const form = new Set<string>(FORM_ONLY_SETTING_KEYS);
    expect(TRAINING_ONLY_SETTING_KEYS.filter((k) => form.has(k))).toEqual([]);
  });

  it('partitions a mixed settings blob — form keys to the form, training keys stay on the cycle', () => {
    const { form, rest } = partitionSettingsByForm(SAMPLE_MIXED_SETTINGS);
    expect(Object.keys(form).sort()).toEqual(
      ['lesson_types', 'max_participants', 'payment_methods', 'prices_include_vat', 'success_message'].sort(),
    );
    expect(Object.keys(rest).sort()).toEqual(
      ['applicable_trainer_ids', 'min_skill_rating', 'scoring_weights', 'split_payment'].sort(),
    );
    // the divergence guard: training keys must NEVER leak into the form half
    expect('min_skill_rating' in form).toBe(false);
    expect('split_payment' in form).toBe(false);
  });

  it('registrationToCycle carries the registration settings onto the Cycle shape unchanged', () => {
    const reg = makeRegistration({
      source_cycle_id: 'cyc-X',
      settings: { payment_methods: 'cash', lesson_types: ['duo'] },
    });
    const c = registrationToCycle(reg);
    expect(c.id).toBe('cyc-X'); // mapped id = SOURCE cycle (drives intake.cycle_id)
    expect((c.settings as Record<string, unknown>).payment_methods).toBe('cash');
    expect((c.settings as Record<string, unknown>).lesson_types).toEqual(['duo']);
  });
});
