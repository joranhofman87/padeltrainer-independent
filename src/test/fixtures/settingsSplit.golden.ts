/**
 * Phase 4 F1 — GOLDEN: the registration↔cycle settings split contract.
 *
 * The cutover (docs/archive/PHASE2_STEP3_CUTOVER.sql) copied a specific FORM-ONLY allowlist of
 * `cycles.settings` keys onto `registrations.settings`, and KEPT the training/scoring keys on the
 * cycle. Slices 1/4 (createRegistration / updateRegistration / the editor write-switch) MUST filter
 * through the SAME allowlist, or the admin editor will write keys the public form never reads (the
 * exact divergence this whole phase fixes). This golden freezes that list so any drift fails a test.
 *
 * Source of truth: PHASE2_STEP3_CUTOVER.sql lines ~110-117 (the unnest ARRAY[...]).
 */

/** Form-config keys that live on the REGISTRATION (the public form reads these). */
export const FORM_ONLY_SETTING_KEYS = [
  'lesson_types',
  'custom_lesson_types',
  'show_preferred_trainer',
  'show_price_indication',
  'cyclus_options',
  'duration_options',
  'available_duration_minutes',
  'price_columns',
  'prices_include_vat',
  'success_message',
  'confirmation_email_text',
  'payment_methods',
  'rating_system',
  'default_duration_minutes',
  'available_days',
  'max_participants',
  'notify_admin_on_submission',
  'notify_admin_emails',
  'pricing_note',
  // The admin-chosen trainer set — a form-DISPLAY key: the public form shows these trainers'
  // profiles (+ the optional preference picker). Moved from training-only when the registration
  // trainer feature added it to _registration_form_settings (migration 20260821100000).
  'applicable_trainer_ids',
] as const;

/** Training/scoring keys that STAY on the cycle (read only by proposals/scheduling — never the form). */
export const TRAINING_ONLY_SETTING_KEYS = [
  'min_skill_rating',
  'max_skill_rating',
  'max_group_size',
  'min_group_size',
  'assigned_trainer_id',
  'scoring_weights',
  'allow_single_booking',
  'extra_costs',
  'mark_as_paid',
  'payment_timing',
  'invoice_delay_weeks',
  'split_payment',
  'trainer_availability_windows',
  'excluded_dates',
] as const;

/**
 * Partition a settings object into the form-only subset (→ registration) and the rest (→ cycle).
 * Mirrors what Slice 1's production `pickFormSettings` must do; the golden test asserts both agree.
 */
export function partitionSettingsByForm(
  settings: Record<string, unknown>,
): { form: Record<string, unknown>; rest: Record<string, unknown> } {
  const formKeys = new Set<string>(FORM_ONLY_SETTING_KEYS);
  const form: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (formKeys.has(k)) form[k] = v;
    else rest[k] = v;
  }
  return { form, rest };
}

/** A representative settings blob carrying BOTH form-only and training-only keys. */
export const SAMPLE_MIXED_SETTINGS: Record<string, unknown> = {
  // form-only
  lesson_types: ['group'],
  payment_methods: 'online',
  prices_include_vat: true,
  success_message: 'Bedankt!',
  max_participants: 4,
  applicable_trainer_ids: ['trn-1', 'trn-2'], // the shown trainer set — travels to the form
  // training-only (must NOT travel to the registration)
  min_skill_rating: 2.0,
  scoring_weights: { time_match: 35 },
  split_payment: true,
};
