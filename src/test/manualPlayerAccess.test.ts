import { describe, it, expect } from 'vitest';
import { evaluateManualPlayerAccess } from '../../supabase/functions/_shared/manual-player-access.ts';

describe('evaluateManualPlayerAccess', () => {
  it('allows a context-less player (no academy/trainer id) — the normal intake flow', () => {
    expect(
      evaluateManualPlayerAccess({
        managesAcademy: false,
        controlsTrainer: false,
      }),
    ).toEqual({ ok: true });
  });

  it('allows attaching to an academy the caller manages', () => {
    expect(
      evaluateManualPlayerAccess({
        academyProfileId: 'academy-1',
        managesAcademy: true,
        controlsTrainer: false,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects attaching to an academy the caller does not manage (injection)', () => {
    expect(
      evaluateManualPlayerAccess({
        academyProfileId: 'victim-academy',
        managesAcademy: false,
        controlsTrainer: false,
      }),
    ).toEqual({ ok: false, reason: 'academy_forbidden' });
  });

  it('allows attaching to a trainer the caller controls', () => {
    expect(
      evaluateManualPlayerAccess({
        trainerProfileId: 'trainer-1',
        managesAcademy: false,
        controlsTrainer: true,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects attaching to a trainer the caller does not control', () => {
    expect(
      evaluateManualPlayerAccess({
        trainerProfileId: 'other-trainer',
        managesAcademy: false,
        controlsTrainer: false,
      }),
    ).toEqual({ ok: false, reason: 'trainer_forbidden' });
  });

  it('checks academy before trainer when both are supplied', () => {
    expect(
      evaluateManualPlayerAccess({
        academyProfileId: 'victim-academy',
        trainerProfileId: 'trainer-1',
        managesAcademy: false,
        controlsTrainer: true,
      }),
    ).toEqual({ ok: false, reason: 'academy_forbidden' });
  });
});
