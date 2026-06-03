import { describe, it, expect } from 'vitest';
import enClub from '@/i18n/locales/en/club.json';
import nlClub from '@/i18n/locales/nl/club.json';
import enAcademy from '@/i18n/locales/en/academy.json';
import nlAcademy from '@/i18n/locales/nl/academy.json';

const PENDING_PHRASE = /pending verification|wacht op verificatie|being reviewed by our team/i;

describe('signup activation copy (Phase 1)', () => {
  it('club EN success copy is active, not pending verification', () => {
    expect(enClub.claim.successDescription).toMatch(/Your club is ready/i);
    expect(enClub.claim.successDescription).not.toMatch(PENDING_PHRASE);
    expect(enClub.dashboard.getStartedTitle).toBeTruthy();
    expect(enClub.dashboard.getStartedDescription).toBeTruthy();
  });

  it('club NL success copy is active, not pending verification', () => {
    expect(nlClub.claim.successDescription).toMatch(/club is klaar/i);
    expect(nlClub.claim.successDescription).not.toMatch(PENDING_PHRASE);
  });

  it('academy EN success copy is active, not pending verification', () => {
    expect(enAcademy.onboarding.successDescription).toMatch(/Your academy is ready/i);
    expect(enAcademy.onboarding.successDescription).not.toMatch(PENDING_PHRASE);
    expect(enAcademy.onboarding.verificationNote).not.toMatch(PENDING_PHRASE);
  });

  it('academy NL success copy is active, not pending verification', () => {
    expect(nlAcademy.onboarding.successDescription).toMatch(/academy is klaar/i);
    expect(nlAcademy.onboarding.successDescription).not.toMatch(PENDING_PHRASE);
  });
});
