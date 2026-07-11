// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { textsToSettingsPatch, type RebookRoundTexts } from '@/lib/rebookRoundTexts';

const texts = (over: Partial<RebookRoundTexts> = {}): RebookRoundTexts => ({
  claimInfo: 'Zo werkt het.',
  invitationSubject: 'Blijf je erbij?',
  invitationMessage: 'Beste {first_name},',
  reminderSubject: 'Herinnering',
  reminderMessage: 'Nog niet bevestigd…',
  rebookRules: '<p>Regels</p>',
  ...over,
});

describe('textsToSettingsPatch', () => {
  it('maps every text onto its settings key', () => {
    expect(textsToSettingsPatch(texts())).toEqual({
      rebook_claim_info: 'Zo werkt het.',
      rebook_invitation_subject: 'Blijf je erbij?',
      rebook_invitation_message: 'Beste {first_name},',
      rebook_reminder_subject: 'Herinnering',
      rebook_reminder_message: 'Nog niet bevestigd…',
      rebook_rules: '<p>Regels</p>',
    });
  });

  it('clears emptied fields back to null (default text / no rules)', () => {
    const patch = textsToSettingsPatch(texts({ claimInfo: '  ', rebookRules: '', invitationSubject: '' }));
    expect(patch.rebook_claim_info).toBeNull();
    expect(patch.rebook_rules).toBeNull();
    expect(patch.rebook_invitation_subject).toBeNull();
    // The others are untouched.
    expect(patch.rebook_invitation_message).toBe('Beste {first_name},');
  });

  it('trims surrounding whitespace but keeps inner line breaks', () => {
    const patch = textsToSettingsPatch(texts({ claimInfo: '  Regel 1\nRegel 2  ' }));
    expect(patch.rebook_claim_info).toBe('Regel 1\nRegel 2');
  });
});
