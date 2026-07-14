import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      ['applicable_trainer_ids', 'lesson_types', 'max_participants', 'payment_methods', 'prices_include_vat', 'success_message'].sort(),
    );
    expect(Object.keys(rest).sort()).toEqual(
      ['min_skill_rating', 'scoring_weights', 'split_payment'].sort(),
    );
    // the divergence guard: training keys must NEVER leak into the form half
    expect('min_skill_rating' in form).toBe(false);
    expect('split_payment' in form).toBe(false);
  });

  it('the write RPC splits on the SAME form allowlist (includes every form key, references NO training key)', () => {
    // The split lives in SQL (_registration_form_settings, called by create/update_registration_
    // with_cycle). Read the LATEST re-emission of that function (20260821100000 added
    // applicable_trainer_ids). Freeze it against the golden: a form key dropped, or a training key
    // added, fails here.
    const rpcSql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '20260821100000_registration_form_settings_add_trainers.sql'), 'utf8');
    for (const k of FORM_ONLY_SETTING_KEYS) {
      expect(rpcSql, `RPC form-settings array must include ${k}`).toContain(`'${k}'`);
    }
    for (const k of TRAINING_ONLY_SETTING_KEYS) {
      expect(rpcSql, `RPC must NOT reference training key ${k}`).not.toContain(`'${k}'`);
    }
  });

  it('the Phase-2 backfill cutover splits on the SAME form allowlist (write path ≡ backfill)', () => {
    const backfillSql = readFileSync(join(process.cwd(), 'docs', 'PHASE2_STEP3_CUTOVER.sql'), 'utf8');
    for (const k of FORM_ONLY_SETTING_KEYS) {
      expect(backfillSql, `backfill form-settings array must include ${k}`).toContain(`'${k}'`);
    }
  });

  it('registrationToCycle carries the registration settings onto the Cycle shape unchanged', () => {
    const reg = makeRegistration({
      source_cycle_id: 'cyc-X',
      settings: { payment_methods: 'cash', lesson_types: ['duo'] },
    });
    const c = registrationToCycle(reg);
    expect(c.id).toBe(reg.id); // canonical: the registration's OWN id (decouple), not the source cycle
    expect((c.settings as Record<string, unknown>).payment_methods).toBe('cash');
    expect((c.settings as Record<string, unknown>).lesson_types).toEqual(['duo']);
  });
});
