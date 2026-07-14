import { describe, it, expect } from 'vitest';
import { resolveRegistrationTrainerDisplay, type RegTrainerOption } from '@/lib/registrationTrainerDisplay';

const T = (id: string): RegTrainerOption => ({ id, name: `Trainer ${id}` });
const loaded = [T('a'), T('b'), T('c')];

describe('resolveRegistrationTrainerDisplay', () => {
  it('no set + preference OFF → nothing shown (new default)', () => {
    const r = resolveRegistrationTrainerDisplay({ applicable_trainer_ids: [], show_preferred_trainer: false }, loaded);
    expect(r.trainersToShow).toEqual([]);
    expect(r.showProfileCards).toBe(false);
    expect(r.showPicker).toBe(false);
  });

  it('LEGACY: empty set + preference ON → all trainers as a picker, no cards (back-compat)', () => {
    const r = resolveRegistrationTrainerDisplay({ show_preferred_trainer: true }, loaded);
    expect(r.trainersToShow).toEqual(loaded);
    expect(r.showProfileCards).toBe(false); // no cards for the legacy path
    expect(r.showPicker).toBe(true);
  });

  it('set + preference OFF → the chosen trainers as info CARDS, no picker', () => {
    const r = resolveRegistrationTrainerDisplay({ applicable_trainer_ids: ['a', 'c'], show_preferred_trainer: false }, loaded);
    expect(r.trainersToShow.map((t) => t.id)).toEqual(['a', 'c']);
    expect(r.showProfileCards).toBe(true);
    expect(r.showPicker).toBe(false);
  });

  it('set + preference ON → chosen trainers as cards AND a picker', () => {
    const r = resolveRegistrationTrainerDisplay({ applicable_trainer_ids: ['b'], show_preferred_trainer: true }, loaded);
    expect(r.trainersToShow.map((t) => t.id)).toEqual(['b']);
    expect(r.showProfileCards).toBe(true);
    expect(r.showPicker).toBe(true);
  });

  it('set references trainers that are not loaded → nothing (filtered to empty)', () => {
    const r = resolveRegistrationTrainerDisplay({ applicable_trainer_ids: ['zzz'], show_preferred_trainer: true }, loaded);
    expect(r.trainersToShow).toEqual([]);
    expect(r.showProfileCards).toBe(false);
    expect(r.showPicker).toBe(false);
  });

  it('null / absent settings → nothing', () => {
    expect(resolveRegistrationTrainerDisplay(null, loaded)).toEqual({ trainersToShow: [], showProfileCards: false, showPicker: false });
    expect(resolveRegistrationTrainerDisplay(undefined, loaded).showProfileCards).toBe(false);
  });
});
