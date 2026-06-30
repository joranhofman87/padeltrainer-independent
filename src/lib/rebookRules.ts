import { supabase } from '@/lib/supabaseClient';
import { normalizeRichTextHtml } from '@/lib/richText';

/**
 * Read/write the academy-level default "rebooking rules" (rich HTML) stored on
 * academy_profiles.rebook_rules. This is the text a player must consent to on the rebooking
 * claim/pay page — distinct from the free-text invitation message shown in the email.
 */

/** Tolerant read: returns null if the column isn't deployed yet (migration 20260704130000). */
export async function getAcademyRebookRulesDefault(academyId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('academy_profiles')
      .select('rebook_rules')
      .eq('id', academyId)
      .maybeSingle();
    if (error) throw error;
    return data?.rebook_rules ?? null;
  } catch {
    // Column not present yet (deploy order) — treat as "no default".
    return null;
  }
}

/** Persist the academy default rebooking rules; visually-blank HTML is stored as null. */
export async function saveAcademyRebookRulesDefault(academyId: string, html: string): Promise<void> {
  const { error } = await supabase
    .from('academy_profiles')
    .update({ rebook_rules: normalizeRichTextHtml(html) })
    .eq('id', academyId);
  if (error) throw error;
}
