import { describe, it, expect } from 'vitest';
import { resolveRegistrationEditTarget } from './registrations';

/**
 * Batch 1 (architecture audit 2026-07-11, Theme 1): the cycle editor must save by OVERLAY EXISTENCE,
 * not the shell's type. A registration created via create_registration_with_cycle has a cycles shell
 * born type='cyclus' + a registrations overlay — the old `type==='cyclus' ? 'cycle' : 'registration'`
 * rule sent its edits to the cycle row, so price/close changes never reached the public form.
 */
describe('resolveRegistrationEditTarget', () => {
  it('SPLIT registration (shell type=cyclus + overlay) → writes the registration, not the cycle', () => {
    expect(resolveRegistrationEditTarget({ isEdit: true, cycleType: 'cyclus', overlayFormat: 'registration', requestedType: 'registration' }))
      .toEqual({ writeTarget: 'registration', formType: 'registration' });
  });

  it('SPLIT event (shell type=cyclus + overlay format=event) → formType=event (not mis-rendered as registration)', () => {
    // The old rule computed formType from the shell type ('cyclus' → 'registration'), losing the event UI.
    expect(resolveRegistrationEditTarget({ isEdit: true, cycleType: 'cyclus', overlayFormat: 'event', requestedType: 'registration' }))
      .toEqual({ writeTarget: 'registration', formType: 'event' });
  });

  it('LEGACY registration (type=registration, no overlay) → writes the registration', () => {
    expect(resolveRegistrationEditTarget({ isEdit: true, cycleType: 'registration', overlayFormat: null, requestedType: 'registration' }))
      .toEqual({ writeTarget: 'registration', formType: 'registration' });
  });

  it('LEGACY event (type=event, no overlay) → formType=event', () => {
    expect(resolveRegistrationEditTarget({ isEdit: true, cycleType: 'event', overlayFormat: null, requestedType: 'registration' }))
      .toEqual({ writeTarget: 'registration', formType: 'event' });
  });

  it('GENUINE training cyclus (type=cyclus, NO overlay) → still writes the cycle (unchanged)', () => {
    expect(resolveRegistrationEditTarget({ isEdit: true, cycleType: 'cyclus', overlayFormat: null, requestedType: 'registration' }))
      .toEqual({ writeTarget: 'cycle', formType: 'registration' });
  });

  it('CREATE (no cycle loaded) → registration write with the requested type', () => {
    expect(resolveRegistrationEditTarget({ isEdit: false, cycleType: undefined, overlayFormat: null, requestedType: 'event' }))
      .toEqual({ writeTarget: 'registration', formType: 'event' });
  });
});
