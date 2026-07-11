// Round-wide TEXT edits AFTER a rebook round was sent: the claim-page explanation, the
// invitation email (used by resume-sends), the automated-reminder email (read by the reminder
// cron from settings) and the rebooking rules (read live by the claim page's token RPC).
// A round is one cycle PER SERIES, so a "round" edit must write EVERY sibling cycle's settings
// — a partial write would show players different texts per group, so failures are reported
// per cycle and the caller re-offers a retry (writes are idempotent merges).
import { supabase } from '@/lib/supabaseClient';
import { updateCycleSettings } from '@/lib/cycleWrites';

export interface RebookRoundTexts {
  /** Claim-page explanation ('' = the standard "Hoe werkt het?" copy). */
  claimInfo: string;
  invitationSubject: string;
  invitationMessage: string;
  reminderSubject: string;
  reminderMessage: string;
  /** Hours before each player's deadline the automated reminder fires; null = default (24h). */
  reminderLeadHours: number | null;
  /** Rebooking rules (rich HTML, '' = no rules → no consent gate). */
  rebookRules: string;
}

export interface SaveRoundTextsResult {
  updated: number;
  failed: Array<{ cycleId: string; reason: string }>;
}

/** The settings keys a texts save writes — '' / null clears the key back to the default. */
export function textsToSettingsPatch(texts: RebookRoundTexts): Record<string, string | number | null> {
  const lead = texts.reminderLeadHours;
  return {
    rebook_claim_info: texts.claimInfo.trim() || null,
    rebook_invitation_subject: texts.invitationSubject.trim() || null,
    rebook_invitation_message: texts.invitationMessage.trim() || null,
    rebook_reminder_subject: texts.reminderSubject.trim() || null,
    rebook_reminder_message: texts.reminderMessage.trim() || null,
    rebook_reminder_lead_hours: lead != null && Number.isInteger(lead) && lead >= 1 && lead <= 336 ? lead : null,
    rebook_rules: texts.rebookRules.trim() || null,
  };
}

/**
 * Merge the text keys into EVERY cycle of the round (read → merge → write per cycle;
 * updateCycleSettings overwrites the settings object wholesale). Per-cycle failures are
 * collected, never thrown — the caller shows exactly which groups missed the update.
 */
export async function saveRebookRoundTexts(
  cycleIds: string[],
  texts: RebookRoundTexts,
): Promise<SaveRoundTextsResult> {
  const patch = textsToSettingsPatch(texts);
  const failed: Array<{ cycleId: string; reason: string }> = [];
  let updated = 0;
  for (const cycleId of cycleIds) {
    try {
      const { data, error } = await supabase.from('cycles').select('settings').eq('id', cycleId).maybeSingle();
      if (error) throw error;
      const current = (data?.settings ?? {}) as Record<string, unknown>;
      await updateCycleSettings(cycleId, { ...current, ...patch });
      updated += 1;
    } catch (e) {
      failed.push({ cycleId, reason: (e as { message?: string })?.message || String(e) });
    }
  }
  return { updated, failed };
}
