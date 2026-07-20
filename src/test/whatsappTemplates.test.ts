// @vitest-environment node
// PR 9: the committed WhatsApp Content Template definitions. These are reviewed BEFORE
// anything is created in Twilio or submitted to Meta, so the checks that would otherwise be
// a rejected review (or a mis-filled message) live here instead.
import { describe, it, expect } from 'vitest';
import {
  WHATSAPP_TEMPLATES,
  SESSION_REMINDER_NL,
  templateForEvent,
  buildContentVariables,
  validateTemplateBody,
} from '../../supabase/functions/_shared/whatsapp-templates.ts';

describe('WhatsApp template definitions', () => {
  it('every committed body satisfies Metas structural rules', () => {
    for (const t of WHATSAPP_TEMPLATES) {
      const { valid, problems } = validateTemplateBody(t.body);
      expect(problems).toEqual([]);
      expect(valid).toBe(true);
    }
  });

  it('every template declares one sample per variable (Meta requires samples at review)', () => {
    for (const t of WHATSAPP_TEMPLATES) {
      const placeholders = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].length;
      expect(t.variables).toHaveLength(placeholders);
      expect(t.samples).toHaveLength(placeholders);
    }
  });

  it('reminders are UTILITY — never MARKETING (approval odds and per-message price)', () => {
    expect(SESSION_REMINDER_NL.category).toBe('UTILITY');
  });

  it('buildContentVariables maps NAMES to POSITIONS in the declared order', () => {
    const vars = buildContentVariables(SESSION_REMINDER_NL, {
      first_name: 'Tom', date: 'maandag 3 maart', time: '10:00', location: 'Hal 1',
    });
    // this ordering IS the contract — Twilio fills {{n}} by index, so a reorder would put
    // the time where the name belongs without erroring
    expect(vars).toEqual({ '1': 'Tom', '2': 'maandag 3 maart', '3': '10:00', '4': 'Hal 1' });
  });

  it('a missing value becomes empty rather than the string "undefined"', () => {
    const vars = buildContentVariables(SESSION_REMINDER_NL, { first_name: 'Tom' });
    expect(vars['2']).toBe('');
    expect(JSON.stringify(vars)).not.toContain('undefined');
  });

  it('resolves a template by event + language, and returns null when there is none', () => {
    expect(templateForEvent('session_reminder_player', 'nl')).toBe(SESSION_REMINDER_NL);
    expect(templateForEvent('session_reminder_player', 'en')).toBeNull(); // not committed yet
    expect(templateForEvent('booking_confirmed_player', 'nl')).toBeNull();
  });

  it('validateTemplateBody catches the actual rejection causes', () => {
    expect(validateTemplateBody('{{1}} hallo').problems).toContain('body must not start with a variable');
    expect(validateTemplateBody('hallo {{1}}').problems).toContain('body must not end with a variable');
    expect(validateTemplateBody('a {{1}} {{2}} b').problems).toContain('variables must not be adjacent');
    expect(validateTemplateBody('a {{2}} b {{1}} c').problems).toContain('variables must be sequential from {{1}}');
  });
});
