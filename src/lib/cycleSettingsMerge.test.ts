import { describe, it, expect } from 'vitest';
import { mergeCycleSettingsOnEdit, type CycleSettings } from '@/lib/cycleTypes';

// Audit §4.2: editing a rebook round (or a booked cyclus) through the cycle editor rebuilt settings
// from FORM state only, wiping the engine-owned keys → the round vanished from the hub. The editor
// must MERGE the form keys onto the existing settings instead of replacing them.
describe('mergeCycleSettingsOnEdit (audit Batch 6, §4.2)', () => {
  const existing: CycleSettings = {
    // engine-owned run-state the form never rebuilds
    rebook_round_id: 'round-1',
    rebook_priority_people: ['p1', 'p2'],
    generated_by: 'slot_generator',
    excluded_dates: ['2026-12-25'],
    // a form key that WILL be edited
    split_payment: false,
    lesson_types: ['group'],
  };
  const formSettings: CycleSettings = {
    split_payment: true,           // edited
    lesson_types: ['private'],     // edited
    show_price_indication: true,   // newly set by the form
  };

  it('preserves every engine-owned key the form never touches', () => {
    const merged = mergeCycleSettingsOnEdit(existing, formSettings);
    expect(merged.rebook_round_id).toBe('round-1');
    expect(merged.rebook_priority_people).toEqual(['p1', 'p2']);
    expect(merged.generated_by).toBe('slot_generator');
    expect(merged.excluded_dates).toEqual(['2026-12-25']);
  });

  it('applies the form edits (form wins for overlapping keys)', () => {
    const merged = mergeCycleSettingsOnEdit(existing, formSettings);
    expect(merged.split_payment).toBe(true);
    expect(merged.lesson_types).toEqual(['private']);
    expect(merged.show_price_indication).toBe(true);
  });

  it('on create (no existing settings) returns the form settings unchanged', () => {
    expect(mergeCycleSettingsOnEdit(undefined, formSettings)).toEqual(formSettings);
    expect(mergeCycleSettingsOnEdit(null, formSettings)).toEqual(formSettings);
  });
});
